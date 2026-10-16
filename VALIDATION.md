# 验收记录

日期：2026-10-16。开发版：`0.1.0-alpha.1`。环境：Windows、Node.js 24、DeepSeek Harness `0.2.0-rc.2`、CLIProxyAPI `v8.0.30`。

## 已通过

- 11 项自动测试：模型分类、手动覆盖、地址校验、官方适配器工具调用往返、图片自动保存、下载失败后的重启恢复、视频原任务恢复、跨会话隔离、提交未知不重发、TTS 保存、无效输入与错误媒体拒绝。
- 独立 headless profile：原生 `grok-all` 提供方实际聊天成功。
- 独立 headless profile：模型实际调用 `grok_models` 工具并继续回答成功。发现 20 个模型：chat 11、image 3、video 3、speech 2、research 1；未声称每个模型都已可用性验证。
- 独立 headless profile：调用图片工具，真实生成 1 张 JPEG 并自动保存本地。
- 媒体模块真实请求：TTS 返回 MP3 并保存；2 秒视频提交、查询至 `done`/100%，下载保存为 MP4，插件状态为 `saved`。
- 独立 Web profile：前端实际加载；聊天选择器显示 Grok All 分组，只有 11 个聊天模型，没有图片、视频和 TTS。
- 独立 Web profile：插件详情的配置入口、字段显示与保存成功。真实将测试 profile 的超时改为 31000ms 并回读确认。
- 独立 Web profile：工具调用记录展开后，专用 Grok 模型卡片显示 20 个模型的分类。
- 独立 Web profile：通过 dsh 文件交付打开本地 MP4 与 MP3，在插件侧栏播放器点击播放。视频时长 2.041667 秒、音频时长 2.928 秒，均实际播放至结束，readyState=4，媒体 error=null。

## 安装路径复核（2026-10-16，独立环境）

在另一台环境按发布路径重新走通，并把结果用于修复打包缺陷：

- 仅用提交内容的干净克隆 → `npm install --ignore-scripts` 11.4 秒装好 118 个包（全部来自公共 registry）→ 11 项测试通过 → `npm run build` 产物与仓库一致。
- 隔离 `DSH_HOME` 的全新 profile：`dsh plugin add <源码目录>` 0.7 秒完成，自动写入该 profile 的 `dsh.profile.bundles`，不需要手工编辑。
- `npm pack` 产物（模拟已发布包）：`dsh plugin add <tgz>` 后启动成功，插件页显示组件 `grok-all` 运行中，客户端 bundle 正常加载并被 GUI 请求，配置页 8 个字段可读可存，聊天选择器出现 11 个 chat 模型，图片、视频、TTS 未混入。
- `npm publish --dry-run --tag alpha` 通过：`prepublishOnly` 先跑测试与语法检查，再打包。未真正发布。
- 公网仓库安装（提交 `4e96636`、标签 `v0.1.0-alpha.1`）：`dsh plugin add "git+https://github.com/NingYuanLee/dsh-grok-all.git"` 5.8 秒完成，插件组件运行中，客户端 bundle 被 GUI 请求，聊天选择器出现 11 个 chat 模型。
- 本次修复：补 `LICENSE` 与 `license`/`author`/`homepage`；适配器注册失败的真实原因不再被通用提示覆盖并写入 warn 日志；`@deepseek-ai/dsh-llm` 由隐式依赖改为显式 devDependency；新增 `.gitattributes` 固定 LF；CI 增加 Windows 矩阵与发布门禁；测试断言捕获到的是官方 `LlmAdapter` 实例与 `providerInfo`。

## 当前限制与待验收

- 真实请求测试走本地网关；未逐项测试公网媒体接口、极大文件或超时边界。
- 桌面应用中的媒体播放尚未单独验收；已验收独立 Web profile。
- 使用完整字节的侧栏预览，非大视频流式播放；编解码和大小限制取决于 dsh 与浏览器。
- 视频查询由工具显式触发，无自动后台轮询、自动完成通知或持续刷新的任务中心。
- 任务模块支持进程重启后的显式恢复；没有实现多个 Host 进程同时操作同一数据目录的跨进程锁。
- 图片编辑、视频编辑/延长、语音识别、实时语音、直接 OAuth 尚未实现。
- 上游未提供完整能力元数据；规则识别不是端到端验证。特别是历史模型和研究类模型，不保证与普通 Agent 工具兼容。
- 仅验证指定 dsh 版本。聊天协议复用官方适配器，并捕获其公开入口构建的适配器实例；依赖其注册约定，升级时必须重跑集成测试。
- 未安装到日常 desktop profile；未迁移旧 `local-grok`；npm 账号注册受阻，发布到 npm 推迟，当前以仓库安装分发。

## 不公开的测试材料

独立 profile、日志、凭据引用的运行环境和生成物均位于被忽略的本地测试目录。调用密钥不进入源代码、仓库、任务公开结果或第三方媒体下载请求。
