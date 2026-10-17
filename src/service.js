import { Service } from '@deepseek-ai/cordis';

// 聊天行持有连接、模型目录和媒体任务。多媒体行只消费这个服务，
// 所以生图、视频和语音工具不绑死在 Grok 聊天模型上。
export class GrokRuntime extends Service {
  constructor(ctx, runtime) {
    super(ctx, 'grok-byapi');
    this.runtime = runtime;
  }
}
