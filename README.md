# dsh-grok-all

Native Grok integration for DeepSeek Harness: model discovery, chat, image/video generation, TTS and durable local media tasks.

在 dsh 中统一使用 Grok：原生聊天提供方、自动分类模型、媒体生成和持久任务。

**Early alpha / 早期开发版。尚未发布 npm 包，当前从仓库安装（见下）。先使用独立测试 profile。实际验证情况见 [VALIDATION.md](VALIDATION.md)。**

## 定位与功能

安装一个插件，配置一套网关连接。聊天选择器只显示聊天模型；图片、视频、TTS 由对应工具调用。聊天模型调用媒体工具，无需切换成 Imagine 或 TTS。

第一版连接用户运行的兼容网关，优先适配 CLIProxyAPI 的 `/v1` 接口，不共享或读取 Grok CLI 的 OAuth 刷新令牌。不提供账号、模型服务或免费额度。“all”是逐步覆盖能力的目标，不表示已支持 Grok 官网全部产品功能。

| 功能 | 当前实现范围 |
| --- | --- |
| 模型目录 | `/models` 自动发现，分类为聊天、图片、视频、TTS、研究或未知，支持覆盖 |
| 聊天提供方 | `grok-all` 路由，复用 dsh 官方 pi-ai 适配器处理流式响应与工具调用 |
| 图片 | `grok_generate_image` 生成并保存 |
| 视频 | `grok_generate_video` 提交，`grok_media_status` 查询并保存 |
| 语音 | `grok_speak` 文字转语音并保存 |
| 任务 | `grok_media_list`、`grok_media_retry_download`，会话隔离与持久记录 |
| 展示 | 工具结果卡片；点击文件进入预览；MP4、MP3、WAV 侧栏播放器 |

类别识别不等于验证可用，未知模型不自动进入聊天选择器。工具卡片显示该次调用记录，新视频状态需要再次查询。

**尚未实现：** 图片编辑、视频编辑/延长、自动后台轮询和完成通知、实时任务面板、语音识别、实时通话、直接 OAuth。实施方案见 [PLAN.md](PLAN.md)。

## 安装与配置

兼容目标：dsh `0.2.0-rc.2`、Node.js `>=22.19.0`。其他版本尚未承诺兼容。npm 账号注册受阻，「发布到 npm」已推迟，`npm install dsh-grok-all` 目前不可用。

**方式一：从仓库安装（推荐，不需要 npm 账号）**

```powershell
dsh --profile grok-all-test --from-default-profile web --dump-config
dsh plugin --profile grok-all-test add "git+https://github.com/NingYuanLee/dsh-grok-all.git"
```

**方式二：本地源码调试**

```powershell
git clone https://github.com/NingYuanLee/dsh-grok-all.git
cd dsh-grok-all
npm install --ignore-scripts
dsh --profile grok-all-test --from-default-profile web --dump-config
dsh plugin --profile grok-all-test add "$PWD"
```

`--dump-config` 只创建 profile 目录并打印组合后的配置，不启动服务。`dsh plugin add` 会自动把插件写进该 profile 的 `dsh.profile.bundles`，不需要手动编辑；卸载用 `dsh plugin --profile grok-all-test remove dsh-grok-all`。

在该 profile 的 `cordis.patch.yml` 添加配置覆盖：

```yaml
- id: grok-all
  name: dsh-grok-all
  config:
    connection:
      baseURL: http://127.0.0.1:8317/v1
      apiKeyEnv: GROK_ALL_API_KEY
      timeoutMs: 60000
    media:
      imageModel: grok-imagine-image-2.0
      videoModel: grok-imagine-video-1.5
      speechModel: grok-tts
      dataDir: ''
```

调用密钥存入 dsh 凭据服务，或在启动进程的 `GROK_ALL_API_KEY` 环境变量提供。配置只填凭据引用，也可使用已有引用名称。不要把密钥写入 YAML 或仓库。连接和媒体字段可供 dsh 插件设置编辑。

```powershell
dsh --profile grok-all-test --no-open
```

聊天模型选择 **Grok All** 下的模型；`grok_models` 查看分类或刷新。公网使用自己的 HTTPS 网关地址；`127.0.0.1` 指 dsh Host 所在电脑。

## 任务与文件

- 创建请求不自动重试；提交超时标为未知，不盲目重复生成。
- 视频保留原任务 ID；用查询工具获取进度并保存结果。
- 临时结果及时下载，先写 `.part`，校验完成后改正式文件。
- 下载失败使用重试下载工具，不重新生成。
- 当前会话只看到自己的任务；重启保留记录。
- 默认目录是 dsh home 下 `plugins/dsh-grok-all`，按连接和任务隔离，可改 `media.dataDir`。
- 第三方媒体下载不携带网关密钥。任务记录可能保存签名 URL，请视为私有数据，不公开同步。
- 文件删除、链接过期可能无法恢复。播放器加载完整字节，大文件受 dsh 预览限制，可用系统应用打开。

## 许可证

MIT，见 [LICENSE](LICENSE)。Copyright (c) 2026 NingYuanLee。

## 开发与社区

```powershell
npm test
npm run check
npm pack --dry-run
```

npm 发布待账号可用后进行：`package.json` 的 `publishConfig` 已把目标固定为官方 registry 与 `alpha` 标签，届时 `npm login` 后 `npm publish` 即可。离线分发用 `npm pack` 产物，用户侧 `dsh plugin add <tgz>` 实测可安装。

待办见 [ROADMAP.md](ROADMAP.md)。仓库按 [dsh 官方社区指引](https://github.com/deepseek-ai/deepseek-harness#community-and-support) 添加 `dsh-plugin` Topic；欢迎通过 Issues 反馈。

Third-party community project, not an official DeepSeek or xAI product. 非 DeepSeek 或 xAI 官方产品。npm 包名尚未发布或保留。
