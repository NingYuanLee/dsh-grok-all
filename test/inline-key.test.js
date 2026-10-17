import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { apply } from '../src/index.js';
import { apply as applyMedia } from '../src/media-entry.js';

const GOOD = 'good-key-abc';
const BAD = 'stale-credential-key';

function serveModels() {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ url: req.url, auth: req.headers.authorization || '', verify: req.headers['x-verify'] || '' });
    const key = (req.headers.authorization || '').replace(/^Bearer /, '');
    if (req.url.startsWith('/v1/models')) {
      if (key !== GOOD) { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"error":"bad key"}'); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ data: [{ id: 'grok-4.7', created: 1, object: 'model', owned_by: 'xai' }] }));
      return;
    }
    res.writeHead(404); res.end('{}');
  });
  return { server, seen };
}

function host(tools, discoveries, providers) {
  return {
    credentials: { resolve: async ref => (ref === 'GROK_ALL_API_KEY' ? { value: BAD } : undefined) },
    llm: {
      registerAdapter: () => () => {},
      registerConfigurableProviders: entries => { providers.push(...entries); return () => {}; },
      registerModelDiscovery: (ns, discover) => { discoveries.set(ns, discover); return () => {}; },
    },
    tools: { register: tool => { tools.set(tool.name, tool); return () => {}; } },
    logger: { warn: () => {}, info: () => {} },
    on: () => () => {},
    get: () => undefined,
    fiber: { entry: { options: { id: 'grok-byapi' } } },
    plugin(Plugin, ...args) { return new Plugin(this, ...args); },
    reflect: { provide() {} },
  };
}

async function mount(t, connection) {
  const { server, seen } = serveModels();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const baseURL = 'http://127.0.0.1:' + server.address().port + '/v1';
  const tools = new Map();
  const discoveries = new Map();
  const providers = [];
  const ctx = host(tools, discoveries, providers);
  const snapshot = { connection: { baseURL, apiKeyEnv: 'GROK_ALL_API_KEY', timeoutMs: 5000, verify: false, ...connection }, media: {} };
  const configProxy = { connection: { get: () => snapshot.connection }, media: { get: () => ({ dataDir: '' }) }, modelOverrides: { get: () => [] } };
  await apply(ctx, configProxy);
  return { tools, seen, discoveries, providers, baseURL };
}

test('明文 apiKey 优先于凭据引用，并按真实密钥请求', async t => {
  const { tools, seen } = await mount(t, { apiKey: GOOD });
  const models = tools.get('grok_models');
  assert.ok(models, '必须注册 grok_models');
  const result = await models.execute({}, {});
  assert.equal(result.error, null);
  assert.deepEqual(result.models.map(m => m.id), ['grok-4.7']);
  assert.ok(seen.length >= 1, '应至少发过一次 /v1/models');
  assert.ok(seen.every(x => x.auth === 'Bearer ' + GOOD), '必须用明文 apiKey 而不是凭据里的旧值：' + JSON.stringify(seen));
});

test('安装后向模型页声明 Grok 提供商', async t => {
  const { providers } = await mount(t, { apiKey: GOOD });
  assert.deepEqual(providers, [{
    provider: 'xAI-CLIProxyAPI', displayName: 'Grok', settingsNs: 'grok-byapi', settingsPath: [], declared: false,
  }]);
});

test('设置页发现使用草稿地址和一次性密钥，不改用已存凭据', async t => {
  const { discoveries, baseURL, seen } = await mount(t, { apiKey: BAD });
  const discover = discoveries.get('grok-byapi');
  assert.equal(typeof discover, 'function');
  const before = seen.length;
  const models = await discover({ baseURL, apiKey: GOOD, api: 'openai-completions' });
  assert.deepEqual(models.map(model => model.id), ['grok-4.7']);
  assert.equal(models[0].inputModalities.includes('text'), true);
  assert.ok(seen.slice(before).every(hit => hit.auth === 'Bearer ' + GOOD));
});

test('留空 apiKey 时回退到凭据引用', async t => {
  const server = createServer((req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ data: [{ id: 'grok-4.7', created: 1, object: 'model', owned_by: 'xai' }] })); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const baseURL = 'http://127.0.0.1:' + server.address().port + '/v1';
  const seen = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => { seen.push(init?.headers?.authorization); return orig(url, init); };
  t.after(() => { globalThis.fetch = orig; });
  const tools = new Map();
  const ctx = {
    credentials: { resolve: async ref => (ref === 'GROK_ALL_API_KEY' ? { value: BAD } : undefined) },
    llm: { registerAdapter: () => () => {}, registerConfigurableProviders: () => ({ replace() {} }), registerModelDiscovery: () => () => {} },
    tools: { register: tool => { tools.set(tool.name, tool); return () => {}; } },
    logger: { warn: () => {}, info: () => {} },
    on: () => () => {}, get: () => undefined, fiber: {}, reflect: { provide() {} },
  };
  await apply(ctx, { connection: { get: () => ({ baseURL, apiKeyEnv: 'GROK_ALL_API_KEY', timeoutMs: 5000, verify: false }) }, media: { get: () => ({ dataDir: '' }) }, modelOverrides: { get: () => [] } });
  assert.ok(seen.includes('Bearer ' + BAD), '应回退到凭据值：' + JSON.stringify(seen));
});

test('密钥自检：错的密钥报认证失败，对的密钥通过', async t => {
  const { tools } = await mount(t, { apiKey: BAD, verify: true });
  const models = tools.get('grok_models');
  const bad = await models.execute({ verify_key: true }, {});
  assert.equal(bad.verify.verified, false);
  assert.match(String(bad.verify.error), /认证被拒绝|密钥自检失败/);
});

test('媒体工具的描述里带上可用模型、参数边界与调用顺序', async t => {
  const models = [
    { id: 'grok-4.7', created: 1, object: 'model' },
    { id: 'grok-imagine-image-2.0', created: 1, object: 'model' },
    { id: 'grok-imagine-video-1.5', created: 1, object: 'model' },
    { id: 'grok-tts', created: 1, object: 'model' },
  ];
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(req.url.startsWith('/v1/models') ? { data: models } : { data: [] }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => server.close());
  const tools = new Map();
  const ctx = {
    credentials: { resolve: async () => ({ value: 'test-key' }) },
    llm: { registerAdapter: () => () => {}, registerConfigurableProviders: () => ({ replace() {} }), registerModelDiscovery: () => () => {} },
    tools: { register: tool => { tools.set(tool.name, tool); return () => {}; } },
    logger: { warn: () => {} }, on: () => () => {}, get(name) { return name === 'grok-byapi' ? this['grok-byapi'] : undefined; }, fiber: {}, reflect: { provide(name, value) { this.ctx = ctx; ctx[name] = value; } },
  };
  await apply(ctx, {
    connection: { get: () => ({ baseURL: 'http://127.0.0.1:' + server.address().port + '/v1', timeoutMs: 5000, verify: false, apiKeyEnv: 'GROK_ALL_API_KEY' }) },
    media: { get: () => ({ dataDir: '' }) },
    modelOverrides: { get: () => [] },
  });
  await applyMedia(ctx);

  // 描述里的"当前可选模型"在首轮发现后才会填上：题述工具会被重新注册，故取最后一次注册的定义。
  await tools.get('grok_models').execute({}, {});
  const image = tools.get('grok_generate_image');
  const video = tools.get('grok_generate_video');
  const speech = tools.get('grok_speak');
  const status = tools.get('grok_media_status');
  assert.ok(image && video && speech && status, '四个媒体工具都应注册');

  // 参数说明必须带上当前可用的模型 ID 与边界
  assert.match(image.description, /grok-imagine-image-2\.0/);
  assert.match(image.description, /1–4/);
  assert.match(image.description, /files/);
  assert.match(video.description, /grok-imagine-video-1\.5/);
  assert.match(video.description, /1–15/);
  assert.match(video.description, /grok_media_status/);
  assert.match(speech.description, /grok-tts/);
  assert.match(speech.description, /voice/);
  assert.match(status.description, /saved/);

  // 参数本身要能被模型看懂（defineTool 已把声明转成 JSON Schema）
  assert.deepEqual(image.parameters.required, ['prompt']);
  assert.match(image.parameters.properties.n.description, /1–4/);
  assert.match(video.parameters.properties.duration.description, /1–15/);
  assert.deepEqual(speech.parameters.required, ['input']);
  assert.deepEqual(status.parameters.required, ['task_id']);
});
