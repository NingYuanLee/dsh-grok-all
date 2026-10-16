# dsh-grok-all

Grok integration for DeepSeek Harness: one plugin for model discovery, chat, image and video generation, and text-to-speech.

面向 DeepSeek Harness（dsh）的 Grok 集成插件：统一接入聊天与推理、图片与视频生成、语音合成，并管理生成任务和本地文件。

**Status: planning / early development. No installable plugin or npm release is available yet.**

**当前状态：规划与早期开发。仓库目前只有项目说明和路线图，尚无可安装插件，也未发布 npm 包。下面的功能是开发目标，并非已经实现。**

## 项目目标

- 原生 dsh 提供方：由插件管理连接、凭据和聊天模型，无需逐个配置自定义模型。
- 自动发现模型：区分聊天、图片、视频和语音，保留未知类别与手动覆盖；区分“发现”与“验证可用”。
- 聊天中生成媒体：聊天模型调用图片、视频和语音工具，无需切换聊天模型。
- 持久生成任务：展示真实状态，支持视频任务查询、失败说明和恢复。
- 自动保存生成物：及时下载临时链接，使用本地文件作为持久结果。
- 复用 dsh 能力：凭据、会话、附件、图片预览及文件交付；补充音视频播放展示。

## 接入方式

第一阶段面向兼容的 xAI / OpenAI 风格网关，优先适配 CLIProxyAPI 已实现的聊天、Images、视频任务和 TTS 接口。网关地址和凭据由用户自行配置。

长期目标是逐步覆盖可接入的 Grok 能力。“all”表达项目方向，不保证已经覆盖 Grok 官网的全部产品功能。各接入方式的账号权限、模型能力、额度、参数和接口可能不同，需分别验证。

不附带模型服务、账号或免费额度。不要求将凭据提交到仓库。

## 任务与文件设计

任务阶段包括提交、生成、下载和保存。上游未提供百分比时只显示阶段和已用时。生成成功但下载失败时，应重试下载，而非自动再次生成；提交结果未知时不得盲目重发可能产生费用的请求。

图片、视频和音频结果优先保存为本地文件，再向会话交付。临时 URL 不是最终持久存储。未完成任务应能在重启后恢复查询或下载；上游不提供取消时，“停止等待”不能表示已取消生成。

## 开发与反馈

开发范围与验收计划见 [ROADMAP.md](ROADMAP.md)。欢迎通过本仓库 Issues 提交使用场景和建议。当前不提供安装命令；后续会在可安装版本完成验证后补充兼容版本、安装方法及发布说明。

计划 npm 包名：`dsh-grok-all`。**尚未发布或保留该 npm 名称。**

## 社区发现

按 [DeepSeek Harness 官方 README 的社区指引](https://github.com/deepseek-ai/deepseek-harness#community-and-support)，仓库使用 `dsh-plugin` Topic，便于社区发现。公开与 Topic 不代表官方认证，也不保证第三方目录立即收录。

Third-party community project. Not an official DeepSeek or xAI product.

本项目是第三方社区项目，非 DeepSeek 或 xAI 官方产品。
