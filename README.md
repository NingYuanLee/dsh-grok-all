# dsh-grok-byapi

Native Grok integration for DeepSeek Harness: model discovery, chat, image/video generation, TTS and durable local media tasks.

在 dsh 中统一使用 Grok：原生聊天提供方、自动分类模型、媒体生成和持久任务。

**Early alpha / 早期开发版：`0.2.0-alpha.1`。尚未发布 npm 包，当前从仓库安装（见下）。先使用独立测试 profile。实际验证情况见 [VALIDATION.md](VALIDATION.md)，逐版变更见 [CHANGELOG.md](CHANGELOG.md)。**

## 定位与功能

安装一个插件，配置一套网关连接。聊天选择器只显示聊天模型；图片、视频、TTS 由对应工具调用。聊天模型调用媒体工具，无需切换成 Imagine 或 TTS。

第一版连接用户运行的兼容网关，优先适配 CLIProxyAPI 的 `/v1` 接口，不共享或读取 Grok CLI 的 OAuth 刷新令牌。不提供账号、模型服务或免费额度。名称表示通过 API 接入，不表示已支持 Grok 官网全部产品功能。

| 功能 | 当前实现范围 |
| --- | --- |
| 模型目录 | `/models` 自动发现，分类为聊天、图片、视频、TTS、研究或未知，支持覆盖 |
| 聊天提供方 | `xAI-CLIProxyAPI` 路由，复用 dsh 官方 pi-ai 适配器处理流式响应与工具调用 |
| 图片 | `grok_generate_image` 生成并保存 |
| 视频 | `grok_generate_video` 提交，`grok_media_status` 查询并保存 |
| 语音 | `grok_speak` 文字转语音并保存 |
| 任务 | `grok_media_list`、`grok_media_retry_download`，会话隔离与持久记录 |
| 展示 | 工具结果卡片；点击文件进入预览；MP4、MP3、WAV 侧栏播放器 |
| 设置 | 插件详情页维护连接、密钥、对话模型与媒体模型；对话模型表格即聊天选择器名单 |

类别识别不等于验证可用，未知模型不自动进入聊天选择器。工具卡片显示该次调用记录，新视频状态需要再次查询。

**尚未实现：** 图片编辑、视频编辑/延长、自动后台轮询和完成通知、实时任务面板、语音识别、实时通话、直接 OAuth。实施方案见 [PLAN.md](PLAN.md)。

## 安装与配置

兼容目标：dsh `>=0.2.0-rc.2 <0.3.0`、Node.js `>=22.19.0`。dsh 加载插件时以 `engines.dsh` 判定兼容性（预发布版本参与比较），`peerDependencies` 只声明源码用到的 `@deepseek-ai/dsh-*` SDK 范围、不参与该门禁。自动测试基于 dsh `0.2.0-rc.2` 的 SDK；本版已在 dsh `0.2.1-rc.1` 桌面 profile 实际加载并调用工具，其他 0.2.x 版本尚未逐个验收。npm 账号注册受阻，「发布到 npm」已推迟，`npm install dsh-grok-byapi` 目前不可用。

**方式一：从仓库安装（推荐，不需要 npm 账号）**

```powershell
dsh --profile grok-byapi-test --from-default-profile web --dump-config
dsh plugin --profile grok-byapi-test add "git+https://github.com/NingYuanLee/dsh-grok-byapi.git"
```

**方式二：本地源码调试**

```powershell
git clone https://github.com/NingYuanLee/dsh-grok-byapi.git
cd dsh-grok-byapi
npm install --ignore-scripts
dsh --profile grok-byapi-test --from-default-profile web --dump-config
dsh plugin --profile grok-byapi-test add "$PWD"
```

`--dump-config` 只创建 profile 目录并打印组合后的配置，不启动服务。`dsh plugin add` 会自动把插件写进该 profile 的 `dsh.profile.bundles`，不需要手动编辑；卸载用 `dsh plugin --profile grok-byapi-test remove dsh-grok-byapi`。需要固定版本时，把仓库地址写成 `git+https://github.com/NingYuanLee/dsh-grok-byapi.git@<commit>`，或用 `npm pack` 产物安装。

在该 profile 的 `cordis.patch.yml` 添加配置覆盖：

```yaml
- id: grok-byapi
  name: dsh-grok-byapi
  config:
    connection:
      baseURL: http://127.0.0.1:8317/v1
      api: openai-responses
      apiKeyEnv: GROK_ALL_API_KEY
      timeoutMs: 60000
    media:
      imageModel: grok-imagine-image-2.0
      videoModel: grok-imagine-video-1.5
      speechModel: grok-tts
      dataDir: ''
```

调用密钥存入 dsh 凭据服务，或在启动进程的 `GROK_ALL_API_KEY` 环境变量提供。配置只填凭据引用，也可使用已有引用名称。不要把密钥写入 YAML 或仓库。连接和媒体字段可供 dsh 插件设置编辑。

旧版配置里的 `media.defaultModel` 已废弃：残留不影响启动，在设置页保存一次对话模型或媒体模型后会被清掉。

```powershell
dsh --profile grok-byapi-test --no-open
```

聊天模型选择 **Grok** 下的模型；`grok_models` 查看分类或刷新。设置页里「对话模型」表格就是选择器内容，删掉行并保存后该模型从选择器消失；媒体模型选中 ID 即启用。公网使用自己的 HTTPS 网关地址；`127.0.0.1` 指 dsh Host 所在电脑。

## 任务与文件

- 创建请求不自动重试；提交超时标为未知，不盲目重复生成。
- 视频保留原任务 ID；用查询工具获取进度并保存结果。
- 临时结果及时下载，先写 `.part`，校验完成后改正式文件。
- 下载失败使用重试下载工具，不重新生成。
- 当前会话只看到自己的任务；重启保留记录。
- 默认目录是 dsh home 下 `plugins/dsh-grok-byapi`，按连接和任务隔离，可改 `media.dataDir`。
- 第三方媒体下载不携带网关密钥。任务记录可能保存签名 URL，请视为私有数据，不公开同步。
- 文件删除、链接过期可能无法恢复。播放器加载完整字节，大文件受 dsh 预览限制，可用系统应用打开。

## 许可证

MIT，见 [LICENSE](LICENSE)。Copyright (c) 2026 NingYuanLee。

## 开发与社区

```powershell
npm test        # 50 项自动测试
npm run check
npm run build   # 由 src/client.js 重新生成 lib/client.js
npm pack --dry-run
```

CI 在 Linux 与 Windows 上跑测试、语法检查、构建，并要求 `lib/client.js` 与构建产物一致。npm 发布待账号可用后进行：`package.json` 的 `publishConfig` 已把目标固定为官方 registry 与 `alpha` 标签，届时 `npm login` 后 `npm publish` 即可。离线分发用 `npm pack` 产物，用户侧 `dsh plugin add <tgz>` 实测可安装。

待办见 [ROADMAP.md](ROADMAP.md)。仓库按 [dsh 官方社区指引](https://github.com/deepseek-ai/deepseek-harness#community-and-support) 添加 `dsh-plugin` Topic；欢迎通过 Issues 反馈。

Third-party community project, not an official DeepSeek or xAI product. 非 DeepSeek 或 xAI 官方产品。npm 包名尚未发布或保留。
