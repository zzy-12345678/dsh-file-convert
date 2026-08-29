# dsh-file-convert

**为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 打造的本地优先文件转换插件。**

在 DSH Agent 会话里直接转换图片、PDF 和数据文件——不需要 API Key，不上传文件，不需要服务器，转换本身零 Token 消耗，文件永远不离开你的电脑。

> **非官方社区插件。** 与 DeepSeek 官方无隶属关系。

## 为什么做这个

Agent 日常需要各种格式转换："把这个 PDF 转成图片"、"把这个 JSON 变成 YAML"、"把文件夹里所有 JPG 转成 WebP"。`dsh-file-convert` 提供四个专用 tool，背后是久经考验的本地库，你只需用自然语言提需求。

- ✅ **本地执行** —— 文件不出机器
- ✅ **不要 API Key、不要服务器、不耗转换 Token**
- ✅ **自然语言友好** —— Agent 调 tool，你直接说话
- ✅ **批量转换**，返回紧凑的结果摘要
- ✅ **失败必有原因** —— 缺依赖 / 不支持的组合 / 输出已存在，每个错误都说明清楚
- ✅ **V0.1 零外部依赖** —— 全部来自 npm 预编译包，装完即用

## V0.1 支持的转换

| 输入 | 可输出 |
| --- | --- |
| PNG、JPG、WEBP | PNG、JPG、WEBP（任意互转） |
| SVG | PNG、JPG、WEBP |
| PDF | PNG、JPG、TXT |
| JSON | YAML、CSV |
| YAML | JSON、CSV |
| CSV | JSON、YAML |

共 18 种转换，`npm install` 后全部可用——暂不需要 Poppler、LibreOffice、FFmpeg。Office（DOCX/PPTX/XLSX→PDF，走 LibreOffice）和音视频（MP4→GIF/MP3，走 FFmpeg）计划在 V0.2/V0.3 提供，届时会在 `list_conversions` 里明确提示缺什么、怎么装。

## 安装

在 DSH profile 中：

```sh
dsh plugin --profile default add dsh-file-convert
```

本地开发安装：

```sh
git clone https://github.com/YOU/dsh-file-convert
cd dsh-file-convert && npm install && npm run build
dsh plugin --profile default add /absolute/path/to/dsh-file-convert
```

重启 DSH（`dsh web` 或你的常规入口）后，四个 tool 自动出现。

## 四个 Tool

### `convert_file` —— 单文件转换

```json
{ "input": "/tmp/report.pdf", "output_format": "png", "dpi": 200 }
```

- 默认输出到源文件同目录、同名换后缀。
- 多页 PDF 会为每一页输出 `<文件名>-<页码>.<后缀>`。
- 输出文件已存在时默认拒绝，需显式 `overwrite: true`。
- 可选参数：`output`、`overwrite`、`quality`（1–100）、`dpi`（PDF/SVG 光栅化）。

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

图片返回尺寸/通道数，数据文件返回记录数。`likelyScanned: true` 提示这可能是扫描件（此类 PDF 的 OCR 属于后续版本）。

### `list_conversions` —— 当前机器的能力清单

列出全部支持的转换；某项不可用时，明确指出缺哪个外部工具并给出安装提示。V0.1 零外部依赖，全部可用。

## 插件配置

| 键 | 默认值 | 说明 |
| --- | --- | --- |
| `quality` | `85` | JPEG/WebP 默认质量（1–100） |
| `dpi` | `150` | PDF 光栅化默认 DPI |
| `timeoutMs` | `120000` | 单次转换的协作式超时（毫秒） |

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
      4 个 tool 注册）                    │
                       ┌─────────────────┼─────────────────┐
                       ↓                 ↓                 ↓
                 ImageConverter     PdfConverter      DataConverter
                    sharp          pdfjs-dist         js-yaml
                 （npm libvips）  @napi-rs/canvas    csv-parse / stringify
```

- **声明式转换矩阵**：每条转换是 converter 上的一行数据（`{ from, to }`），Router 路由、`list_conversions`、依赖检查全部由此推导。
- **格式识别**：magic bytes 优先（file-type + SVG 嗅探），扩展名兜底；两者冲突以内容为准并给出 warning。
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

- **V0.2 —— 音视频（FFmpeg）**：MP4→GIF、MP4→MP3、WAV→MP3、MOV→MP4；按目标体积自动压缩的 `optimize_file`。
- **V0.3 —— Office（LibreOffice）**：DOCX/PPTX/XLSX→PDF；PDF→DOCX（实验性，OCR 参数位已预留）。
- 更远：页码范围选择、转换链（PPTX→PDF→PNG）、更多图片选项（缩放、旋转）。

## 许可

[MIT](./LICENSE)。dsh-file-convert 不分发任何外部二进制；运行时依赖库（sharp、pdfjs-dist、@napi-rs/canvas、js-yaml、csv）由用户从 npm 安装，各归其许可。
