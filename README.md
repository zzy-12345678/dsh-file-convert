# dsh-file-convert

**Local-first file conversion for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).**

Convert images, PDFs and data files directly inside your DSH agent sessions — no API keys, no uploads, no servers, no token cost for the conversion itself. Files never leave your machine.

> **Unofficial community plugin.** Not affiliated with or endorsed by DeepSeek.

## Why

Agents constantly need file conversions: "turn this PDF into images", "give me that JSON as YAML", "convert all JPGs in this folder to WebP". Instead of shelling out or pasting data around, `dsh-file-convert` gives your agent four purpose-built tools backed by battle-tested local libraries.

- ✅ **Local execution** — files never leave the machine
- ✅ **No API key, no server, no conversion tokens**
- ✅ **Natural language friendly** — the agent calls the tools, you just ask
- ✅ **Batch conversions** with a compact summary
- ✅ **Honest failures** — missing dependency, unsupported pair, existing output: every error says exactly why
- ✅ **Images, PDF and data need zero external binaries** — prebuilt npm packages only. Media needs one tool (ffmpeg), clearly reported when missing

## Supported conversions (V0.1)

| Source | Targets |
| --- | --- |
| PNG, JPG, WEBP | PNG, JPG, WEBP (any-to-any) |
| SVG | PNG, JPG, WEBP |
| PDF | PNG, JPG, TXT |
| JSON | YAML, CSV |
| YAML | JSON, CSV |
| MP4 | GIF, MP3 |
| MOV | MP4 |
| WAV | MP3 |
| CSV | JSON, YAML |

22 conversions. Images, PDF and data work out of the box via `npm install`. The four media rows unlock once FFmpeg is available: install it system-wide (on PATH or via the `ffmpegPath` config), **or just ask the agent to run `install_media_dependencies`** — it downloads pinned builds into the plugin cache with sha512 integrity verification (about 139 MB on Windows, one time), from the `npmmirror.com` registry by default with npmjs.org as automatic fallback. Until then `list_conversions` reports the media rows as unavailable and names the missing tool. Office (DOCX/PPTX/XLSX via LibreOffice) is planned for V0.3.

## Install

Inside a DSH profile:

```sh
dsh plugin --profile default add dsh-file-convert
```

From a local checkout (e.g. while hacking on it):

```sh
git clone https://github.com/zzy-12345678/dsh-file-convert
cd dsh-file-convert && npm install && npm run build
dsh plugin --profile default add /absolute/path/to/dsh-file-convert
```

Then restart DSH (`dsh web` or your usual entry point). All four tools appear automatically.

## The six tools

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
- Multi-page PDFs produce `<name>-<page>.<ext>` for every page.
- Existing outputs are refused unless `overwrite: true`.
- Options: `output`, `overwrite`, `quality` (1–100), `dpi` (PDF/SVG rasterization).

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
- Targets below what the codec can physically reach are refused with the achievable minimum.
- GIF and PDF optimization are not supported yet.

### `install_media_dependencies`

One-call media setup: downloads pinned `@ffmpeg-installer` / `@ffprobe-installer` builds into the plugin cache (`~/.dsh-file-convert/bin`), verifies the registry's sha512 integrity, and proves the binaries run before reporting success. Downloads default to the `npmmirror.com` mirror (npmjs.org fallback; pin another source with `registry`). System installs keep priority over the cache. Ask the user for consent first — it is a sizable download.

### `list_conversions`

What works on *this* machine, right now — unavailable rows name the missing tool and how to install it. V0.1 needs nothing external, so everything is available.

## Plugin config

| Key | Default | Meaning |
| --- | --- | --- |
| `quality` | `85` | Default JPEG/WebP quality (1–100) |
| `dpi` | `150` | Default rasterization DPI for PDF inputs |
| `timeoutMs` | `120000` | Cooperative timeout for one conversion |
| `batchMaxFiles` | `500` | Max files examined per `batch_convert` run; beyond it the summary reports what was skipped instead of silently capping |
| `outputRoots` | `[]` | When non-empty, explicit `output` paths must resolve inside one of these directories (recommended for shared deployments; the default next-to-input output is always exempt) |
| `ffmpegPath` / `ffprobePath` | - | Explicit binary paths when ffmpeg is not on PATH (common on Windows) |

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
      4 tool registrations)              │
                       ┌─────────────────┼─────────────────┐
                       ↓                 ↓                 ↓
                 ImageConverter     PdfConverter      DataConverter
                    sharp          pdfjs-dist         js-yaml
                 (libvips npm)   @napi-rs/canvas    csv-parse / stringify
                                                     MediaConverter
                                                        ffmpeg (optional, detected)
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

## Roadmap

- ~~V0.2 — Media (FFmpeg)~~ **shipped**: MP4→GIF/MP3, WAV→MP3, MOV→MP4, plus `optimize_file` with target-size two-pass encoding.
- **V0.3 — Office (LibreOffice)**: DOCX/PPTX/XLSX→PDF; PDF→DOCX (experimental, OCR-ready parameter surface already specced); PDF compression.
- Later: page-range selection, conversion chains (PPTX→PDF→PNG), video downscaling in `optimize_file`, resize/rotate image options.

## License

[MIT](./LICENSE). dsh-file-convert distributes no external binaries; runtime libraries (sharp, pdfjs-dist, @napi-rs/canvas, js-yaml, csv) are installed from npm under their own licenses.
