## [0.4.4] - 2026-09-03

### Changed

- Officially target DeepSeek Harness 0.1.2-rc.1 by updating the `@deepseek-ai/dsh-tools` peer contract from 0.0.1-rc.1 to 0.1.2-rc.1.
- Treat Cordis and dsh-tools as host-provided peer dependencies, matching first-party DSH plugin packaging and avoiding duplicate core runtimes.
- Raise the Node.js floor to 22.13, matching DSH 0.1.2 and the installed PDF.js runtime requirement.
- Refresh compatible Cordis, Schemastery and PDF.js patch/minor dependencies.
- Add a compatibility contract test for bundle metadata, canonical outputs, strict argument validation and concurrency declarations.

## [0.4.3] - 2026-08-30

### Changed

- Release infrastructure: tag-driven publishes now run through OIDC trusted publishing on GitHub Actions (no npm tokens, provenance attestations included). No code changes beyond 0.4.2.

## [0.4.2] - 2026-08-30

### Fixed

- `optimize_file` resolves output/input through the shared same-file guard, so an output symlink aliasing the input can no longer bypass the destroy-the-source check.
- Atomic writes: the temp file is a sibling of the target (same volume, no EXDEV); Windows AV locks are retried briefly and then fail loudly instead of silently degrading to a non-atomic copy.

## [0.4.1] - 2026-08-30

### Fixed

- The package root now re-exports the whole core API (`createRouter`, converters, guards), so library consumers and the packaging CI can import it directly.
- CI installs ffmpeg on all three OSes (runner images stopped shipping it): the media suite runs for real again and the ungated corrupt-media test no longer trips over `missing_dependency`.

# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/).

## [0.4.0] - 2026-08-30

### Changed

- Timeout is now a true cancellation: conversions observe an abort signal, so ffmpeg children are killed and page loops stop instead of running behind an already-returned result.
- All outputs (images, data, PDF text, page rasters, PDF→DOCX) are written through scratch files and published atomically; a failed page cleans up the pages already written.
- Windows ffmpeg/ffprobe downloads now install pinned, sha256-verified FFmpeg 6.1.1 static builds (ffmpeg-static, npmmirror binary CDN with a byte-identical GitHub fallback) instead of the 2018-era FFmpeg 4.1 npm packages; a current system ffmpeg keeps priority for untrusted media.
- `outputRoots` resolves symlinks (real-path) before confinement, and `isSameFile` detects symlink aliases of the input.
- Resource limits are configurable and enforced: `maxInputMb` (default 2048), `maxPdfPages` (default 200, applies to implicit full-document rasterization; explicit `pages` override it) and `maxOutputPixels` (default 16 MP, clamped per page with a warning).

### Added

- `pages` option for PDF conversions (`convert_file`, `batch_convert`): select pages with ranges like `1-3,5,8-10`; outputs keep their real page numbers (`doc-3.png`), text joins the selected pages.
- OCR for PDF → TXT: `ocr: true` (optionally `ocr_lang`, default `chi_sim+eng`) rasterizes the pages and recognizes them. Engine priority: a locally installed Tesseract CLI, then the bundled tesseract.js (language data downloads into the plugin cache on first use). Intended for scanned PDFs — `inspect_file` flags those via `likelyScanned`.
- `install_ocr_dependencies`: explicit download of tesseract.js language data (~10-30 MB per language) into the plugin cache. Conversions never download language data implicitly — without a cached pack they fail with guidance, and a local Tesseract missing a language reads as `missing_dependency` too.
- `install_ocr_dependencies` renamed flow hardened; cached installs are recorded in a `manifest.json` (version, sha256, size, install date) and flag themselves for a `force: true` upgrade when they predate it.
- Security test suite: symlink aliases of the input, symlink escape of `outputRoots`, oversized SVG, malformed PDF, corrupt media, long file names, concurrent same-output writes and oversized JSON.

## [0.3.0] - 2026-08-30

### Added

- DOCX/PPTX/XLSX → PDF via a locally installed LibreOffice (serialized, isolated profile).
- Experimental PDF → DOCX via the Python `pdf2docx` package (probe verifies the module is importable).
- PDF compression in `optimize_file` via Ghostscript presets (printer/ebook/screen).
- Binary dependency deep-probes (`python` without `pdf2docx` counts as missing) and install-location probing (Windows soffice is not on PATH).

### Fixed

- PDF/video optimization write to scratch files and copy the finished result, so aborted runs never leave broken outputs.
- Ghostscript resolves through versioned install directories even when PATH is stale.

## [0.2.0] - 2026-08-30

### Added

- MP4 → GIF/MP3, WAV → MP3, MOV → MP4 via a locally installed FFmpeg (declared as a `BinaryDependency`; `list_conversions` reports it per row).
- `optimize_file`: two-pass x264 video compression toward a target size; JPG/WEBP quality search; PNG palette reduction.
- `install_media_dependencies`: on-demand download of pinned ffmpeg/ffprobe builds into the plugin cache with sha512 integrity verification; npmmirror.com by default, npmjs.org fallback.
- Batch pools respect each converter's declared concurrency; `batchMaxFiles` and `outputRoots` config.

## [0.1.0] - 2026-08-29

### Added

- Initial release: 18 local conversions across images (sharp), PDF (pdfjs-dist + pdf.js canvas) and data formats (JSON/YAML/CSV), with `convert_file`, `batch_convert`, `inspect_file` and `list_conversions`.
