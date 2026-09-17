/**
 * pdf-compressor server
 * ---------------------
 * Tiny local API that runs Ghostscript against an uploaded PDF.
 *
 *   gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=/ebook \
 *      -dNOPAUSE -dQUIET -dBATCH -sOutputFile=compressed.pdf input.pdf
 *
 * Endpoints
 *   GET    /api/health          -> server + local Ghostscript status
 *   GET    /api/presets         -> available -dPDFSETTINGS presets
 *   POST   /api/compress        -> multipart upload {"file", preset, compatibilityLevel, grayscale, outputName}
 *   GET    /api/download/:id    -> download a compressed result
 *   DELETE /api/jobs/:id        -> delete one job's files
 *   POST   /api/cleanup         -> delete all stored files right now
 *
 * Everything stays on the machine: uploads/ is the inbox, output/ is the outbox.
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import cors from 'cors';
import express from 'express';
import multer from 'multer';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- config ----

const PORT = Number(process.env.PORT ?? 3001);
const HOST = process.env.HOST ?? '127.0.0.1';

/** Path to the Ghostscript binary. Override with GS_BIN if it is not on PATH. */
const GS_BIN = process.env.GS_BIN ?? 'gs';

/** Kill a Ghostscript run after this many ms (default: 5 minutes). */
const GS_TIMEOUT_MS = Number(process.env.GS_TIMEOUT_MS ?? 5 * 60 * 1000);

/** Uploaded + generated files are swept after this long (default: 1 hour). */
const FILE_TTL_MS = Number(process.env.FILE_TTL_MS ?? 60 * 60 * 1000);

/** Hard upload cap. */
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES ?? 200 * 1024 * 1024);

const UPLOAD_DIR = path.join(__dirname, 'uploads');
const OUTPUT_DIR = path.join(__dirname, 'output');
const CLIENT_DIST = path.join(__dirname, '..', 'client', 'dist');

/**
 * Ghostscript's built-in -dPDFSETTINGS profiles.
 * These are the exact knobs the CLI flags map to.
 */
const PRESETS = {
  screen: { label: 'Screen', dpi: '72 dpi', hint: 'Smallest files, good enough for screens / email previews.' },
  ebook: { label: 'eBook', dpi: '150 dpi', hint: 'Balanced quality and size. Best default for documents.' },
  printer: { label: 'Printer', dpi: '300 dpi', hint: 'High quality for desktop printing.' },
  prepress: { label: 'Prepress', dpi: '300 dpi color', hint: 'Near-original quality for commercial printing.' },
  default: { label: 'Default', dpi: 'mixed', hint: 'Ghostscript defaults: mild, safe optimisation.' },
};

const COMPATIBILITY_LEVELS = ['1.3', '1.4', '1.5', '1.6', '1.7'];

const DEFAULT_PRESET = 'ebook';
const DEFAULT_COMPATIBILITY = '1.4';

/** In-memory registry of finished jobs (also used by the download endpoint). */
const jobs = new Map();

await fs.mkdir(UPLOAD_DIR, { recursive: true });
await fs.mkdir(OUTPUT_DIR, { recursive: true });

// ------------------------------------------------------------- gs helpers ----

/** Detect the local Ghostscript install once, lazily. */
let gsProbe = null;
async function probeGhostscript() {
  if (gsProbe) return gsProbe;
  gsProbe = await new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };

    let child;
    try {
      child = spawn(GS_BIN, ['--version']);
    } catch (error) {
      return done({ available: false, version: null, bin: GS_BIN, error: error.message });
    }

    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', (error) =>
      done({ available: false, version: null, bin: GS_BIN, error: error.message }),
    );
    child.on('close', (code) => {
      const version = stdout.trim();
      done(
        code === 0 && version
          ? { available: true, version, bin: GS_BIN, error: null }
          : {
              available: false,
              version: null,
              bin: GS_BIN,
              error: stderr.trim() || `gs exited with code ${code}`,
            },
      );
    });
  });
  return gsProbe;
}

/** Build the argv array for one Ghostscript run. */
function buildGsArgs({ inputPath, outputPath, preset, compatibilityLevel, grayscale }) {
  const args = [
    '-sDEVICE=pdfwrite',
    `-dCompatibilityLevel=${compatibilityLevel}`,
    `-dPDFSETTINGS=/${preset}`,
    '-dNOPAUSE',
    '-dQUIET',
    '-dBATCH',
    '-dDetectDuplicateImages=true',
  ];

  if (grayscale) {
    args.push('-sColorConversionStrategy=Gray', '-dProcessColorModel=/DeviceGray');
  }

  args.push(`-sOutputFile=${outputPath}`, inputPath);
  return args;
}

/**
 * Run Ghostscript for one job. Resolves with { args, stderr, durationMs }.
 * Rejects with an Error carrying the captured stderr for the UI.
 */
function runGhostscript({ inputPath, outputPath, preset, compatibilityLevel, grayscale }) {
  const args = buildGsArgs({ inputPath, outputPath, preset, compatibilityLevel, grayscale });
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const child = spawn(GS_BIN, args, { windowsHide: true });
    let stderr = '';
    let stdout = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, GS_TIMEOUT_MS);

    child.stdout.on('data', (chunk) => {
      if (stdout.length < 20_000) stdout += chunk;
    });
    child.stderr.on('data', (chunk) => (stderr += chunk));

    child.on('error', (error) => {
      clearTimeout(timer);
      const failure = new Error(`Could not run "${GS_BIN}": ${error.message}`);
      failure.stderr = error.message;
      failure.hint =
        'Install Ghostscript (macOS: brew install ghostscript) or set GS_BIN to its full path.';
      reject(failure);
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const durationMs = Date.now() - startedAt;

      if (timedOut) {
        const failure = new Error(`Ghostscript timed out after ${Math.round(GS_TIMEOUT_MS / 1000)}s`);
        failure.stderr = stderr.trim();
        return reject(failure);
      }
      if (code !== 0) {
        const failure = new Error(`Ghostscript exited with code ${code}`);
        failure.stderr = (stderr.trim() || stdout.trim()).slice(-4000);
        failure.args = args;
        return reject(failure);
      }
      resolve({ args, stderr: stderr.trim(), durationMs });
    });
  });
}

async function fileSize(target) {
  const stats = await fs.stat(target);
  return stats.size;
}

async function removeQuietly(target) {
  try {
    await fs.rm(target, { force: true });
  } catch {
    /* best effort */
  }
}

/** Delete files older than FILE_TTL_MS from uploads/ and output/. */
async function sweepOldFiles() {
  const cutoff = Date.now() - FILE_TTL_MS;
  for (const dir of [UPLOAD_DIR, OUTPUT_DIR]) {
    let entries = [];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }
    await Promise.all(
      entries
        .filter((name) => !name.startsWith('.'))
        .map(async (name) => {
          const full = path.join(dir, name);
          try {
            const stats = await fs.stat(full);
            if (stats.mtimeMs < cutoff) await fs.rm(full, { force: true });
          } catch {
            /* already gone */
          }
        }),
    );
  }

  for (const [id, job] of jobs) {
    if (job.expiresAt < Date.now()) jobs.delete(id);
  }
}

// ------------------------------------------------------------------ app ----

const app = express();
app.use(cors());
app.use(express.json());

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const safeBase = path
      .basename(file.originalname)
      .replace(/[^a-zA-Z0-9._-]+/g, '_')
      .slice(-80);
    cb(null, `${Date.now()}-${randomUUID().slice(0, 8)}-${safeBase || 'input.pdf'}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    const isPdf =
      file.mimetype === 'application/pdf' ||
      file.mimetype === 'application/x-pdf' ||
      /\.pdf$/i.test(file.originalname);
    if (!isPdf) {
      const error = new Error('Only PDF files are supported.');
      error.status = 400;
      return cb(error);
    }
    cb(null, true);
  },
});

function sanitizeOutputName(rawName, fallbackBase) {
  const base = (rawName ?? '').trim() || `${fallbackBase}-compressed`;
  const withoutDir = path.basename(base).replace(/[\\/]+/g, '_');
  const withoutExt = withoutDir.replace(/\.pdf$/i, '') || `${fallbackBase}-compressed`;
  const safe = withoutExt.replace(/[^a-zA-Z0-9._ -]+/g, '_').trim() || `${fallbackBase}-compressed`;
  return `${safe}.pdf`;
}

app.get('/api/health', async (_req, res) => {
  const ghostscript = await probeGhostscript();
  res.json({
    ok: true,
    ghostscript,
    presets: Object.keys(PRESETS),
    compatibilityLevels: COMPATIBILITY_LEVELS,
    limits: { maxUploadBytes: MAX_UPLOAD_BYTES, fileTtlMs: FILE_TTL_MS },
  });
});

app.get('/api/presets', (_req, res) => {
  res.json({
    presets: Object.entries(PRESETS).map(([id, info]) => ({ id, ...info })),
    compatibilityLevels: COMPATIBILITY_LEVELS,
    defaultPreset: DEFAULT_PRESET,
    defaultCompatibility: DEFAULT_COMPATIBILITY,
  });
});

app.post('/api/compress', upload.single('file'), async (req, res, next) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No PDF was uploaded. Send it as the "file" field.' });
  }

  const inputPath = req.file.path;
  const originalName = path.basename(req.file.originalname || 'input.pdf');
  const preset = String(req.body.preset ?? DEFAULT_PRESET).toLowerCase();
  const compatibilityLevel = String(req.body.compatibilityLevel ?? DEFAULT_COMPATIBILITY);
  const grayscale = ['true', '1', 'on', 'yes'].includes(String(req.body.grayscale).toLowerCase());
  const fallbackBase = originalName.replace(/\.pdf$/i, '') || 'document';
  const outputName = sanitizeOutputName(req.body.outputName, fallbackBase);

  try {
    if (!Object.hasOwn(PRESETS, preset)) {
      await removeQuietly(inputPath);
      return res.status(400).json({
        error: `Unknown preset "${preset}".`,
        allowed: Object.keys(PRESETS),
      });
    }
    if (!COMPATIBILITY_LEVELS.includes(compatibilityLevel)) {
      await removeQuietly(inputPath);
      return res.status(400).json({
        error: `Unsupported compatibility level "${compatibilityLevel}".`,
        allowed: COMPATIBILITY_LEVELS,
      });
    }

    // Measure the original ourselves for a reliable before/after comparison.
    const originalSize = await fileSize(inputPath);

    const id = randomUUID();
    const outputFileName = `${id}__${outputName}`;
    const outputPath = path.join(OUTPUT_DIR, outputFileName);

    const { args, durationMs } = await runGhostscript({
      inputPath,
      outputPath,
      preset,
      compatibilityLevel,
      grayscale,
    });

    const compressedSize = await fileSize(outputPath);
    const savingsPercent =
      originalSize > 0
        ? Number((((originalSize - compressedSize) / originalSize) * 100).toFixed(2))
        : 0;

    const job = {
      id,
      originalName,
      outputName,
      outputPath,
      inputPath,
      preset,
      compatibilityLevel,
      grayscale,
      originalSize,
      compressedSize,
      savingsPercent,
      durationMs,
      command: [GS_BIN, ...args],
      expiresAt: Date.now() + FILE_TTL_MS,
    };
    jobs.set(id, job);

    // The uploaded original is no longer needed once gs has written its output.
    await removeQuietly(inputPath);

    res.json({
      id,
      originalName,
      outputName,
      preset,
      compatibilityLevel,
      grayscale,
      originalSize,
      compressedSize,
      savingsPercent,
      durationMs,
      command: job.command.join(' '),
      downloadUrl: `/api/download/${id}`,
      expiresAt: job.expiresAt,
    });
  } catch (error) {
    await removeQuietly(inputPath);
    next(error);
  }
});

app.get('/api/download/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    return res.status(404).json({ error: 'That compressed file has expired or was removed.' });
  }
  res.download(job.outputPath, job.outputName, (error) => {
    if (error && !res.headersSent) res.status(500).json({ error: error.message });
  });
});

app.delete('/api/jobs/:id', async (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Unknown job.' });
  await removeQuietly(job.outputPath);
  await removeQuietly(job.inputPath);
  jobs.delete(job.id);
  res.json({ ok: true, removed: job.id });
});

app.post('/api/cleanup', async (_req, res) => {
  const ids = [...jobs.keys()];
  for (const id of ids) {
    const job = jobs.get(id);
    await removeQuietly(job.outputPath);
    await removeQuietly(job.inputPath);
    jobs.delete(id);
  }
  await sweepOldFiles();
  res.json({ ok: true, removed: ids.length });
});

// Serve the built client (`npm run build` in client/) so one process can host both.
app.use(express.static(CLIENT_DIST, { index: 'index.html', fallthrough: true }));
app.get(/^(?!\/api\/).*/, (_req, res) => res.sendFile(path.join(CLIENT_DIST, 'index.html')));

// --------------------------------------------------------------- errors ----

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) {
    const message =
      error.code === 'LIMIT_FILE_SIZE'
        ? `File is larger than the ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB limit.`
        : error.message;
    return res.status(400).json({ error: message });
  }
  const status = error.status ?? 500;
  if (status >= 500) console.error('[pdf-compressor]', error);
  res.status(status).json({
    error: error.message ?? 'Compression failed.',
    hint: error.hint ?? undefined,
    stderr: error.stderr || undefined,
  });
});

// -------------------------------------------------------------- startup ----

await sweepOldFiles();
const sweeper = setInterval(() => {
  sweepOldFiles().catch(() => {});
}, 15 * 60 * 1000);
sweeper.unref();

app.listen(PORT, HOST, async () => {
  const gs = await probeGhostscript();
  console.log(`[pdf-compressor] API listening on http://${HOST}:${PORT}`);
  if (gs.available) {
    console.log(`[pdf-compressor] Ghostscript ${gs.version} (${gs.bin})`);
  } else {
    console.warn(
      `[pdf-compressor] Ghostscript was not found (${gs.bin}). ` +
        'Install it with "brew install ghostscript" or set GS_BIN.',
    );
  }
});

export { app, buildGsArgs, PRESETS, COMPATIBILITY_LEVELS };
