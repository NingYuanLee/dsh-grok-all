import z from '@deepseek-ai/schemastery';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { normalizeBaseURL, readCatalog, chatModels } from './catalog.js';
import { buildChatAdapter } from './adapter.js';
import { MediaManager } from './media.js';

export const name = 'grok-all';
export const inject = ['llm', 'credentials', 'tools'];
export const Config = z.object({
  connection: z.object({
    baseURL: z.string().default('http://127.0.0.1:8317/v1'),
    apiKeyEnv: z.string().role('credential-ref').default('GROK_ALL_API_KEY'),
    timeoutMs: z.number().min(1000).max(600000).default(60000),
  }).default({}).volatile(),
  media: z.object({
    imageModel: z.string().default('grok-imagine-image-2.0'),
    videoModel: z.string().default('grok-imagine-video-1.5'),
    speechModel: z.string().default('grok-tts'),
    dataDir: z.string().default(''),
  }).default({}).volatile(),
  modelOverrides: z.array(z.object({
    id: z.string().required(),
    category: z.union(['chat', 'image', 'video', 'speech', 'research', 'unknown']).required(),
    contextWindow: z.number().min(1).step(1),
    maxTokens: z.number().min(1).step(1),
  })).default([]).volatile(),
});

const ownerOf = exec => {
  const owner = exec.agent?.session?.id;
  if (typeof owner !== 'string' || !owner) throw new Error('媒体工具需要有归属的 dsh 会话');
  return owner;
};
const jsonOutput = { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] };

export async function apply(ctx, config) {
  let catalog = [], registration, lastError = null, closed = false, refreshPromise;
  const abort = new AbortController();
  const managers = new Map();
  const connection = () => config.connection.get();
  const mediaConfig = () => config.media.get();
  const dataDir = () => resolve(mediaConfig().dataDir || resolve(process.env.DSH_HOME || resolve(homedir(), '.dsh'), 'plugins', 'dsh-grok-all'));
  const resolveKey = async () => {
    const ref = credentialRef(connection().apiKeyEnv);
    const value = (await ctx.credentials.resolve(ref))?.value;
    if (!value?.trim()) throw new Error('Grok 调用密钥未配置，请设置插件的凭据引用');
    return value.trim();
  };
  async function refresh() {
    if (closed) throw new Error('插件已经停止');
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      const captured = structuredClone(connection());
      const baseURL = normalizeBaseURL(captured.baseURL);
      const response = await fetch(baseURL + '/models', { headers: { authorization: 'Bearer ' + await resolveKey() }, redirect: 'error', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(captured.timeoutMs)]) });
      if (!response.ok) throw new Error('模型发现失败：HTTP ' + response.status);
      const reader = response.body?.getReader();
      if (!reader) throw new Error('模型列表响应为空');
      const pieces = []; let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > 2 * 1024 * 1024) throw new Error('模型列表超过限制');
          pieces.push(value);
        }
      } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
      const text = Buffer.concat(pieces, size).toString('utf8');
      const next = readCatalog(JSON.parse(text), config.modelOverrides.get());
      if (closed || JSON.stringify(captured) !== JSON.stringify(connection())) throw new Error('连接已更改，请重新刷新');
      const models = chatModels(next);
      if (models.length) {
        const adapter = buildChatAdapter(ctx, { displayName: 'Grok All', api: 'openai-completions', baseURL, apiKeyEnv: captured.apiKeyEnv, models, compat: { thinkingFormat: 'openai', maxTokensField: 'max_tokens' } });
        // Build the next snapshot before removing a healthy registration.
        await adapter.listModels('grok-all');
        registration?.();
        registration = ctx.llm.registerAdapter(['grok-all'], adapter);
      } else { registration?.(); registration = undefined; }
      catalog = next;
      lastError = null;
      await mkdir(dataDir(), { recursive: true, mode: 0o700 });
      const target = resolve(dataDir(), 'models.json');
      const temp = target + '.' + randomUUID() + '.tmp';
      await writeFile(temp, JSON.stringify({ updatedAt: new Date().toISOString(), models: catalog }, null, 2), { mode: 0o600 });
      await rename(temp, target);
      return catalog;
    })().catch(error => {
      lastError = error?.name === 'TimeoutError' ? '模型发现超时' : error?.message?.startsWith('模型') ? error.message : '模型发现失败，请检查连接、密钥或模型覆盖配置';
      throw new Error(lastError);
    }).finally(() => { refreshPromise = undefined; });
    return refreshPromise;
  }
  async function manager() {
    const c = connection();
    const baseURL = normalizeBaseURL(c.baseURL);
    const identity = JSON.stringify([baseURL, c.apiKeyEnv, dataDir(), c.timeoutMs]);
    if (!managers.has(identity)) {
      // A changed endpoint gets separate task storage; remote IDs cannot be polled
      // against a different server by accident.
      const ready = (async () => {
      const instance = new MediaManager({ baseURL, resolveKey: async () => {
        const hit = await ctx.credentials.resolve(credentialRef(c.apiKeyEnv));
        if (!hit?.value) throw new Error('Grok 调用密钥未配置');
        return hit.value;
      }, dataDir: resolve(dataDir(), 'connections', createHash('sha256').update(JSON.stringify([baseURL, c.apiKeyEnv, dataDir()])).digest('hex').slice(0,16)), timeoutMs: c.timeoutMs });
      await instance.init();
      return instance;
      })();
      managers.set(identity, ready);
      ready.catch(() => managers.delete(identity));
    }
    return managers.get(identity);
  }
  function requireModel(model, category) {
    if (!catalog.some(x => x.id === model && x.category === category)) throw new Error('模型未发现或类别不匹配，请先用 grok_models 刷新，必要时在插件设置中覆盖类别');
    return model;
  }
  function tool(toolName, description, parameters, run) {
    ctx.tools.register(defineTool({ name: toolName, description, parameters, output: jsonOutput,
      async execute(args, exec) { return run(args, exec); },
    }));
  }
  const idParam = { task_id: { type: 'string', required: true, description: 'Task ID returned by a Grok media tool.' } };
  tool('grok_models', 'Refresh or list Grok models grouped by capability. Discovery is not proof of availability. Use after changing plugin connection settings.', { refresh: { type: 'boolean' } }, async args => {
    if (args.refresh || !catalog.length) { try { await refresh(); } catch {} }
    return { models: catalog, error: lastError };
  });
  tool('grok_generate_image', 'Generate images through Grok Imagine and save results locally. Costs account usage. Do not repeat after uncertain submission; inspect the task instead.', {
    prompt: { type: 'string', required: true }, model: { type: 'string' }, n: { type: 'integer' },
  }, async (args, exec) => (await manager()).image({ ...args, model: requireModel(args.model || mediaConfig().imageModel, 'image') }, ownerOf(exec), AbortSignal.any([exec.signal, abort.signal])));
  tool('grok_generate_video', 'Submit a Grok video task. Use grok_media_status to poll the existing task until saved. Never resubmit just because generation is slow.', {
    prompt: { type: 'string', required: true }, model: { type: 'string' }, duration: { type: 'integer' },
  }, async (args, exec) => (await manager()).video({ ...args, model: requireModel(args.model || mediaConfig().videoModel, 'video') }, ownerOf(exec), AbortSignal.any([exec.signal, abort.signal])));
  tool('grok_speak', 'Convert text to speech using Grok TTS and save the audio locally. This is not speech recognition or live voice chat.', {
    input: { type: 'string', required: true }, model: { type: 'string' }, voice: { type: 'string' },
  }, async (args, exec) => (await manager()).speech({ ...args, model: requireModel(args.model || mediaConfig().speechModel, 'speech') }, ownerOf(exec), AbortSignal.any([exec.signal, abort.signal])));
  tool('grok_media_status', 'Query an existing Grok video task, save finished results, or inspect image/audio download state. This does not create another generation.', idParam,
    async (args, exec) => (await manager()).poll(args.task_id, ownerOf(exec), AbortSignal.any([exec.signal, abort.signal])));
  tool('grok_media_retry_download', 'Retry saving already generated media. Does not resubmit generation or spend a new generation request.', idParam,
    async (args, exec) => (await manager()).retryDownload(args.task_id, ownerOf(exec), AbortSignal.any([exec.signal, abort.signal])));
  tool('grok_media_list', 'List media tasks owned by the current conversation, including saved results and recoverable failures.', {},
    async (_args, exec) => (await manager()).list(ownerOf(exec)));
  ctx.on('loader/volatile-update', () => {
    registration?.(); registration = undefined; catalog = [];
    void (async () => { if (refreshPromise) await refreshPromise.catch(() => {}); if (!closed) await refresh(); })().catch(() => {});
  });
  ctx.on('dispose', () => { closed = true; abort.abort(); registration?.(); });
  // A missing credential must not prevent installation or settings repair.
  await refresh().catch(() => {});
}
