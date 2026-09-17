import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

/* ------------------------------------------------------------------ types */

type PresetId = 'screen' | 'ebook' | 'printer' | 'prepress' | 'default';

type Stage = 'idle' | 'uploading' | 'compressing';

interface PresetOption {
  id: PresetId;
  label: string;
  dpi: string;
  hint: string;
}

interface GhostscriptStatus {
  available: boolean;
  version: string | null;
  bin: string;
  error: string | null;
}

interface Health {
  ok: boolean;
  ghostscript: GhostscriptStatus;
  limits: { maxUploadBytes: number; fileTtlMs: number };
}

interface CompressResult {
  id: string;
  originalName: string;
  outputName: string;
  preset: PresetId;
  compatibilityLevel: string;
  grayscale: boolean;
  originalSize: number;
  compressedSize: number;
  savingsPercent: number;
  durationMs: number;
  command: string;
  downloadUrl: string;
  expiresAt: number;
}

interface ApiError {
  error?: string;
  hint?: string;
  stderr?: string;
}

/* -------------------------------------------------------------- constants */

const PRESETS: PresetOption[] = [
  { id: 'screen', label: 'Screen', dpi: '72 dpi', hint: 'Smallest files — fine for on-screen reading and email.' },
  { id: 'ebook', label: 'eBook', dpi: '150 dpi', hint: 'Recommended default: solid quality with big savings.' },
  { id: 'printer', label: 'Printer', dpi: '300 dpi', hint: 'Keeps detail for desktop printing.' },
  { id: 'prepress', label: 'Prepress', dpi: '300 dpi colour', hint: 'Near-original fidelity for print production.' },
  { id: 'default', label: 'Default', dpi: 'mixed', hint: 'Ghostscript defaults — a gentle optimisation.' },
];

const COMPATIBILITY_LEVELS = ['1.3', '1.4', '1.5', '1.6', '1.7'];

const MB = 1024 * 1024;

/* ---------------------------------------------------------------- helpers */

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(value >= 10 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

function stripPdfExtension(fileName: string): string {
  return fileName.replace(/\.pdf$/i, '') || 'document';
}

function isPdfFile(candidate: File): boolean {
  return candidate.type === 'application/pdf' || /\.pdf$/i.test(candidate.name);
}

/* ------------------------------------------------------------- component */

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preset, setPreset] = useState<PresetId>('ebook');
  const [compatibilityLevel, setCompatibilityLevel] = useState('1.4');
  const [grayscale, setGrayscale] = useState(false);
  const [outputName, setOutputName] = useState('');
  const [stage, setStage] = useState<Stage>('idle');
  const [uploadPercent, setUploadPercent] = useState(0);
  const [error, setError] = useState<ApiError | null>(null);
  const [result, setResult] = useState<CompressResult | null>(null);
  const [history, setHistory] = useState<CompressResult[]>([]);
  const [isDragging, setIsDragging] = useState(false);

  const inputRef = useRef<HTMLInputElement>(null);
  const requestRef = useRef<XMLHttpRequest | null>(null);
  const dragDepth = useRef(0);

  const busy = stage !== 'idle';
  const gsReady = health?.ghostscript.available ?? false;
  const maxUploadBytes = health?.limits.maxUploadBytes ?? 200 * MB;

  const loadHealth = useCallback(async () => {
    try {
      const response = await fetch('/api/health');
      if (!response.ok) throw new Error(`Health check failed (${response.status})`);
      const payload = (await response.json()) as Health;
      setHealth(payload);
      setHealthError(null);
    } catch (cause) {
      setHealth(null);
      setHealthError(
        cause instanceof Error
          ? `${cause.message}. Start the API with "npm run dev" inside server/.`
          : 'The compression API is unreachable.',
      );
    }
  }, []);

  useEffect(() => {
    void loadHealth();
  }, [loadHealth]);

  /* -------------------------------------------------------- file picking */

  const selectFile = useCallback(
    (candidate: File | null | undefined) => {
      if (!candidate) return;
      if (!isPdfFile(candidate)) {
        setError({ error: `"${candidate.name}" is not a PDF. Pick a .pdf file.` });
        return;
      }
      if (candidate.size > maxUploadBytes) {
        setError({
          error: `"${candidate.name}" is ${formatBytes(candidate.size)} — the limit is ${formatBytes(maxUploadBytes)}.`,
        });
        return;
      }
      setFile(candidate);
      setOutputName(`${stripPdfExtension(candidate.name)}-compressed`);
      setResult(null);
      setError(null);
      setUploadPercent(0);
      setStage('idle');
    },
    [maxUploadBytes],
  );

  const onDrop = useCallback(
    (event: React.DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      dragDepth.current = 0;
      setIsDragging(false);
      selectFile(event.dataTransfer.files?.[0]);
    },
    [selectFile],
  );

  const onDragOver = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }, []);

  const onDragEnter = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragDepth.current += 1;
    setIsDragging(true);
  }, []);

  const onDragLeave = useCallback((event: React.DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setIsDragging(false);
  }, []);

  /* -------------------------------------------------------- compression */

  const compress = useCallback(() => {
    if (!file || busy) return;

    setStage('uploading');
    setUploadPercent(0);
    setError(null);
    setResult(null);

    const form = new FormData();
    form.append('file', file);
    form.append('preset', preset);
    form.append('compatibilityLevel', compatibilityLevel);
    form.append('grayscale', grayscale ? 'true' : 'false');
    if (outputName.trim()) form.append('outputName', outputName.trim());

    const request = new XMLHttpRequest();
    requestRef.current = request;
    request.open('POST', '/api/compress');
    request.responseType = 'text';

    request.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      const percent = Math.round((event.loaded / event.total) * 100);
      setUploadPercent(percent);
      if (percent >= 100) setStage('compressing');
    };
    request.upload.onload = () => setStage('compressing');

    request.onload = () => {
      let payload: unknown = null;
      try {
        payload = JSON.parse(request.responseText || '{}');
      } catch {
        payload = null;
      }

      if (request.status >= 200 && request.status < 300 && payload) {
        const compressed = payload as CompressResult;
        setResult(compressed);
        setHistory((previous) => [compressed, ...previous].slice(0, 8));
      } else {
        const failure = (payload ?? {}) as ApiError;
        setError({
          error: failure.error ?? `Compression failed (HTTP ${request.status}).`,
          hint: failure.hint,
          stderr: failure.stderr,
        });
      }

      requestRef.current = null;
      setStage('idle');
      setUploadPercent(0);
    };

    request.onerror = () => {
      requestRef.current = null;
      setStage('idle');
      setUploadPercent(0);
      setError({ error: 'Could not reach the compression API. Is the server running on port 3001?' });
    };

    request.send(form);
  }, [busy, compatibilityLevel, file, grayscale, outputName, preset]);

  const cancel = useCallback(() => {
    requestRef.current?.abort();
    requestRef.current = null;
    setStage('idle');
    setUploadPercent(0);
    setError({ error: 'Compression cancelled.' });
  }, []);

  const reset = useCallback(() => {
    setFile(null);
    setOutputName('');
    setResult(null);
    setError(null);
    setStage('idle');
    setUploadPercent(0);
    if (inputRef.current) inputRef.current.value = '';
  }, []);

  const discard = useCallback(async (id: string) => {
    try {
      await fetch(`/api/jobs/${id}`, { method: 'DELETE' });
    } catch {
      /* the file may already be gone */
    }
    setHistory((previous) => previous.filter((entry) => entry.id !== id));
    setResult((current) => (current?.id === id ? null : current));
  }, []);

  /* ------------------------------------------------------------ derived */

  const previewCommand = useMemo(() => {
    const parts = [
      'gs',
      '-sDEVICE=pdfwrite',
      `-dCompatibilityLevel=${compatibilityLevel}`,
      `-dPDFSETTINGS=/${preset}`,
      '-dNOPAUSE',
      '-dQUIET',
      '-dBATCH',
    ];
    if (grayscale) parts.push('-sColorConversionStrategy=Gray', '-dProcessColorModel=/DeviceGray');
    parts.push(`-sOutputFile="${outputName.trim() || 'compressed.pdf'}"`, `"${file?.name ?? 'input.pdf'}"`);
    return parts.join(' \\\n  ');
  }, [compatibilityLevel, file, grayscale, outputName, preset]);

  const activePreset = PRESETS.find((option) => option.id === preset) ?? PRESETS[1];
  const canCompress = Boolean(file) && !busy && gsReady;

  /* --------------------------------------------------------------- view */

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">gs</span>
          <div>
            <h1>PDF Compressor</h1>
            <p>Ghostscript runs locally through the API — your files never leave this machine.</p>
          </div>
        </div>
        <div className={`status ${gsReady ? 'status--ok' : 'status--bad'}`}>
          <span className="dot" aria-hidden="true" />
          {health ? (gsReady ? `Ghostscript ${health.ghostscript.version}` : 'Ghostscript not found') : healthError ? 'API offline' : 'Checking…'}
        </div>
      </header>

      {healthError && (
        <div className="banner banner--warn">
          <strong>API unreachable.</strong> {healthError}
        </div>
      )}

      {health && !gsReady && (
        <div className="banner banner--warn">
          <strong>Ghostscript is missing.</strong> Install it with{' '}
          <code>brew install ghostscript</code>, or start the server with{' '}
          <code>GS_BIN=/full/path/to/gs npm run dev</code>.
          {health.ghostscript.error ? <span className="banner-note">{health.ghostscript.error}</span> : null}
        </div>
      )}

      {error && (
        <div className="banner banner--error">
          <strong>{error.error}</strong>
          {error.hint ? <span className="banner-note">{error.hint}</span> : null}
          {error.stderr ? <pre className="banner-stderr">{error.stderr}</pre> : null}
        </div>
      )}

      <main className="layout">
        <div className="column">
          <section className="card">
            <h2>1 · Choose a PDF</h2>

            <div
              className={`dropzone ${isDragging ? 'dropzone--active' : ''} ${file ? 'dropzone--filled' : ''}`}
              onDrop={onDrop}
              onDragOver={onDragOver}
              onDragEnter={onDragEnter}
              onDragLeave={onDragLeave}
              onClick={() => inputRef.current?.click()}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault();
                  inputRef.current?.click();
                }
              }}
              role="button"
              tabIndex={0}
            >
              <input
                ref={inputRef}
                type="file"
                accept="application/pdf,.pdf"
                hidden
                onChange={(event) => selectFile(event.target.files?.[0])}
              />
              {file ? (
                <>
                  <span className="dropzone-icon">📄</span>
                  <span className="dropzone-title">{file.name}</span>
                  <span className="dropzone-sub">
                    {formatBytes(file.size)} · click to replace
                  </span>
                </>
              ) : (
                <>
                  <span className="dropzone-icon">⬆️</span>
                  <span className="dropzone-title">Drop a PDF here</span>
                  <span className="dropzone-sub">
                    or click to browse · up to {formatBytes(maxUploadBytes)}
                  </span>
                </>
              )}
            </div>

            <label className="field">
              <span>Output file name</span>
              <input
                type="text"
                value={outputName}
                placeholder="compressed.pdf"
                onChange={(event) => setOutputName(event.target.value)}
              />
            </label>

            <div className="actions">
              <button type="button" className="btn btn--primary" disabled={!canCompress} onClick={compress}>
                {busy ? (stage === 'uploading' ? 'Uploading…' : 'Compressing…') : 'Compress PDF'}
              </button>
              {busy && (
                <button type="button" className="btn" onClick={cancel}>
                  Cancel
                </button>
              )}
              <button type="button" className="btn btn--ghost" onClick={reset} disabled={busy}>
                Clear
              </button>
            </div>

            {busy && (
              <div className="progress" role="status" aria-live="polite">
                <div className="progress-track">
                  <div
                    className={`progress-bar ${stage === 'compressing' ? 'progress-bar--indeterminate' : ''}`}
                    style={stage === 'uploading' ? { width: `${uploadPercent}%` } : undefined}
                  />
                </div>
                <span className="progress-label">
                  {stage === 'uploading' ? `Uploading ${uploadPercent}%` : 'Ghostscript is rewriting the PDF…'}
                </span>
              </div>
            )}
          </section>

          <section className="card">
            <h2>2 · Quality preset</h2>
            <div className="preset-grid">
              {PRESETS.map((option) => (
                <button
                  type="button"
                  key={option.id}
                  className={`preset ${preset === option.id ? 'preset--selected' : ''}`}
                  onClick={() => setPreset(option.id)}
                  aria-pressed={preset === option.id}
                >
                  <span className="preset-head">
                    <strong>{option.label}</strong>
                    <em>-dPDFSETTINGS=/{option.id}</em>
                  </span>
                  <span className="preset-dpi">{option.dpi}</span>
                  <span className="preset-hint">{option.hint}</span>
                </button>
              ))}
            </div>

            <details className="advanced">
              <summary>Advanced options</summary>
              <div className="advanced-body">
                <label className="field">
                  <span>PDF compatibility level</span>
                  <select
                    value={compatibilityLevel}
                    onChange={(event) => setCompatibilityLevel(event.target.value)}
                  >
                    {COMPATIBILITY_LEVELS.map((level) => (
                      <option key={level} value={level}>
                        {level}
                      </option>
                    ))}
                  </select>
                </label>

                <label className="check">
                  <input
                    type="checkbox"
                    checked={grayscale}
                    onChange={(event) => setGrayscale(event.target.checked)}
                  />
                  <span>
                    Convert to grayscale
                    <em> -sColorConversionStrategy=Gray</em>
                  </span>
                </label>
              </div>
            </details>
          </section>

          <section className="card">
            <h2>Command that will run</h2>
            <pre className="command">{`$ ${previewCommand}`}</pre>
            <p className="muted">
              Active profile: <strong>{activePreset.label}</strong> ({activePreset.dpi}) · arguments are passed as an
              argv array, so file names with spaces or quotes are safe.
            </p>
          </section>
        </div>

        <div className="column">
          <section className="card">
            <h2>Result</h2>
            {result ? (
              <>
                <div className="stats">
                  <div className="stat">
                    <span className="stat-label">Before</span>
                    <span className="stat-value">{formatBytes(result.originalSize)}</span>
                  </div>
                  <div className="stat">
                    <span className="stat-label">After</span>
                    <span className="stat-value stat-value--good">{formatBytes(result.compressedSize)}</span>
                  </div>
                  <div className="stat">
                    <span className="stat-label">Saved</span>
                    <span
                      className={`stat-value ${result.savingsPercent > 0 ? 'stat-value--good' : 'stat-value--warn'}`}
                    >
                      {result.savingsPercent > 0 ? `${result.savingsPercent}%` : '0%'}
                    </span>
                  </div>
                  <div className="stat">
                    <span className="stat-label">Took</span>
                    <span className="stat-value">{(result.durationMs / 1000).toFixed(1)}s</span>
                  </div>
                </div>

                <div className="compare">
                  <div className="compare-row">
                    <span className="compare-label">original</span>
                    <div className="compare-track">
                      <div className="compare-bar" style={{ width: '100%' }} />
                    </div>
                  </div>
                  <div className="compare-row">
                    <span className="compare-label">compressed</span>
                    <div className="compare-track">
                      <div
                        className="compare-bar compare-bar--good"
                        style={{
                          width: `${Math.max(
                            2,
                            Math.min(100, (result.compressedSize / Math.max(1, result.originalSize)) * 100),
                          )}%`,
                        }}
                      />
                    </div>
                  </div>
                </div>

                <p className="muted">
                  {result.savingsPercent > 0
                    ? `Removed ${formatBytes(result.originalSize - result.compressedSize)}.`
                    : 'This PDF was already optimised — try the Screen preset or grayscale to shrink it further.'}
                </p>

                <div className="actions">
                  <a className="btn btn--primary" href={result.downloadUrl} download={result.outputName}>
                    Download {result.outputName}
                  </a>
                  <button type="button" className="btn btn--ghost" onClick={() => void discard(result.id)}>
                    Delete from server
                  </button>
                </div>

                <details className="advanced">
                  <summary>Command that produced this file</summary>
                  <pre className="command">{`$ ${result.command}`}</pre>
                </details>
              </>
            ) : (
              <p className="muted">Compress a PDF to see the size comparison and download link here.</p>
            )}
          </section>

          {history.length > 0 && (
            <section className="card">
              <h2>Session history</h2>
              <ul className="history">
                {history.map((entry) => (
                  <li key={entry.id}>
                    <div className="history-main">
                      <span className="history-name">{entry.outputName}</span>
                      <span className="history-meta">
                        {entry.preset} · {formatBytes(entry.originalSize)} → {formatBytes(entry.compressedSize)} (
                        {entry.savingsPercent > 0 ? `-${entry.savingsPercent}%` : '+0%'})
                      </span>
                    </div>
                    <div className="history-actions">
                      <a href={entry.downloadUrl} download={entry.outputName} className="link">
                        download
                      </a>
                      <button type="button" className="link link--danger" onClick={() => void discard(entry.id)}>
                        remove
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </main>

      <footer className="footer">
        Files live in <code>server/uploads</code> and <code>server/output</code> and are deleted automatically after{' '}
        {Math.round((health?.limits.fileTtlMs ?? 3_600_000) / 60_000)} minutes.
      </footer>
    </div>
  );
}
