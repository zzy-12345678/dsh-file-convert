# 稳定版使用约定 / Stable support policy

## 支持基线

`dsh-file-convert` **1.0.x** 保留原稳定基线；**1.1.x** 新增 0.2.2-rc.1；**1.2.x** 新增 0.2.2-rc.3，并保留全部旧基线：

| 组件 | 基线（1.0.x、1.1.x、1.2.x） | 基线（1.1.x、1.2.x） | 新增基线（1.2.x） |
| --- | --- | --- | --- |
| DeepSeek Harness Desktop | **0.2.1-rc.5** | **0.2.2-rc.1** | **0.2.2-rc.3** |
| `@deepseek-ai/dsh-tools` | **0.2.1-rc.5** | **0.2.2-rc.1** | **0.2.2-rc.3** |
| `@deepseek-ai/cordis` | **4.0.5** | **4.1.0** | **4.1.0** |
| 插件配置的 `@deepseek-ai/schemastery` | **3.18.5** | **3.18.5**（Standard Schema 接口） | **3.18.5**（Standard Schema 接口） |
| Node.js | `^22.19.0 \|\| >=24.0.0` | 同左 | 同左 |

1.0.x 补丁修复保持原 DSH 基线；1.1.x 和 1.2.x 明确列出已验证的 dsh-tools 和 Cordis 版本组合，不使用宽泛范围覆盖未知 rc。新旧完整 peer 依赖图分别构建与测试（`npm run test:compat` 在隔离目录中回归 0.2.1-rc.5 与 0.2.2-rc.1 两个旧图，常规 CI 使用 0.2.2-rc.3 新图）。dsh-tools 仍使用各自运行时配套的 Schemastery；插件自身的配置通过 Standard Schema 接口由各版 Cordis 校验。保留 `defineTool` 参数校验和 DSH 的兼容性检查，不通过 `allow-version` 声称支持未知宿主。

「稳定」针对本插件的版本与支持约定，不能把 DSH 的 rc 版本变成官方稳定版本，也不代表永久无缺陷或承诺无限期维护。

## 安装与更新

确认 DSH Desktop 为 **0.2.1-rc.5、0.2.2-rc.1 或 0.2.2-rc.3**，完全退出桌面端及托盘后，用 DSH 自带 CLI 执行：

```sh
dsh plugin --profile desktop add dsh-file-convert@1.2.0 --save-exact
```

自定义 profile 请把 `desktop` 改为实际名称。精确版本避免继续使用旧的版本范围。只需保留 0.2.1-rc.5 旧宿主稳定基线时，可继续固定安装 `dsh-file-convert@1.0.0`。安装成功后重新启动 DSH。

pnpm 的 `minimumReleaseAge` 可能暂时过滤刚发布的版本。当前 DSH 内置 pnpm 在明确指定版本时可自动添加仅针对该版本的 `minimumReleaseAgeExclude`；若本机策略要求确认或不允许例外，按提示处理或等待策略窗口结束。此例外只影响发布时间，不豁免宿主兼容性；不要全局关闭策略。

1.2.0 增加 DSH 0.2.2-rc.3 宿主适配；dsh-tools 0.2.2-rc.1 到 0.2.2-rc.3 的公开类型变更均为增量（新增 guard 拒绝结构与上下文错误类型），`defineTool` 与工具定义契约未变，无需迁移插件配置或转换文件。

## 保持可恢复

升级前，在 DSH 完全退出时备份 `%USERPROFILE%\.dsh\profiles\desktop`，保留原 DSH Desktop 安装程序和版本记录。profile 可能包含凭证，备份应放在私有位置；迁移到其他机器时需重新安装适配该系统的原生依赖。

保留已验证的宿主版本，检查宿主自身的更新设置，避免未经验证直接覆盖工作环境。请勿单独升级 profile 中由宿主提供的 DSH 包。验证新宿主时，使用独立的测试环境和 profile 备份。

如需将插件恢复为先前验证过的版本，退出 DSH 后执行：

```sh
dsh plugin --profile desktop add dsh-file-convert@0.5.2 --save-exact
```

0.5.2 和 1.0.x 的回退仅适用于 DSH Desktop 0.2.1-rc.5，不能在 0.2.2-rc.1 或 0.2.2-rc.3 上使用。如同时升级过宿主，需一并恢复匹配的宿主和 profile，不能只退插件。

## English

The **1.0.x** line retains **DSH Desktop 0.2.1-rc.5**, dsh-tools **0.2.1-rc.5** and Cordis **4.0.5**. **1.1.x** additionally supports **DSH Desktop 0.2.2-rc.1** with dsh-tools **0.2.2-rc.1** and Cordis **4.1.0**. **1.2.x** additionally supports **DSH Desktop 0.2.2-rc.3** with dsh-tools **0.2.2-rc.3**, on the same Cordis **4.1.0**. These are explicit peer-version branches, with separate full runtime build/test runs: `npm run test:compat` re-verifies both older graphs (0.2.1-rc.5 and 0.2.2-rc.1) in isolated directories, while normal CI uses the 0.2.2-rc.3 graph. The plugin's Schemastery **3.18.5** config is validated through Standard Schema on all supported Cordis versions. `defineTool` validation and host compatibility checks remain enabled. Other hosts require separate verification.

Exit DSH, then install with `dsh plugin --profile desktop add dsh-file-convert@1.2.0 --save-exact`. Replace `desktop` for custom profiles. Keeping 1.0.0 on the older supported host remains valid. pnpm release-age policies may require a narrow exact-version exception or waiting; this is separate from host compatibility.

Keep a private backup of the stopped profile, the matching desktop installer and version records. Profiles can contain credentials. To roll back on the same supported host, exit DSH and install `dsh-file-convert@0.5.2 --save-exact` through the same CLI. Restore the host as well if it was upgraded. 0.5.2 and 1.0.x rollbacks apply only to DSH Desktop 0.2.1-rc.5, not to 0.2.2-rc.1 or 0.2.2-rc.3. External tools, model services and operating systems retain their own lifecycle; the stable plugin version is not a promise of indefinite maintenance or compatibility with future DSH releases.
