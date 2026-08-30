# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project adheres to [Semantic Versioning](https://semver.org/).

## [0.4.0] - 2026-08-30

### Added

- `pages` option for PDF conversions (`convert_file`, `batch_convert`): select pages with ranges like `1-3,5,8-10`; outputs keep their real page numbers (`doc-3.png`), text joins the selected pages.
- OCR for PDF → TXT: `ocr: true` (optionally `ocr_lang`, default `chi_sim+eng`) rasterizes the pages and recognizes them. Engine priority: a locally installed Tesseract CLI, then the bundled tesseract.js (language data downloads into the plugin cache on first use). Intended for scanned PDFs — `inspect_file` flags those via `likelyScanned`.

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
