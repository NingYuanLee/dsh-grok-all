import z from '@deepseek-ai/schemastery';
import { credentialRef } from '@deepseek-ai/dsh-credentials';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { randomUUID, createHash } from 'node:crypto';
import { normalizeBaseURL, readCatalog, chatModels, expandPath } from './catalog.js';
import { buildChatAdapter } from './adapter.js';
import { MediaManager } from './media.js';
import { GrokRuntime } from './service.js';

export const name = 'xAI-CLIProxyAPI';
export const packageName = 'dsh-grok-byapi';
export const inject = ['llm', 'credentials', 'tools'];
// 与官方模型配置一致：密钥存在 dsh 凭据库里，配置里只保留这个引用名。
// 设置页写密钥时固定写到该引用，apiKeyEnv 由插件自己维护，用户无需看到。
export const DEFAULT_KEY_REF = 'GROK_ALL_API_KEY';
export const Config = z.object({
  connection: z.object({
    baseURL: z.string().default('http://127.0.0.1:8317/v1'),
    // 直接填写调用密钥（优先于凭据引用）。留空才回退到 apiKeyEnv。
    apiKey: z.string().default(''),
    apiKeyEnv: z.string().role('credential-ref').default(DEFAULT_KEY_REF),
    api: z.union(['openai-completions', 'openai-responses']).default('openai-responses'),
    // 保存设置时先用该密钥验证一次 /models，密钥不对立刻报错。
    verify: z.boolean().default(true),
    timeoutMs: z.number().min(1000).max(600000).default(60000),
  }).default({}).volatile(),
  media: z.object({
    imageModel: z.string().default(''),
    videoModel: z.string().default(''),
    speechModel: z.string().default(''),
    dataDir: z.string().default(''),
  }).default({}).volatile(),
  // 每个模型的显式配置（设置页「获取模型」里改的就是这里）。
  // imageSupported / contextWindow / maxTokens 会覆盖插件自带的已知规则；category 用于纠正分类。
  modelOverrides: z.array(z.object({
    id: z.string().required(),
    category: z.union(['chat', 'image', 'video', 'speech', 'research', 'unknown']),
    displayName: z.string().default(''),
    imageSupported: z.boolean(),
    contextWindow: z.number().min(1).step(1),
    maxTokens: z.number().min(1).step(1),
    reasoningEfforts: z.array(z.union(['none', 'low', 'medium', 'high', 'xhigh'])).default([]),
  })).default([]).volatile(),
});

const jsonOutput = { schema: { type: 'json' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }] };

export async function apply(ctx, config) {
  let catalog = [], registration, directory, lastError = null, closed = false, refreshPromise;
  const abort = new AbortController();
  // 设置命名空间 = 本插件实例在 profile 里的 id（cordis.patch.yml 的 - id:）。
  // 模型弹窗用它把「Grok」这一行对上本插件的配置。
  const instanceId = () => ctx?.fiber?.entry?.options?.id || 'grok-byapi';
  const managers = new Map();
  const connection = () => config.connection.get();
  const mediaConfig = () => config.media.get();
  // 结果保存位置：留空用插件默认目录；~ 与环境变量由 catalog.expandPath 展开。
  const defaultDataDir = () => resolve(process.env.DSH_HOME || resolve(homedir(), '.dsh'), 'plugins', 'dsh-grok-byapi');
  const dataDir = () => resolve(expandPath(mediaConfig().dataDir) || defaultDataDir());
  // 解析调用密钥：插件设置里直接填写的 apiKey 优先；留空则回退到凭据引用。
  const readKey = async (configValue) => {
    const direct = configValue?.apiKey;
    if (typeof direct === 'string' && direct.trim()) return direct.trim();
    const refName = typeof configValue?.apiKeyEnv === 'string' && configValue.apiKeyEnv.trim() ? configValue.apiKeyEnv.trim() : DEFAULT_KEY_REF;
    const value = (await ctx.credentials.resolve(credentialRef(refName)))?.value;
    if (typeof value === 'string' && value.trim()) return value.trim();
    throw new Error('Grok 调用密钥未配置：请在插件设置里填写「API Key」（会存进 dsh 凭据库，引用名 ' + refName + '）');
  };
  const resolveKey = () => readKey(connection());

  // 保存设置后的自检：用当前配置请求一次 /models，密钥或地址不对立刻反馈。
  async function verifyKey() {
    const captured = structuredClone(connection());
    if (!captured.verify) return { verified: false, skipped: true };
    const key = await readKey(captured);
    const baseURL = normalizeBaseURL(captured.baseURL);
    let response;
    try {
      response = await fetch(baseURL + '/models', { headers: { authorization: 'Bearer ' + key }, redirect: 'error', signal: AbortSignal.timeout(Math.min(captured.timeoutMs, 15000)) });
    } catch (error) {
      throw new Error('密钥自检失败：无法连接 ' + baseURL + (error?.name === 'TimeoutError' ? '（超时）' : ''));
    }
    if (response.status === 401 || response.status === 403) throw new Error('密钥自检失败：认证被拒绝（HTTP ' + response.status + '），请核对调用密钥');
    if (!response.ok) throw new Error('密钥自检失败：HTTP ' + response.status + '，请检查 API 地址');
    return { verified: true, status: response.status };
  }
  // 设置页「获取模型」走官方发现：请求里带着草稿地址和一次性密钥，不能去读已保存配置。
  // 返回值必须是模型数组；运行时会丢掉 category 等额外字段，调用方只靠 id / name / 容量。
  async function discover(request, signal) {
    const baseURL = normalizeBaseURL(request?.baseURL || connection().baseURL);
    const key = typeof request?.apiKey === 'string' && request.apiKey.trim() ? request.apiKey.trim() : await resolveKey();
    const signals = [abort.signal, AbortSignal.timeout(connection().timeoutMs)];
    if (signal) signals.push(signal);
    const response = await fetch(baseURL + '/models', { headers: { authorization: 'Bearer ' + key, accept: 'application/json' }, redirect: 'error', signal: AbortSignal.any(signals) });
    if (response.status === 401 || response.status === 403) throw new Error('模型发现失败：认证被拒绝（HTTP ' + response.status + '），请核对 API Key');
    if (!response.ok) throw new Error('模型发现失败：HTTP ' + response.status);
    const next = readCatalog(JSON.parse(await readBounded(response)), config.modelOverrides.get());
    return next.map(model => ({
      id: model.id, name: model.name, contextWindow: model.contextWindow, maxTokens: model.maxTokens,
      inputModalities: model.input, category: model.category,
    }));
  }
  async function readBounded(response) {
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
    return Buffer.concat(pieces, size).toString('utf8');
  }
  async function refresh(signal) {
    if (closed) throw new Error('插件已经停止');
    if (refreshPromise) return refreshPromise;
    refreshPromise = (async () => {
      const captured = structuredClone(connection());
      const baseURL = normalizeBaseURL(captured.baseURL);
      const response = await fetch(baseURL + '/models', { headers: { authorization: 'Bearer ' + await resolveKey(), accept: 'application/json' }, redirect: 'error', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(captured.timeoutMs), ...(signal ? [signal] : [])]) });
      if (!response.ok) throw new Error('模型发现失败：HTTP ' + response.status);
      const next = readCatalog(JSON.parse(await readBounded(response)), config.modelOverrides.get());
      if (closed || JSON.stringify(captured) !== JSON.stringify(connection())) throw new Error('连接已更改，请重新刷新');
      const models = chatModels(next, config.modelOverrides.get());
      if (models.length) {
        const api = captured.api === 'openai-completions' ? 'openai-completions' : 'openai-responses';
        // thinkingFormat / maxTokensField 只属于 Chat Completions。带进 Responses 后模型会被整批丢掉，选择器是空的。
        const compat = api === 'openai-completions' ? { thinkingFormat: 'openai', maxTokensField: 'max_tokens' } : {};
        const adapter = buildChatAdapter(ctx, { displayName: 'Grok', api, baseURL, apiKeyEnv: captured.apiKeyEnv, models, compat });
        // Build the next snapshot before removing a healthy registration.
        await adapter.listModels(name);
        registration?.();
        registration = ctx.llm.registerAdapter([name], adapter);
      } else { registration?.(); registration = undefined; }
      catalog = next;
      lastError = null;
      reRegisterTools();
      await mkdir(dataDir(), { recursive: true, mode: 0o700 });
      const target = resolve(dataDir(), 'models.json');
      const temp = target + '.' + randomUUID() + '.tmp';
      await writeFile(temp, JSON.stringify({ updatedAt: new Date().toISOString(), models: catalog }, null, 2), { mode: 0o600 });
      await rename(temp, target);
      return catalog;
    })().catch(error => {
      // A rejected endpoint, a missing key, an invalid base URL and an
      // incompatible dsh adapter each need a different fix, so keep their own
      // message. Raw transport and response-shape failures stay generic: their
      // text names internals the user cannot act on.
      const message = typeof error?.message === 'string' ? error.message : '';
      const opaque = error instanceof TypeError || error instanceof SyntaxError || /HTTP \d+/.test(message);
      lastError = error?.name === 'TimeoutError' ? '模型发现超时' : !message || opaque ? '模型发现失败，请检查连接、密钥或模型覆盖配置' : message;
      ctx.logger?.warn?.('grok-byapi: ' + lastError);
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
      // against a different server by accident. The key is resolved per request so a
      // rotated credential reaches the next call without rebuilding the manager.
      const ready = (async () => {
      const instance = new MediaManager({ baseURL, resolveKey,
        dataDir: resolve(dataDir(), 'connections', createHash('sha256').update(JSON.stringify([baseURL, c.apiKey, c.apiKeyEnv, dataDir()])).digest('hex').slice(0,16)), timeoutMs: c.timeoutMs });
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
  // 工具清单在插件加载时就注册，而"当前可选模型"要等首轮发现之后才知道。
  // 做法：描述支持函数，并在每次刷新后用最新描述重新注册（工具定义会被快照，getter 不够）。
  // 设置页「获取模型」把草稿地址和一次性密钥交给这个回调；命名空间必须是插件实例 id。
  try { ctx.llm?.registerModelDiscovery?.(instanceId(), (request, signal) => discover(request, signal)); }
  catch (error) { ctx.logger?.warn?.('grok-byapi: registerModelDiscovery 失败 ' + (error?.message || error)); }
  // 头像菜单里的「模型」页只列出声明过的可配置提供商。空 settingsPath 表示整段插件配置
  // 都属于这一行，所以密钥还没配好时这一行也在。和 Qoder 连接器同一套注册。
  try {
    directory = ctx.llm?.registerConfigurableProviders?.([{
      provider: name, displayName: 'Grok', settingsNs: instanceId(), settingsPath: [], declared: false,
    }]);
  } catch (error) { ctx.logger?.warn?.('grok-byapi: registerConfigurableProviders 失败 ' + (error?.message || error)); }
  const toolFactories = [];
  const toolDisposers = [];
  function tool(toolName, description, parameters, run) {
    const build = () => {
      const definition = { name: toolName, parameters, output: jsonOutput, async execute(args, exec) { return run(args, exec); } };
      Object.defineProperty(definition, 'description', {
        enumerable: true,
        get: () => (typeof description === 'function' ? description() : description),
      });
      return defineTool(definition);
    };
    toolFactories.push(build);
    toolDisposers.push(ctx.tools.register(build()));
  }
  function reRegisterTools() {
    if (closed) return;
    for (const dispose of toolDisposers.splice(0)) { try { dispose(); } catch { /* 已注销 */ } }
    for (const build of toolFactories) toolDisposers.push(ctx.tools.register(build()));
  }
  // 工具描述就是模型唯一能看到的"接口文档"：写清什么时候用、每个参数的含义与边界、
  // 完整调用顺序、失败后怎么办。描述里的模型 ID 都来自当前发现结果，不写死具体名字。
  const capabilityModels = category => catalog.filter(x => x.category === category).map(x => x.id);
  const describeModels = category => {
    const ids = capabilityModels(category);
    return ids.length ? ids.join('、') : '（当前未发现，先调用 grok_models 刷新）';
  };
  const runtime = {
    abort, connection, mediaConfig, catalog: () => catalog, lastError: () => lastError,
    refresh, verifyKey, discover, manager, requireModel, describeModels,
  };
  new GrokRuntime(ctx, runtime);

  tool('grok_models', '获取/刷新 Grok 模型清单，按能力分组返回。调用场景：用户要换模型、要生图/生视频/生音频、或刚改过插件设置（地址、密钥、模型参数）。'
    + '返回的 chat 类模型可用于对话，image/video/speech 类分别是生成图片/视频/音频的可用模型 ID；调用生成工具时应把这里返回的 ID 原样传给 model 参数，不要自行编造或改写模型名。'
    + '参数：refresh=true 强制重新向服务端拉取；verify_key=true 额外做一次密钥自检（一次 GET /models），可判断密钥或地址是否配错。',
  { refresh: { type: 'boolean', description: '强制重新拉取模型清单（默认只在清单为空或已缓存时使用缓存）' },
    verify_key: { type: 'boolean', description: '顺带做密钥自检：报告密钥/地址是否可用，不返回密钥内容' } }, async args => {
    let verify;
    if (args.verify_key) { try { verify = await verifyKey(); } catch (error) { verify = { verified: false, error: error.message }; } }
    if (args.refresh || !catalog.length) { try { await refresh(); } catch {} }
    return { models: catalog, error: lastError, ...(args.verify_key ? { verify } : {}) };
  });

  // 生图、视频、语音由组件 dsh-grok-imagine 注册，当前聊天模型不必是 Grok。
  // 覆盖项（图片支持/上下文/最大输出）在每次刷新时由 readCatalog 应用，
  // 因此改完设置只需像连接字段一样重新发现一次。
  ctx.on('loader/volatile-update', () => {
    registration?.(); registration = undefined; catalog = [];
    void (async () => { if (refreshPromise) await refreshPromise.catch(() => {}); if (!closed) await refresh(); })().catch(() => {});
  });
  ctx.on('dispose', () => {
    closed = true; abort.abort(); registration?.(); directory?.();
    for (const dispose of toolDisposers.splice(0)) { try { dispose(); } catch { /* 已注销 */ } }
  });
  // A missing credential must not prevent installation or settings repair.
  await refresh().catch(() => {});
}
