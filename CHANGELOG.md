## [0.5.0] - 2026-10-24

### Added

- Local web UI (`npm run ui`): drag & drop files in the browser, pick a target from the live capability matrix, download the results. Zero new dependencies (Node `http` plus one static page); binds to `127.0.0.1` with a random per-session token, streams uploads to a private per-instance workspace, and aborts the underlying conversion when the tab closes mid-job.
- `open_ui` tool: hosts the same UI inside the plugin process and returns its URL; the first call opens the browser, later calls reuse the running server. New config keys `uiAutoStart` (start on plugin load) and `uiTimeoutMin` (per-conversion deadline inside the UI, default 30 min).
- Native DSH Desktop integration (modeled on dsh-plugin-beyond-simulator): the plugin consumes the host `webServer` service and mounts the converter at `/dsh-file-convert`, and a client bundle (package.json `dsh.client` + the `./client` export, loaded via `window.__ModuleLoader__`) adds a "文件转换" tab to the conversation view that embeds the converter in place. The standalone server remains as the fallback for use outside DSH.

### Changed

- User-facing text is Chinese-first: the web UI, conversion warnings (multi-page notes, OCR, format-detection conflicts, the experimental PDF→DOCX notice) and a Chinese headline for every failure surfaced in the UI; the raw error message stays as technical detail and tool-plane messages stay English for the agent.

### Fixed

- The UI's Origin guard compared against a portless base URL, so every browser-initiated conversion was rejected with 403 while page loads worked; it now compares against the request's Host header and tolerates loopback spellings (127.0.0.1 / localhost / [::1]). A stale page also reloads itself once to pick up a fresh session token.
- Hosting the UI twice (host reload, extra scopes) registered a duplicate prefix route, which the host treats as a fatal load failure and took the whole desktop down; the mount is now a process-level singleton claimed synchronously, the register call is duplicate-tolerant, and applies are covered by an idempotency test.
- The hosted page addressed its API at the origin root instead of the mount prefix, so the capability matrix (and the target-format picker with it) failed to load; the base path is now injected into the page and all requests and download links carry it.

## [0.4.8] - 2026-10-24

### Changed

- Officially target DeepSeek Harness Desktop 0.2.1-rc.3 and its `@deepseek-ai/dsh-tools` 0.2.1-rc.3 runtime (API-identical to rc.2; version pins only, refreshed lockfile).

### Fixed

- Atomic final-path writes everywhere: binary downloads into the plugin cache, ffmpeg media output, LibreOffice/pdf2docx products and every `optimize_file` branch (no-op copy, two-pass video, quality search, Ghostscript presets) now publish through a sibling-temp + rename. An abort, timeout or crash can no longer leave a half-written file at the final path; ffmpeg encodes name the muxer explicitly since the `.tmp` scratch suffix is not inferable.
- Cancellation now actually stops the pure-JS paths: in-flight PDF page renders are cancelled through pdf.js render tasks, tesseract.js recognition stops by terminating its worker, and sharp/data/optimizer pipelines check the signal at every step boundary and never write output after an abort. A single synchronous step (one sharp encode, one `JSON.parse`) still cannot be interrupted mid-flight - README wording now states exactly what `timeoutMs` stops.

## [0.4.7] - 2026-10-18

### Changed

- Officially target DeepSeek Harness Desktop 0.2.1-rc.2 and its `@deepseek-ai/dsh-tools` 0.2.1-rc.2 runtime.
- Align Cordis and Schemastery with the versions bundled by DSH 0.2.1-rc.2 (`4.0.5` and `3.18.5`).
- Refresh the development peer closure: add `dsh-working-directory` required by the new tool runtime and remove the retired `dsh-invariants` package.

### Fixed

- Prefer LibreOffice's console launcher (`soffice.com`) on Windows, avoiding hangs from recent `soffice.exe` GUI launchers during headless conversion.
- Use a disposable LibreOffice profile per conversion so stale settings from an older LibreOffice release cannot break headless exports.

## [0.4.6] - 2026-09-14

### Changed

- Officially target DeepSeek Harness 0.2.0-rc.2 by updating the `@deepseek-ai/dsh-tools` peer contract from 0.1.5-rc.2 to 0.2.0-rc.2.
- Align Cordis peer to `~4.0.4` to match the 0.2.0 host runtime.
- Development installs pull the 0.2.0 peer closure (`dsh-ptc-runtime`, sandbox peers, …) so local typecheck and vitest load the 0.2.0 tool registry.

## [0.4.5] - 2026-09-14

### Changed

- Officially target DeepSeek Harness 0.1.5-rc.2 by updating the `@deepseek-ai/dsh-tools` peer contract from 0.1.2-rc.1 to 0.1.5-rc.2.
- Raise the Node.js floor to `^22.19.0 || >=24.0.0`, matching DSH 0.1.5's engines range.
- Development installs pull the full dsh-tools peer closure (scope, llm, agent, session, …) so local typecheck and vitest load the 0.1.5 tool registry; runtime consumers still receive these from the host profile.

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
