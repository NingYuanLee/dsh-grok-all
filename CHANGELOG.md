# 更新日志

本文记录面向使用者的变更。版本兼容范围与已验收能力见 [VALIDATION.md](VALIDATION.md)。

## 0.1.0-alpha.1 — 2026-10-16（首次发布）

- 首个开发版：模型目录发现与分类、`grok-all` 原生聊天提供方、图片/视频/TTS 工具、持久任务与本地保存、Web 侧栏音视频播放、插件设置页。
- 补充 MIT 许可证：新增 `LICENSE`、`package.json` 的 `license`/`author`/`homepage`。
- 新增 `.gitattributes` 固定 LF 行尾，避免 Windows 检出后 `lib/client.js` 产物比对出现假差异。
- CI 改为 Linux 与 Windows 双矩阵，并新增 `prepublishOnly` 门禁，发布前必须通过测试与语法检查。
- 官方适配器注册失败时保留原始错误（不再被通用提示覆盖）并写入 `warn` 日志，便于定位 dsh 版本不兼容。
- 测试补全：断言捕获到的适配器是 `@deepseek-ai/dsh-llm` 的 `LlmAdapter` 实例，并校验 `providerInfo` 与 `listModels`。
- `@deepseek-ai/dsh-llm` 由隐式依赖改为显式 `devDependencies`。
- `publishConfig` 固定发布到官方 registry 并使用 `alpha` 标签。
