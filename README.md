# PDF Compressor (Ghostscript + React)

A tiny local app that puts a UI on top of the Ghostscript command line:

```bash
gs -sDEVICE=pdfwrite -dCompatibilityLevel=1.4 -dPDFSETTINGS=/ebook \
   -dNOPAUSE -dQUIET -dBATCH -sOutputFile=compressed.pdf input.pdf
```

Everything runs on your machine — the React UI talks to a local Express API,
and the API shells out to the `gs` binary.

```
pdf-compressor/
├── client/                 # Vite + React (TypeScript) UI
│   ├── src/App.tsx         # the whole UI
│   ├── src/App.css
│   └── package.json
└── server/                 # Express API that runs Ghostscript
    ├── index.js
    ├── uploads/            # temp inbox for uploaded PDFs
    ├── output/             # compressed results
    └── package.json
```

## Demo

<img src="https://i.ibb.co/fYXV172f/Screenshot-2026-09-17-at-9-24-39-AM.png"
     alt="PDF Compressor UI: a PDF is dropped in, the selected quality preset is highlighted in the preset grid, and the exact gs command is previewed before compressing"
     width="1000">

Drag a PDF in, pick a preset (the selected one is highlighted with a ✓), see the exact
`gs` command that will run, then compress and download the result with the before/after
sizes and savings.

## Requirements

- Node.js 18+ (tested on v22)
- Ghostscript on `PATH`: `brew install ghostscript` (macOS), `apt install ghostscript` (Debian/Ubuntu), `choco install ghostscript` (Windows)

Check it: `gs --version`

## Install & run

```bash
cd pdf-compressor
npm run setup      # installs root, server and client dependencies
npm run dev        # API on :3001 + UI on :5173
```

Then open <http://localhost:5173>.

Prefer separate terminals?

```bash
npm --prefix server run dev   # http://127.0.0.1:3001
npm --prefix client run dev   # http://localhost:5173 (proxies /api -> :3001)
```

Single-process production build:

```bash
npm run build      # builds client/dist
npm start          # server serves the built UI + API on :3001
```

## Access it from a phone or another computer (LAN)

Vite listens on `localhost` only by default — that is what its banner means when it
says `Network: use --host to expose`. To serve the UI to your local network:

```bash
npm run dev:lan    # API on 127.0.0.1:3001 + UI on 0.0.0.0:5173
```

Vite then prints a `Network:` URL; open `http://<this-machine-ip>:5173` on the other
device. Find the address on macOS with `ipconfig getifaddr en0`.

Only the UI port has to be reachable. The browser calls same-origin `/api/*`, and
Vite's proxy — which runs on this machine — forwards it to `127.0.0.1:3001`, so the
API itself stays bound to localhost and is never exposed to the network.

Anyone who can reach that port can upload PDFs to your machine and download the
results, so only use this on a network you trust. To bind just the UI:
`npm --prefix client run dev:host`. To make it permanent, set `server.host` in
`client/vite.config.ts`.

No root `concurrently` install wanted? Skip `npm run setup` and run the two
`npm --prefix ...` commands above instead.

## What the UI does

- Drag & drop or browse for a PDF (validated client and server side, 200 MB default cap)
- Pick a `-dPDFSETTINGS` profile: `screen`, `ebook`, `printer`, `prepress`, `default`
- Advanced: `-dCompatibilityLevel` (1.3–1.7), grayscale conversion, custom output file name
- Shows the exact `gs` command that will run before you click, plus the one that ran afterwards
- Upload progress bar, then the real before/after byte sizes, savings % and duration
- Download the result (original file name preserved) and optionally delete it from the server
- Session history of the last 8 compressions

## API

| Method | Path | Description |
| --- | --- | --- |
| GET | `/api/health` | server status + detected Ghostscript version |
| GET | `/api/presets` | presets and compatibility levels |
| POST | `/api/compress` | multipart: `file`, `preset`, `compatibilityLevel`, `grayscale`, `outputName` |
| GET | `/api/download/:id` | download a compressed PDF |
| DELETE | `/api/jobs/:id` | delete one job's files |
| POST | `/api/cleanup` | delete every stored file |

Example without the UI:

```bash
curl -F file=@input.pdf -F preset=ebook -F compatibilityLevel=1.4 \
  http://127.0.0.1:3001/api/compress
```

## Configuration

Environment variables for the server:

| Variable | Default | Meaning |
| --- | --- | --- |
| `PORT` | `3001` | API port |
| `HOST` | `127.0.0.1` | bind address (localhost only by default) |
| `GS_BIN` | `gs` | path to the Ghostscript binary |
| `GS_TIMEOUT_MS` | `300000` | kill a runaway conversion after 5 minutes |
| `FILE_TTL_MS` | `3600000` | auto-delete uploads/outputs after 1 hour |
| `MAX_UPLOAD_BYTES` | `209715200` | upload limit (200 MB) |

`env.sample` lists every one of them with its default and a short comment. It
holds defaults only (no secrets) and is meant to be committed — your own values
belong in `.env`, which is git-ignored.

The server does not bundle `dotenv`, and the `dev` / `start` scripts do not pass
`--env-file`, so copying the sample by itself changes nothing. Pick one:

```bash
cp env.sample .env                     # then edit .env
node --env-file=.env server/index.js   # Node 20.6+: load .env explicitly

# ...or skip the file and export the variables the scripts already inherit:
export PORT=3001 MAX_UPLOAD_BYTES=209715200
npm --prefix server run dev
```

Files in `server/uploads` and `server/output` are swept at startup and every
15 minutes, so nothing accumulates. `POST /api/cleanup` wipes them on demand.

## Notes & limits

- Ghostscript re-encodes images and rebuilds the PDF, so already-optimised or
  text-only PDFs may get slightly larger — the UI tells you when that happens.
- Arguments are passed to `spawn` as an argv array (never through a shell), so
  unusual file names cannot break out into shell commands.
- Job state is in memory; restarting the server forgets the download links but
  the files still expire on disk via the sweeper.
- PDFs are written to `server/output` in plain form — do not use this for
  sensitive documents on a shared machine.
