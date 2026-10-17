import { defineTool } from '@deepseek-ai/dsh-tools';

export const name = 'Grok Imagine';
export const packageName = 'dsh-grok-byapi';
export const inject = ['grok-byapi', 'tools'];

const ownerOf = exec => {
  const owner = exec.agent?.session?.id;
  if (typeof owner !== 'string' || !owner) throw new Error('媒体工具需要有归属的 dsh 会话');
  return owner;
};
const jsonOutput = { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] };

export async function apply(ctx) {
  const runtime = ctx['grok-byapi']?.runtime || ctx.get('grok-byapi')?.runtime;
  if (!runtime) throw new Error('Grok Imagine 需要先启用 Grok ByAPI');
  const signalOf = exec => AbortSignal.any([exec.signal, runtime.abort?.signal].filter(Boolean));
  const disposers = [];
  const tool = (toolName, description, parameters, run) => {
    const definition = { name: toolName, parameters, output: jsonOutput, async execute(args, exec) { return run(args, exec); } };
    Object.defineProperty(definition, 'description', { enumerable: true, get: () => (typeof description === 'function' ? description() : description) });
    disposers.push(ctx.tools.register(defineTool(definition)));
  };
  const idParam = { task_id: { type: 'string', required: true, description: '任务 ID：由 grok_generate_video 或 grok_generate_image / grok_speak 返回的 id 字段（UUID）' } };

  tool('grok_generate_image', () => '用 Grok Imagine 生成图片并保存到本地。任何聊天模型都可以调用，不要求当前对话模型是 Grok。用户说“画一张/生成图片/出图/做个海报/给我一张…”这类请求时用这个工具。'
    + '参数：prompt（必填）= 画面描述，最长 60000 字符；model（可选）= 图片模型 ID，当前可选：' + runtime.describeModels('image') + '，省略则用插件设置里的默认图片模型；n（可选）= 一次生成几张，取值 1–4，默认 1。'
    + '一次调用同步完成生成与保存。返回的 files[].path 是本地文件路径。status 不是 saved 时先用 grok_media_status 查原任务，不要重新生成。',
  { prompt: { type: 'string', required: true, description: '画面描述（主体、风格、构图、比例等），最长 60000 字符' },
    model: { type: 'string', description: '图片模型 ID，来自 grok_models 的 image 类；省略用插件默认' },
    n: { type: 'integer', description: '生成张数，1–4，默认 1' } },
  async (args, exec) => (await runtime.manager()).image({ ...args, model: runtime.requireModel(args.model || runtime.mediaConfig().imageModel, 'image') }, ownerOf(exec), signalOf(exec)));

  tool('grok_generate_video', () => '提交 Grok 视频生成任务。任何聊天模型都可以调用。用户说“生成视频/做个视频”时用这个工具。'
    + '参数：prompt（必填）最长 60000 字符；model（可选）当前可选：' + runtime.describeModels('video') + '；duration（可选）= 时长秒数，取值 1–15，默认 2。'
    + '提交后用 grok_media_status(task_id) 查询，直到 saved 或 failed。status=submission-unknown 时不要重新提交。',
  { prompt: { type: 'string', required: true, description: '视频内容描述（画面、运动、镜头），最长 60000 字符' },
    model: { type: 'string', description: '视频模型 ID，来自 grok_models 的 video 类；省略用插件默认' },
    duration: { type: 'integer', description: '时长秒数，1–15，默认 2' } },
  async (args, exec) => (await runtime.manager()).video({ ...args, model: runtime.requireModel(args.model || runtime.mediaConfig().videoModel, 'video') }, ownerOf(exec), signalOf(exec)));

  tool('grok_speak', () => '用 Grok TTS 把文字转成语音并保存为 mp3。任何聊天模型都可以调用。用户说“念一下/读出来/配音”时用这个工具。'
    + '参数：input（必填）最长 60000 字符；model（可选）当前可选：' + runtime.describeModels('speech') + '；voice（可选）= 音色名。'
    + '一次调用同步完成合成与保存，files[].path 是本地 mp3 路径。本工具不做语音转文字。',
  { input: { type: 'string', required: true, description: '要朗读的文本，最长 60000 字符' },
    model: { type: 'string', description: '语音模型 ID，来自 grok_models 的 speech 类；省略用插件默认' },
    voice: { type: 'string', description: '音色名；省略用服务端默认' } },
  async (args, exec) => (await runtime.manager()).speech({ ...args, model: runtime.requireModel(args.model || runtime.mediaConfig().speechModel, 'speech') }, ownerOf(exec), signalOf(exec)));

  tool('grok_media_status', '查询某个媒体任务的状态，并在结果已生成时把它下载保存到本地。视频生成后必须用这个工具取回结果。返回 status：generating、saved、failed、submission-unknown、download-failed。不会发起新的生成、不计费。',
    idParam, async (args, exec) => (await runtime.manager()).poll(args.task_id, ownerOf(exec), signalOf(exec)));
  tool('grok_media_retry_download', '重试下载并保存已生成的结果（status=download-failed）。不会重新生成、不计费。',
    idParam, async (args, exec) => (await runtime.manager()).retryDownload(args.task_id, ownerOf(exec), signalOf(exec)));
  tool('grok_media_list', '列出本轮会话创建过的所有媒体任务。无参数。',
    {}, async (_args, exec) => (await runtime.manager()).list(ownerOf(exec)));

  ctx.on('dispose', () => { for (const dispose of disposers.splice(0)) { try { dispose(); } catch { /* 已注销 */ } } });
}
