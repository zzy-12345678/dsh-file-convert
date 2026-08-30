# dsh-file-convert

**为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 打造的本地优先文件转换插件。**

在 DSH Agent 会话里直接转换图片、PDF 和数据文件——不需要 API Key，不上传文件，不需要服务器，转换本身零 Token 消耗，文件永远不离开你的电脑。

> **非官方社区插件。** 与 DeepSeek 官方无隶属关系。

## 为什么做这个

Agent 日常需要各种格式转换："把这个 PDF 转成图片"、"把这个 JSON 变成 YAML"、"把文件夹里所有 JPG 转成 WebP"。`dsh-file-convert` 提供七个专用 tool，背后是久经考验的本地库，你只需用自然语言提需求。

- ✅ **本地执行** —— 文件不出机器
- ✅ **不要 API Key、不要服务器、不耗转换 Token**
- ✅ **自然语言友好** —— Agent 调 tool，你直接说话
- ✅ **批量转换**，返回紧凑的结果摘要
- ✅ **失败必有原因** —— 缺依赖 / 不支持的组合 / 输出已存在，每个错误都说明清楚
- ✅ **图片/PDF/数据零外部依赖** —— npm 预编译包装完即用；音视频只依赖 ffmpeg，缺了会明确提示

## 当前支持的转换

| 输入 | 可输出 |
| --- | --- |
| PNG、JPG、WEBP | PNG、JPG、WEBP（任意互转） |
| SVG | PNG、JPG、WEBP |
| PDF | PNG、JPG、TXT |
| JSON | YAML、CSV |
| YAML | JSON、CSV |
| DOCX、PPTX、XLSX | PDF |
| PDF | PNG、JPG、TXT、DOCX（实验性）；TXT 支持扫描件 OCR |
| MP4 | GIF、MP3 |
| MOV | MP4 |
| WAV | MP3 |
| CSV | JSON、YAML |

共 26 种转换。图片/PDF/数据 `npm install` 后开箱即用；其余按"装一个工具解锁一类"的节奏，缺什么 `list_conversions` 都会明说：

- **FFmpeg** -> 音视频四条。装系统级，**或让 Agent 跑 `install_media_dependencies`**——默认从 `npmmirror.com` 镜像下载固定版本二进制（约 80-140 MB，一次性）到插件缓存，带 sha512 校验，npmjs.org 自动回退。
- **LibreOffice** -> DOCX/PPTX/XLSX 转 PDF。`winget install TheDocumentFoundation.LibreOffice` / `brew install --cask libreoffice` / `apt install libreoffice`。
- **Ghostscript** -> `optimize_file` 的 PDF 压缩。
- **Python + pdf2docx** -> 实验性的 PDF 转 DOCX（`pip install pdf2docx`）。
- **Tesseract**（可选）-> 更快的扫描件 OCR；不装则用内置 tesseract.js，其语言数据通过 `install_ocr_dependencies` 显式下载（`winget install UB-Mannheim.TesseractOCR`，记得勾选 chi_sim 语言组件）。

## 安装

在 DSH profile 中：

```sh
dsh plugin --profile default add dsh-file-convert
```

本地开发安装：

```sh
git clone https://github.com/zzy-12345678/dsh-file-convert
cd dsh-file-convert && npm install && npm run build
dsh plugin --profile default add /absolute/path/to/dsh-file-convert
```

重启 DSH（`dsh web` 或你的常规入口）后，七个 tool 自动出现。

## 七个 Tool

### `convert_file` —— 单文件转换

```json
{ "input": "/tmp/report.pdf", "output_format": "png", "dpi": 200 }
```

- 默认输出到源文件同目录、同名换后缀。
- 多页 PDF 会为每一页输出 `<文件名>-<页码>.<后缀>`；`pages: "1-3,5"` 选择页码（输出保留真实页码，TXT 只拼接所选页）。
- 扫描件 PDF → TXT：`ocr: true`（可选 `ocr_lang`，默认 `chi_sim+eng`）对渲染页面做识别，而不是读文本层。引擎优先本机 Tesseract CLI，其次插件内置的 tesseract.js（语言数据不会随转换隐式下载——先让 Agent 跑 `install_ocr_dependencies`，约每种语言 10-30 MB）。
- 输出文件已存在时默认拒绝，需显式 `overwrite: true`。
- 可选参数：`output`、`overwrite`、`quality`（1–100）、`dpi`（PDF/SVG 光栅化）、`pages`、`ocr`、`ocr_lang`。

### `batch_convert` —— 目录批量转换

```json
{ "input_dir": "/home/me/Pictures", "output_format": "webp" }
```

- `input_format` 可按源格式过滤；不传则自动探测所有可转换文件。
- `output_dir` 默认为 `<input_dir>/output`。
- 已存在的输出默认**跳过**（不覆盖），`overwrite: true` 时替换。

### `inspect_file` —— 转换前先看清楚

基于文件内容（magic bytes）而非扩展名识别格式：

```json
{ "kind": "pdf", "pages": 24, "encrypted": false, "likelyScanned": true, "bytes": 13000000 }
```

图片返回尺寸/通道数，数据文件返回记录数。`likelyScanned: true` 提示这可能是扫描件——转 TXT 时加 `ocr: true` 即可识别。

### `optimize_file` —— 按目标体积压缩

PDF 走 Ghostscript 三档预设（printer/ebook/screen）自动迭代：某档已达标就停，全超则保留最小档并如实告知。需要 Ghostscript（`winget install ArtifexSoftware.GhostScript`）。

```json
{ "input": "video.mp4", "target_size_mb": 20 }
```

- MP4/MOV：两遍编码 x264，按目标体积反推视频码率（音频 128k，紧张时降到 64k），输出统一为 MP4，需要 ffmpeg + ffprobe。
- JPG/WEBP：二分搜索能塞进目标体积的最高编码质量；PNG 走调色板压缩。图片不需要任何外部工具。
- 目标体积低于编码物理下限时直接拒绝，并给出可达的最低体积。
- GIF/PDF 压缩暂不支持。

### `install_media_dependencies` —— 一键补齐媒体依赖

默认从 `npmmirror.com` 镜像下载固定版本的 `@ffmpeg-installer` / `@ffprobe-installer` 二进制到插件缓存（`~/.dsh-file-convert/bin`），校验 sha512 完整性，并真实执行一次二进制确认可用后才报告成功（npmjs.org 自动回退，`registry` 参数可指定其它源）。系统安装的 ffmpeg 优先于缓存。体积可观，调用前请先征得用户同意。

### `install_ocr_dependencies` —— 一键补齐 OCR 语言包

把 tesseract.js 的语言数据（默认 `chi_sim+eng`，约每种语言 10-30 MB）下载进插件缓存（`~/.dsh-file-convert/tessdata`），让 `ocr: true` 在没有本机 Tesseract 时也能工作。已装本机 Tesseract 或语言包已缓存时跳过。体积可观，调用前请先征得用户同意——转换路径绝不隐式下载语言数据。

### `list_conversions` —— 当前机器的能力清单

列出全部 26 种转换在当前机器上的实时可用状态；某项不可用时，明确指出缺哪个外部工具并给出安装提示。图片/PDF/数据类开箱即用，音视频、Office、PDF 压缩依赖可选工具（媒体依赖还能由 Agent 经 `install_media_dependencies` 自动补齐）。

## 插件配置

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `quality` | `85` | JPEG/WebP 默认质量（1–100） |
| `dpi` | `150` | PDF 光栅化默认 DPI |
| `timeoutMs` | `120000` | 单次转换的协作式超时（毫秒） |
| `batchMaxFiles` | `500` | 每次 `batch_convert` 最多检查的文件数；超出时会在结果里明确报告跳过了多少，而不是静默截断 |
| `outputRoots` | `[]` | 非空时，显式指定的 `output` 路径必须落在这些目录之内（共享部署建议开启；默认写到输入文件旁的输出不受限） |
| `ffmpegPath` / `ffprobePath` | - | ffmpeg 不在 PATH 时（Windows 常见）手动指定二进制路径 |
| `sofficePath` / `ghostscriptPath` / `pythonPath` / `tesseractPath` | - | 各可选工具的手动路径，优先于自动探测 |

## 架构

```
                         DSH
                          │
                    dsh-file-convert
           ┌──────────────┴──────────────┐
     src/index.ts                   src/core/            ← 整个引擎，
     （薄胶水层：                     （不 import DSH）       可独立测试
      name/inject/apply、                 │
      Config schema、               ConversionRouter
      7 个 tool 注册）                    │
                       ┌─────────────────┼─────────────────┐
                       ↓                 ↓                 ↓
                 ImageConverter     PdfConverter      DataConverter
                    sharp          pdfjs-dist         js-yaml
                 （npm libvips）  @napi-rs/canvas    csv-parse / stringify
                                                     MediaConverter        OfficeConverter
                                                        ffmpeg（自动检测）     LibreOffice（自动检测）
                                                     PdfToDocxConverter    optimize_file/pdf
                                                    python+pdf2docx           Ghostscript（自动检测）
```

- **声明式转换矩阵**：每条转换是 converter 上的一行数据（`{ from, to }`），Router 路由、`list_conversions`、依赖检查全部由此推导。
- **格式识别**：内容优先——二进制 magic（file-type）、SVG 嗅探、JSON 解析（无扩展名文件还会尝试 YAML 文档标记猜测）——扩展名兜底；两者冲突以内容为准并给出 warning。
- **核心与 DSH 解耦**：`src/core` 不依赖 Cordis/DSH，可直接单测、包 CLI、将来包 MCP server。DSH developer preview 的 API 若有破坏性变更，只需改胶水层。
- **依赖管理**：外部二进制（FFmpeg/LibreOffice/Poppler）只做**检测，绝不自动安装**——`list_conversions` 报告缺失并给出各平台安装提示。接口已就位（`BinaryDependency`）。

## 开发

```sh
npm install
npm run build     # tsc -> lib/
npm test          # vitest，31 个测试
npm run smoke     # 针对 lib/ 的端到端冒烟测试
```

加一种转换 = 在 converter 的能力表里加一行数据并实现它。加一类后端 = 实现 `Converter` 接口并在 `createRouter()` 注册。

## Roadmap

- ~~V0.2 —— 音视频（FFmpeg）~~ **已发布**：MP4→GIF/MP3、WAV→MP3、MOV→MP4，以及按目标体积两遍编码的 `optimize_file`。
- ~~V0.3 —— Office + PDF 工具链~~ **已发布**：LibreOffice 解锁 DOCX/PPTX/XLSX→PDF，python pdf2docx 支持实验性 PDF→DOCX，Ghostscript 支持 PDF 压缩；依赖支持按需下载并默认走国内镜像。
- 更远：扫描件 OCR → DOCX、转换链（PPTX→PDF→PNG）、`optimize_file` 视频降分辨率、图片缩放/旋转。

## 许可

[MIT](./LICENSE)。dsh-file-convert 不分发任何外部二进制；运行时依赖库（sharp、pdfjs-dist、@napi-rs/canvas、js-yaml、csv）由用户从 npm 安装，各归其许可。
