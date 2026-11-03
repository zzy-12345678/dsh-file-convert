# 稳定版使用约定 / Stable support policy

## 支持基线

`dsh-file-convert` **1.0.x** 固定支持以下组合：

| 组件 | 支持基线 |
| --- | --- |
| DeepSeek Harness Desktop | **0.2.1-rc.5** |
| `@deepseek-ai/dsh-tools` | **0.2.1-rc.5**，由宿主提供 |
| `@deepseek-ai/cordis` | **4.0.5**，由宿主提供 |
| `@deepseek-ai/schemastery` | **3.18.5**，插件直接依赖 |
| Node.js | `^22.19.0 \|\| >=24.0.0`；当前桌面宿主提供 24.21.0 |

1.0.x 补丁修复保持此 DSH 基线；适配其他宿主需单独验证和决定发布路线。官方发布新版 DSH 不会改变已安装插件，也不要求此基线跟随更新。保留 `defineTool` 参数校验和 DSH 的兼容性检查，不通过放宽 peer 或 `allow-version` 声称支持未知宿主。

「稳定」针对本插件的版本与支持约定，不能把 DSH 的 rc 版本变成官方稳定版本，也不代表永久无缺陷或承诺无限期维护。

## 安装与更新

确认 DSH Desktop 为 **0.2.1-rc.5**，完全退出桌面端及托盘后，用 DSH 自带 CLI 执行：

```sh
dsh plugin --profile desktop add dsh-file-convert@1.0.0 --save-exact
```

自定义 profile 请把 `desktop` 改为实际名称。精确版本避免安装请求继续沿用旧的 `^0.5.0` 范围；`^0.5.0` 本身不会包含 `1.0.0`。安装成功后重新启动 DSH。若插件管理器提供版本输入框，也应填写 `dsh-file-convert@1.0.0`。

pnpm 的 `minimumReleaseAge` 可能暂时过滤刚发布的版本。当前 DSH 内置 pnpm 在明确指定版本时可自动添加仅针对该版本的 `minimumReleaseAgeExclude`；若本机策略要求确认或不允许例外，按提示处理或等待策略窗口结束。此例外只影响发布时间，不豁免宿主兼容性；不要全局关闭策略。

本次是现有 0.5.2 转换实现的稳定基线发布，主要变更为依赖精确固定和支持约定。无需迁移插件配置或转换文件。

## 保持可恢复

升级前，在 DSH 完全退出时备份 `%USERPROFILE%\.dsh\profiles\desktop`，保留原 DSH Desktop 安装程序和版本记录。profile 可能包含凭证，备份应放在私有位置；迁移到其他机器时需重新安装适配该系统的原生依赖。

保留已验证的宿主版本，检查宿主自身的更新设置，避免未经验证直接覆盖工作环境。请勿单独升级 profile 中由宿主提供的 DSH 包。验证新宿主时，使用独立的测试环境和 profile 备份。

如需将插件恢复为先前验证过的版本，退出 DSH 后执行：

```sh
dsh plugin --profile desktop add dsh-file-convert@0.5.2 --save-exact
```

该回退同样适用于 DSH Desktop 0.2.1-rc.5。如同时升级过宿主，需一并恢复匹配的宿主和 profile，不能只退插件。

## 运行边界

现有本地转换不需要等待 DeepSeek 发布新版插件 API，但 DSH 对话仍可能需要模型服务。音视频、Office、OCR 等能力仍需相应外部工具或语言数据；首次安装、显式下载和重新安装也需要相应软件源。固定插件/宿主不等于固定所有系统依赖；系统或外部工具更新应先验证。保留故障修复与安全更新的评估流程。

## English

The **1.0.x** line targets **DSH Desktop 0.2.1-rc.5**, dsh-tools **0.2.1-rc.5**, Cordis **4.0.5** and Schemastery **3.18.5**. Patches retain this host baseline; other hosts require separate verification. A new DSH release does not require updating an installation that keeps this baseline. `defineTool` validation and host compatibility checks remain enabled.

Exit DSH, then install with `dsh plugin --profile desktop add dsh-file-convert@1.0.0 --save-exact`. Replace `desktop` for custom profiles. An old `^0.5.0` range does not include 1.0.0. pnpm release-age policies may require a narrow exact-version exception or waiting; this is separate from host compatibility.

Keep a private backup of the stopped profile, the matching desktop installer and version records. Profiles can contain credentials. To roll back on the same supported host, exit DSH and install `dsh-file-convert@0.5.2 --save-exact` through the same CLI. Restore the host as well if it was upgraded. External tools, model services and operating systems retain their own lifecycle; the stable plugin version is not a promise of indefinite maintenance or compatibility with future DSH releases.
