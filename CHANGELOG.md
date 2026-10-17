# 更新日志

本文记录面向使用者的变更。版本兼容范围与已验收能力见 [VALIDATION.md](VALIDATION.md)。

## 0.2.0-alpha.1 — 2026-10-17（未发布）

设置页交互与配置调整，含一处配置键废弃：

- 对话模型表格就是聊天选择器名单：删掉的行保存后不再被加回；「添加」移到表格下方，与「保存对话模型」同排。
- 移除每行的「默认模型」单选列与 `media.defaultModel` 配置键。旧配置里残留的该键启动时被忽略，保存时自动 `unset`/删除。
- 媒体模型去掉独立的「启用」勾选框：选中模型 ID 即启用，选「不使用」即清空。
- 删除按钮移到每行首列，红字红边，高度与「添加」一致；上下文/最大输出输入框收窄，思考强度摘要改为紧凑单行。
- API 地址为空时回显默认地址，保存时写入同一地址；已保存地址原样回显。
- 依赖声明：peer 依赖由固定 `0.2.0-rc.2` 放宽为 `>=0.2.0-rc.2 <0.3.0`，新增 `engines.dsh`；已在 dsh `0.2.1-rc.1` 桌面 profile 实际加载并调用工具。
- 自动测试由 11 项扩展到 50 项，覆盖上述设置页行为与配置清理。

## 0.1.0-alpha.1 — 2026-10-16（未发布）

- 首个开发版：模型目录发现与分类、`grok-all` 原生聊天提供方、图片/视频/TTS 工具、持久任务与本地保存、Web 侧栏音视频播放、插件设置页。
- 补充 MIT 许可证：新增 `LICENSE`、`package.json` 的 `license`/`author`/`homepage`。
- 新增 `.gitattributes` 固定 LF 行尾，避免 Windows 检出后 `lib/client.js` 产物比对出现假差异。
- CI 改为 Linux 与 Windows 双矩阵，并新增 `prepublishOnly` 门禁，发布前必须通过测试与语法检查。
- 官方适配器注册失败时保留原始错误（不再被通用提示覆盖）并写入 `warn` 日志，便于定位 dsh 版本不兼容。
- 测试补全：断言捕获到的适配器是 `@deepseek-ai/dsh-llm` 的 `LlmAdapter` 实例，并校验 `providerInfo` 与 `listModels`。
- `@deepseek-ai/dsh-llm` 由隐式依赖改为显式 `devDependencies`。
- `publishConfig` 固定发布到官方 registry 并使用 `alpha` 标签。
- npm 账号注册受阻，本版不发 npm：分发走仓库安装（`dsh plugin add git+https://…`）或 `npm pack` 产物（`dsh plugin add <tgz>` 实测可安装）。
