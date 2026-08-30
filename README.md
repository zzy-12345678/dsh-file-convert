# dsh-file-convert

**Local-first file conversion for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).**

Convert images, PDFs and data files directly inside your DSH agent sessions — no API keys, no uploads, no servers, no token cost for the conversion itself. Files never leave your machine.

> **Unofficial community plugin.** Not affiliated with or endorsed by DeepSeek.

## Why

Agents constantly need file conversions: "turn this PDF into images", "give me that JSON as YAML", "convert all JPGs in this folder to WebP". Instead of shelling out or pasting data around, `dsh-file-convert` gives your agent seven purpose-built tools backed by battle-tested local libraries.

- ✅ **Local execution** — files never leave the machine
- ✅ **No API key, no server, no conversion tokens**
- ✅ **Natural language friendly** — the agent calls the tools, you just ask
- ✅ **Batch conversions** with a compact summary
- ✅ **Honest failures** — missing dependency, unsupported pair, existing output: every error says exactly why
- ✅ **Images, PDF and data need zero external binaries** — prebuilt npm packages only. Media needs one tool (ffmpeg), clearly reported when missing

## Supported conversions

| Source | Targets |
| --- | --- |
| PNG, JPG, WEBP | PNG, JPG, WEBP (any-to-any) |
| SVG | PNG, JPG, WEBP |
| PDF | PNG, JPG, TXT |
| JSON | YAML, CSV |
| YAML | JSON, CSV |
| DOCX, PPTX, XLSX | PDF |
| PDF | PNG, JPG, TXT, DOCX (experimental); TXT supports OCR for scanned PDFs |
| MP4 | GIF, MP3 |
| MOV | MP4 |
| WAV | MP3 |
| CSV | JSON, YAML |

26 conversions. Images, PDF and data work out of the box via `npm install`. Optional tools unlock the rest, each clearly reported by `list_conversions` when missing:

- **FFmpeg** -> media rows. Install it system-wide (preferred for untrusted media), **or ask the agent to run `install_media_dependencies`** — it downloads pinned current builds (FFmpeg 6.1.1, ~56 MB total, one time) into the plugin cache, sha256-verified, from the npmmirror binary CDN with the GitHub release as fallback.
- **LibreOffice** -> DOCX/PPTX/XLSX to PDF. `winget install TheDocumentFoundation.LibreOffice` / `brew install --cask libreoffice` / `apt install libreoffice`.
- **Ghostscript** -> PDF compression in `optimize_file`.
- **Python + pdf2docx** -> the experimental PDF to DOCX row (`pip install pdf2docx`).
- **Tesseract** (optional) -> faster OCR for scanned PDFs; without it the bundled tesseract.js is used and its language data is fetched explicitly via `install_ocr_dependencies` (`winget install UB-Mannheim.TesseractOCR`).

## Install

Inside a DSH profile — three ways, easiest first:

```sh
# 1. from npm (once published)
dsh plugin --profile default add dsh-file-convert

# 2. straight from GitHub (a `prepare` build runs; allow it once)
dsh plugin --profile default add github:zzy-12345678/dsh-file-convert
```

Git installs may ask you to allow the build step in the profile's `pnpm-workspace.yaml`:

```yaml
allowBuilds:
  dsh-file-convert: true
```

From a local checkout (e.g. while hacking on it):

```sh
git clone https://github.com/zzy-12345678/dsh-file-convert
cd dsh-file-convert && npm install && npm run build
dsh plugin --profile default add /absolute/path/to/dsh-file-convert
```

Then restart DSH (`dsh web` or your usual entry point). All seven tools appear automatically.

## The seven tools

### `convert_file`

Convert one file.

```json
{ "input": "/tmp/report.pdf", "output_format": "png", "dpi": 200 }
```

```
Converted: /tmp/report.pdf (pdf) -> /tmp/report.png (png)
1.2 MB -> 431.0 KB in 1.4s
```

- Default output: next to the input file, same base name, new extension.
- Multi-page PDFs produce `<name>-<page>.<ext>` for every page; `pages: "1-3,5"` selects pages (outputs keep their real page numbers, text joins only the selection).
- Scanned PDFs → TXT: `ocr: true` (optionally `ocr_lang`, default `chi_sim+eng`) recognizes the rendered pages instead of the text layer. Engine priority: a local Tesseract CLI, then the bundled tesseract.js (whose language data is never downloaded implicitly — run `install_ocr_dependencies` first, about 10-30 MB per language).
- Existing outputs are refused unless `overwrite: true`.
- Options: `output`, `overwrite`, `quality` (1–100), `dpi` (PDF/SVG rasterization), `pages`, `ocr`, `ocr_lang`.

### `batch_convert`

Convert every matching file in a directory (top level).

```json
{ "input_dir": "/home/me/Pictures", "output_format": "webp" }
```

```
Batch convert in /home/me/Pictures -> WEBP
Converted: 18, skipped: 2, failed: 0
Output dir: /home/me/Pictures/output
```

- `input_format` filters by source format; omit it to auto-detect every convertible file.
- `output_dir` defaults to `<input_dir>/output`.
- Existing outputs are **skipped** (not overwritten) unless `overwrite: true`.

### `inspect_file`

Facts before action, detected from file content — not just the extension:

```json
{ "input": "/tmp/scan.pdf" }
```

```json
{ "kind": "pdf", "pages": 24, "encrypted": false, "likelyScanned": true, "bytes": 13000000 }
```

### `optimize_file`

Shrink a file toward a target size instead of converting it:

```json
{ "input": "video.mp4", "target_size_mb": 20 }
```

```
Optimized: video.mp4 (mp4) -> video-min.mp4
18.3 MB -> 19.7 MB (target 20 MB) in 41.2s
Applied: two-pass x264: video 512k + audio 128k over 185.0s
```

- MP4/MOV: two-pass x264, the video bitrate is computed from the target (audio 128k, dropping to 64k for tight targets); output is always MP4. Requires ffmpeg + ffprobe.
- JPG/WEBP: binary-searches the highest encoder quality that fits; PNG uses palette reduction. No external tools needed.
- PDF: Ghostscript quality presets (printer/ebook/screen), first preset that fits the target wins; requires Ghostscript.
- Targets below what the codec can physically reach are refused with the achievable minimum.
- GIF optimization is not supported yet.

### `install_media_dependencies`

One-call media setup: downloads pinned FFmpeg 6.1.1 static builds (ffmpeg + ffprobe) into the plugin cache (`~/.dsh-file-convert/bin`), verifies the pinned sha256, and proves the binaries run before reporting success. Served from the npmmirror binary CDN with the GitHub release as a byte-identical fallback. System installs keep priority over the cache. Ask the user for consent first — it is a sizable download.

### `install_ocr_dependencies`

Downloads the tesseract.js language data (about 10-30 MB per language, `chi_sim+eng` by default) into the plugin cache, so `ocr: true` works without a local Tesseract. Skips when a local Tesseract CLI is installed or the data is already cached. Ask the user for consent first — conversions never download language data implicitly.

### `list_conversions`

All 26 conversions with their live availability on *this* machine — unavailable rows name the missing tool and how to install it. Images, PDF and data rows are usable out of the box; media, office and PDF-compression rows depend on the optional tools (media can even be set up by the agent via `install_media_dependencies`).

## Plugin config

| Key | Default | Meaning |
| --- | --- | --- |
| `quality` | `85` | Default JPEG/WebP quality (1–100) |
| `dpi` | `150` | Default rasterization DPI for PDF inputs |
| `timeoutMs` | `120000` | Cooperative timeout for one conversion |
| `maxInputMb` | `2048` | Refuse inputs above this size (MB) |
| `maxPdfPages` | `200` | Full-document PDF rasterization refuses more pages; use `pages` for larger documents |
| `maxOutputPixels` | `16000000` | Clamp rasterized pixels per page (width × height) to this budget |
| `batchMaxFiles` | `500` | Max files examined per `batch_convert` run; beyond it the summary reports what was skipped instead of silently capping |
| `outputRoots` | `[]` | When non-empty, explicit `output` paths must resolve inside one of these directories (recommended for shared deployments; the default next-to-input output is always exempt) |
| `ffmpegPath` / `ffprobePath` | - | Explicit binary paths when ffmpeg is not on PATH (common on Windows) |
| `sofficePath` / `ghostscriptPath` / `pythonPath` / `tesseractPath` | - | Explicit paths for the optional tools, overriding auto-detection |

## Architecture

```
                         DSH
                          │
                    dsh-file-convert
           ┌──────────────┴──────────────┐
     src/index.ts                   src/core/            ← the whole engine,
     (thin DSH glue:                (no DSH imports)       testable standalone
      name/inject/apply,                 │
      Config schema,                ConversionRouter
      7 tool registrations)              │
                       ┌─────────────────┼─────────────────┐
                       ↓                 ↓                 ↓
                 ImageConverter     PdfConverter      DataConverter
                    sharp          pdfjs-dist         js-yaml
                 (libvips npm)   @napi-rs/canvas    csv-parse / stringify
                                                     MediaConverter        OfficeConverter
                                                        ffmpeg (detected)      LibreOffice (detected)
                                                     PdfToDocxConverter    optimize_file/pdf
                                                     python + pdf2docx         Ghostscript (detected)
```

- **Declarative matrix**: every conversion is a data row (`{ from, to }`) on its converter. Routing, `list_conversions` and dependency checks are all derived from it.
- **Detection**: content first - binary magic (file-type), SVG sniffing, and JSON parsing (plus a YAML document-marker guess for extension-less files) - with the extension as fallback. Conflicts resolve in favor of the content, with a warning.
- **Core is DSH-agnostic**: `src/core` never imports Cordis/DSH, so the engine can be unit-tested, wrapped in a CLI, or served over MCP later. If the DSH developer-preview API shifts, only the glue layer changes.
- **Dependencies**: external binaries (FFmpeg, LibreOffice, Poppler) are *detected, never auto-installed* — `list_conversions` reports them and prints per-platform install hints. The interface is already in place (`BinaryDependency`).

## Development

```sh
npm install
npm run build     # tsc -> lib/
npm test          # vitest, 31 tests
npm run smoke     # end-to-end against lib/
```

Add a conversion = add one capability row + implement it in a converter. Add a backend = implement the `Converter` interface and register it in `createRouter()`.

## Fidelity & safety expectations

- **Lossy by nature**: PDF→DOCX (experimental), OCR and office→PDF are reconstructions — expect layout and recognition differences. `inspect_file`'s `likelyScanned` flag tells you when OCR is the right tool, and results carry warnings.
- **Cached ffmpeg builds**: the download convenience installs pinned sha256-verified FFmpeg 6.1.1 static builds. For untrusted media, a current system FFmpeg takes priority — prefer it in security-sensitive setups.
- **Not a sandbox**: `outputRoots` resolves symlinks and resource limits (`maxInputMb`, `maxPdfPages`, `maxOutputPixels`, `batchMaxFiles`) cap runaway jobs, but the default next-to-input output is intentionally exempt from roots, and an agent that may write files can always write somewhere. For hostile multi-tenant use, add OS-level isolation on top.

## Roadmap

- ~~V0.2 — Media (FFmpeg)~~ **shipped**: MP4→GIF/MP3, WAV→MP3, MOV→MP4, plus `optimize_file` with target-size two-pass encoding.
- ~~V0.3 — Office + PDF tooling~~ **shipped**: DOCX/PPTX/XLSX→PDF via LibreOffice, experimental PDF→DOCX via python pdf2docx, PDF compression via Ghostscript; on-demand dependency downloads with an automatic CN mirror.
- ~~V0.4 — OCR (Tesseract)~~ **shipped**: PDF→TXT supports `ocr: true` (optional `ocr_lang`), local Tesseract CLI first with the bundled tesseract.js as fallback, language data fetched explicitly via `install_ocr_dependencies`.
- Later: OCR → DOCX for scanned PDFs, conversion chains (PPTX→PDF→PNG), video downscaling in `optimize_file`, resize/rotate image options.

## License

[MIT](./LICENSE). dsh-file-convert distributes no external binaries; runtime libraries (sharp, pdfjs-dist, @napi-rs/canvas, js-yaml, csv) are installed from npm under their own licenses.
