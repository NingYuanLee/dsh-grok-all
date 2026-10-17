import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// 用能保存并触发重渲染的假 React 加载真实构建产物，验证「获取模型 → 添加行 → 保存」、只读页与槽位注册。
function loadClient() {
  const code = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
  const runtime = { renders: [], render: null, hooks: [], effects: [], cursor: 0 };
  const React = {
    createElement: (type, props, ...children) => (typeof type === 'function'
      ? type({ ...(props || {}), children })
      : { type, props: { ...(props || {}) }, children }),
    useEffect: fn => { runtime.effects.push(fn); },
    useRef: initial => { runtime.refs = runtime.refs || {}; const slot = runtime.cursor++; const key = 'r' + slot; runtime.refs[key] = runtime.refs[key] || { current: initial }; return runtime.refs[key]; },
    useState: initial => {
      const slot = runtime.cursor++;
      if (runtime.hooks[slot] === undefined) runtime.hooks[slot] = { value: typeof initial === 'function' ? initial() : initial };
      const entry = runtime.hooks[slot];
      const set = next => {
        entry.value = typeof next === 'function' ? next(entry.value) : next;
        runtime.cursor = 0;
        if (runtime.render) runtime.renders.push(runtime.render());
      };
      return [entry.value, set];
    },
  };
  let loaded;
  const previousWindow = globalThis.window;
  globalThis.window = { __ModuleLoader__: { load: options => { loaded = options; } } };
  const require = createRequire(import.meta.url);
  const stub = name => {
    if (name === 'react') return React;
    if (name === 'react/jsx-runtime') return { jsx: React.createElement, jsxs: React.createElement, Fragment: 'Fragment' };
    if (name === 'react-dom') return { createPortal: x => x };
    return require(name);
  };
  new Function('require', code)(stub);
  const exports = loaded.factory(stub, {});
  globalThis.window = previousWindow;
  return { exports, runtime };
}

function walk(node, found = []) {
  if (!node || typeof node !== 'object') return found;
  found.push(node);
  const children = node.children ?? node.props?.children;
  for (const child of Array.isArray(children) ? children : [children]) walk(child, found);
  return found;
}
const textsOf = node => [].concat(node?.children ?? []).map(c => (typeof c === 'string' ? c : textsOf(c))).join('');
const byLabel = (tree, label) => walk(tree).find(n => (n.props || {})['aria-label'] === label);
const buttonByText = (tree, label) => walk(tree).find(n => n.type === 'button' && textsOf(n).includes(label));
const statusText = tree => walk(tree).filter(n => n.props?.role === 'status').map(textsOf).join(' ');
const TOOL_KEYS = ['grok_generate_image', 'grok_generate_video', 'grok_speak', 'grok_media_status', 'grok_media_retry_download', 'grok_media_list', 'grok_models'];

const DISCOVERED = [
  { id: 'grok-4.7', name: 'grok-4.7', contextWindow: 500000, maxTokens: 32768, inputModalities: ['text', 'image'] },
  { id: 'grok-4.5', name: 'grok-4.5', contextWindow: 500000, maxTokens: 32768, inputModalities: ['text', 'image'] },
  { id: 'grok-3-mini', name: 'grok-3-mini', contextWindow: 262144, maxTokens: 32768, inputModalities: ['text'] },
  { id: 'grok-imagine-image-2.0', name: 'grok-imagine-image-2.0', contextWindow: 131072, maxTokens: 8192, inputModalities: ['text'] },
  { id: 'grok-imagine-video-1.5', name: 'grok-imagine-video-1.5', contextWindow: 131072, maxTokens: 8192, inputModalities: ['text'] },
  { id: 'grok-tts', name: 'grok-tts', contextWindow: 131072, maxTokens: 8192, inputModalities: ['text'] },
];

function mount(Client, options = {}) {
  const runtime = Client.runtime;
  runtime.cursor = 0;
  runtime.hooks = [];
  runtime.effects = [];
  runtime.refs = {};
  const seen = [];
  const form = {
    state: { value: options.state || { connection: { baseURL: 'http://127.0.0.1:8317/v1', timeoutMs: 60000 }, media: {}, modelOverrides: [] }, revision: 5, writable: true },
    mutate: options.mutate || (async () => true),
  };
  const remote = { llm: { discoverModels: options.discover || (async (_ns, request) => { seen.push(request); return DISCOVERED; }) }, credentials: { set: options.setCredential || (async () => ({ ok: true })), describe: options.describeCredential } };
  runtime.render = () => { runtime.cursor = 0; runtime.effects = []; return Client.exports.GrokSettings({ view: 'page', form, remote }); };
  runtime.renders = [runtime.render()];
  const current = () => runtime.renders[runtime.renders.length - 1];
  current.seen = seen;
  return current;
}

function openChat(current) {
  const toggle = buttonByText(current(), '对话模型');
  if (toggle?.props?.['aria-expanded'] !== 'true') toggle.props.onClick();
}
async function discoveredTree(Client, mutate) {
  const current = mount(Client, { mutate });
  openChat(current);
  await buttonByText(current(), '获取模型').props.onClick();
  return current;
}

const chatSelects = tree => walk(tree).filter(n => n.type === 'select' && String(n.props?.['aria-label'] || '').startsWith('模型 ID'));
const chatSelect = tree => chatSelects(tree).at(-1);

test('远程发现结果包在 ok/value 里时仍能列出模型', async () => {
  const Client = loadClient();
  const current = mount(Client, { discover: async () => ({ ok: true, value: DISCOVERED }) });
  await buttonByText(current(), '获取模型').props.onClick();
  assert.match(statusText(current()), /已从 Grok ByAPI 发现 6 个模型/);
});

test('点获取模型后提示数量，媒体下拉只列同类模型', async () => {
  const Client = loadClient();
  const current = await discoveredTree(Client);
  buttonByText(current(), '媒体模型').props.onClick();
  const tree = current();
  assert.match(statusText(tree), /已从 Grok ByAPI 发现 6 个模型/);
  assert.equal(current.seen[0].baseURL, 'http://127.0.0.1:8317/v1');
  assert.equal(current.seen[0].apiKey, undefined);
  const ids = walk(byLabel(tree, '生成图片')).filter(n => n.type === 'option').map(n => n.props.value);
  assert.deepEqual(ids, ['', 'grok-imagine-image-2.0']);
  assert.equal(byLabel(tree, '启用生成图片'), undefined);
});

test('获取模型把草稿密钥发给发现接口，不写进配置', async () => {
  const Client = loadClient();
  const current = mount(Client);
  byLabel(current(), 'API Key').props.onChange({ target: { value: 'draft-key' } });
  await buttonByText(current(), '获取模型').props.onClick();
  assert.equal(current.seen.at(-1).apiKey, 'draft-key');
});

test('已保存的模型在未获取清单时也能回显，获取后去重', async () => {
  const Client = loadClient();
  const current = mount(Client, { state: {
    connection: { baseURL: 'http://127.0.0.1:8317/v1', timeoutMs: 60000 },
    media: { imageModel: 'grok-imagine-image-2.0', videoModel: '', speechModel: '' },
    modelOverrides: [{ id: 'grok-4.7', displayName: 'Grok 4.7', imageSupported: true, contextWindow: 500000, maxTokens: 32768, reasoningEfforts: ['high'] }],
  } });
  openChat(current);
  buttonByText(current(), '媒体模型').props.onClick();
  const before = walk(chatSelect(current())).filter(n => n.type === 'option').map(n => n.props.value);
  assert.deepEqual(before, ['', 'grok-4.7']);
  assert.equal(byLabel(current(), '生成图片').props.value, 'grok-imagine-image-2.0');
  await buttonByText(current(), '获取模型').props.onClick();
  const after = walk(chatSelect(current())).filter(n => n.type === 'option').map(n => n.props.value);
  assert.equal(after.filter(id => id === 'grok-4.7').length, 1);
  assert.ok(after.includes('grok-4.5'));
});

test('客户端声明凭据命名空间，否则设置页一读密钥就整页崩溃', () => {
  const Client = loadClient();
  assert.ok(Client.exports.inject.includes('remote.credentials'));
});

test('已配置密钥时按引用名数组查询并自动展开模型', async () => {
  const Client = loadClient();
  const described = [];
  const current = mount(Client, {
    describeCredential: async refs => {
      described.push(refs);
      return { ok: true, value: { GROK_ALL_API_KEY: { configured: true, writable: true } } };
    },
  });
  for (const effect of Client.runtime.effects) effect();
  await new Promise(resolve => setTimeout(resolve, 0));
  assert.deepEqual(described, [['GROK_ALL_API_KEY']]);
  assert.match(statusText(current()), /已从 Grok ByAPI 发现 6 个模型/);
  assert.equal(buttonByText(current(), '对话模型').props['aria-expanded'], 'true');
  assert.ok(walk(chatSelect(current())).some(n => n.props?.value === 'grok-4.7'));
});

test('地址为空时获取模型仍带上默认地址', async () => {
  const Client = loadClient();
  const current = mount(Client, { state: { connection: { baseURL: '' }, media: {}, modelOverrides: [] } });
  await buttonByText(current(), '获取模型').props.onClick();
  assert.equal(current.seen[0].baseURL, 'http://127.0.0.1:8317/v1');
  assert.equal(current.seen[0].api, 'openai-responses');
});

test('插件详情页等配置读完再自动获取，不用空地址', async () => {
  const Client = loadClient();
  const runtime = Client.runtime;
  runtime.cursor = 0;
  runtime.hooks = [];
  runtime.refs = {};
  runtime.effects = [];
  const seen = [];
  let release;
  const described = new Promise(resolve => { release = resolve; });
  const value = { connection: { baseURL: 'https://gateway.example/v1', api: 'openai-completions' }, media: {}, modelOverrides: [] };
  const remote = {
    settings: { describe: () => described.then(() => ({ ok: true, value: { namespaces: [{ ns: 'grok-byapi', value, revision: 3 }] } })) },
    credentials: { describe: async () => ({ ok: true, value: { GROK_ALL_API_KEY: { configured: true } } }) },
    llm: { discoverModels: async (_ns, request) => { seen.push(request); return { ok: true, value: DISCOVERED }; } },
  };
  runtime.render = () => { runtime.cursor = 0; runtime.effects = []; return Client.exports.GrokSettings({ view: 'page', remote }); };
  runtime.renders = [runtime.render()];
  for (const effect of runtime.effects.slice()) effect();
  await new Promise(r => setTimeout(r, 0));
  assert.equal(seen.length, 0, '配置没回来之前不能拿空地址去发现');
  assert.doesNotMatch(statusText(runtime.renders.at(-1)), /provider route|baseURL/);
  release();
  await new Promise(r => setTimeout(r, 20));
  assert.equal(seen.length, 1);
  assert.equal(seen[0].baseURL, 'https://gateway.example/v1');
  assert.equal(seen[0].api, 'openai-completions');
  assert.match(statusText(runtime.renders.at(-1)), /已从 Grok ByAPI 发现 6 个模型/);
  assert.doesNotMatch(statusText(runtime.renders.at(-1)), /provider route/);
});

test('宿主拒绝空地址时不把英文原文露出来', async () => {
  const Client = loadClient();
  const current = mount(Client, { discover: async () => ({ ok: false, error: { message: 'model discovery needs a provider route or a baseURL' } }) });
  await buttonByText(current(), '获取模型').props.onClick();
  assert.match(statusText(current()), /还没有可用的 API 地址/);
  assert.doesNotMatch(statusText(current()), /provider route/);
});

test('打开页面就有一行空的聊天模型', () => {
  const Client = loadClient();
  const current = mount(Client);
  openChat(current);
  buttonByText(current(), '媒体模型').props.onClick();
  const tree = current();
  const model = chatSelect(tree);
  assert.equal(model.props.value, '');
  assert.deepEqual(walk(model).filter(n => n.type === 'option').map(n => n.props.value), ['']);
  assert.equal(byLabel(tree, '生成图片').props.value, '');
  assert.equal(byLabel(tree, '启用生成图片'), undefined);
  assert.equal(walk(tree).some(n => n.type === 'input' && n.props?.type === 'radio'), false);
});

test('聊天模型下拉不含图片/视频/语音模型', async () => {
  const Client = loadClient();
  const current = await discoveredTree(Client);
  await buttonByText(current(), '添加').props.onClick();
  const options = walk(chatSelect(current())).filter(n => n.type === 'option').map(n => n.props.value);
  assert.ok(options.includes('grok-4.7'));
  assert.ok(!options.includes('grok-imagine-video-1.5'));
  assert.ok(!options.includes('grok-tts'));
});

test('保存对话模型只提交覆盖，并清掉已无用的默认模型', async () => {
  const Client = loadClient();
  const calls = [];
  const current = await discoveredTree(Client, async (ops, revision) => { calls.push({ ops, revision }); return true; });
  await buttonByText(current(), '添加').props.onClick();
  chatSelect(current()).props.onChange({ target: { value: 'grok-4.7' } });
  await buttonByText(current(), '保存对话模型').props.onClick();
  assert.equal(calls.length, 1);
  const ops = calls[0].ops;
  const overrides = ops.find(o => o.path[0] === 'modelOverrides').value;
  assert.equal(overrides.length, 1);
  assert.equal(overrides[0].id, 'grok-4.7');
  assert.equal(overrides[0].contextWindow, 500000);
  assert.equal(ops.some(o => o.op === 'set' && o.path[0] === 'media' && o.path[1] === 'defaultModel'), false);
  assert.deepEqual(ops.find(o => o.op === 'unset' && o.path[1] === 'defaultModel'), { op: 'unset', path: ['media', 'defaultModel'] });
});

test('删掉的对话模型不会在保存时被加回', async () => {
  const Client = loadClient();
  const calls = [];
  const withTwo = {
    connection: { baseURL: 'http://127.0.0.1:8317/v1', timeoutMs: 60000 },
    media: { defaultModel: 'grok-4.7' },
    modelOverrides: [
      { id: 'grok-4.7', displayName: 'Grok 4.7', imageSupported: true, contextWindow: 500000, maxTokens: 32768, reasoningEfforts: ['high'] },
      { id: 'grok-4.5', displayName: 'Grok 4.5', imageSupported: true, contextWindow: 500000, maxTokens: 32768, reasoningEfforts: ['medium'] },
    ],
  };
  const current = mount(Client, { state: withTwo, mutate: async (ops) => { calls.push(ops); return true; } });
  openChat(current);
  await buttonByText(current(), '获取模型').props.onClick();
  byLabel(current(), '删除第 1 行').props.onClick();
  await buttonByText(current(), '保存对话模型').props.onClick();
  const overrides = calls[0].find(o => o.path[0] === 'modelOverrides').value;
  assert.deepEqual(overrides.map(row => row.id), ['grok-4.5']);
});

test('删除按钮在每行最前，尺寸与添加一致，红字红边', () => {
  const Client = loadClient();
  const current = mount(Client, { state: {
    connection: { baseURL: 'http://127.0.0.1:8317/v1' },
    media: {},
    modelOverrides: [
      { id: 'grok-4.7', displayName: 'Grok 4.7', imageSupported: true, contextWindow: 500000, maxTokens: 32768, reasoningEfforts: ['high'] },
      { id: 'grok-4.5', displayName: 'Grok 4.5', imageSupported: true, contextWindow: 500000, maxTokens: 32768, reasoningEfforts: ['medium'] },
    ],
  } });
  openChat(current);
  const tree = current();
  const row = walk(tree).find(n => n.type === 'tr' && walk(n).some(c => c.props?.['aria-label'] === '删除第 1 行'));
  const cells = [].concat(row.children).filter(n => n?.type === 'td');
  assert.equal(cells[0].children[0].props['aria-label'], '删除第 1 行');
  assert.equal(cells[1].children[0].props['aria-label'], '模型 ID 0');
  const del = cells[0].children[0].props.style;
  const add = buttonByText(tree, '添加').props.style;
  assert.equal(del.height, add.height);
  assert.equal(del.padding, add.padding);
  assert.equal(del.fontSize, add.fontSize);
  assert.equal(del.borderRadius, add.borderRadius);
  assert.match(String(del.color), /error-primary/);
  assert.match(String(del.border), /error-primary/);
  assert.equal(walk(tree).some(n => n.props?.type === 'radio'), false);
  assert.equal(byLabel(tree, '删除第 1 行').props.disabled, false);
  assert.equal(byLabel(tree, '删除第 2 行').props.disabled, false);
  assert.equal(byLabel(tree, '上下文 0').props.style.width, 64);
  assert.equal(byLabel(tree, '最大输出 0').props.style.width, 64);
  byLabel(tree, '删除第 2 行').props.onClick();
  assert.equal(byLabel(current(), '删除第 2 行'), undefined);
  assert.equal(byLabel(current(), '模型 ID 0').props.value, 'grok-4.7');
});

test('上下文/最大输出接受 M 与 K 后缀', async () => {
  const Client = loadClient();
  const calls = [];
  const current = await discoveredTree(Client, async ops => { calls.push(ops); return true; });
  await buttonByText(current(), '添加').props.onClick();
  chatSelect(current()).props.onChange({ target: { value: 'grok-4.7' } });
  byLabel(current(), '上下文 1').props.onChange({ target: { value: '1M' } });
  byLabel(current(), '最大输出 1').props.onChange({ target: { value: '64K' } });
  await buttonByText(current(), '保存对话模型').props.onClick();
  const overrides = calls[0].find(o => o.path[0] === 'modelOverrides').value;
  assert.equal(overrides.at(-1).contextWindow, 1000000);
  assert.equal(overrides.at(-1).maxTokens, 64000); // K = 1000，与界面提示一致
});

test('非法大小被拦下且不提交', async () => {
  const Client = loadClient();
  const calls = [];
  const current = await discoveredTree(Client, async ops => { calls.push(ops); return true; });
  await buttonByText(current(), '添加').props.onClick();
  chatSelect(current()).props.onChange({ target: { value: 'grok-4.7' } });
  byLabel(current(), '最大输出 1').props.onChange({ target: { value: 'abc' } });
  await buttonByText(current(), '保存对话模型').props.onClick();
  assert.equal(calls.length, 0);
  assert.match(statusText(current()), /最大输出 token/);
});

test('思考强度是多选选项', async () => {
  const Client = loadClient();
  const current = await discoveredTree(Client);
  await buttonByText(current(), '添加').props.onClick();
  chatSelect(current()).props.onChange({ target: { value: 'grok-4.7' } });
  const effort = buttonByText(current(), 'low|medium|high|xhigh');
  assert.equal(effort.props.style.whiteSpace, 'nowrap');
  assert.equal(effort.props.style.fontSize, 11);
  effort.props.onClick();
  const efforts = walk(current()).filter(n => n.type === 'input' && String(n.props?.['aria-label'] || '').startsWith('思考强度 '));
  assert.deepEqual(efforts.map(n => n.props['aria-label']), ['思考强度 none 1', '思考强度 low 1', '思考强度 medium 1', '思考强度 high 1', '思考强度 xhigh 1']);
  efforts.find(n => n.props['aria-label'] === '思考强度 none 1').props.onChange({ target: { checked: true } });
  assert.match(textsOf(current()), /high/);
});

test('API Key 输入框是密码框且默认留空（密钥存凭据库）', async () => {
  const Client = loadClient();
  const current = await discoveredTree(Client);
  const key = byLabel(current(), 'API Key');
  assert.equal(key.props.type, 'password');
  assert.equal(key.props.value, '');
  assert.match(textsOf(current()), /GROK_ALL_API_KEY/);
});

test('提供商信息是只读的，并指向真正的配置位置', () => {
  const Client = loadClient();
  const tree = Client.exports.GrokProviderNotice({ view: 'detail', form: { state: { value: { connection: { baseURL: 'http://127.0.0.1:8317/v1' } } } } });
  assert.equal(walk(tree).some(n => n.type === 'input'), false, '只读页不应有任何输入控件');
  const text = textsOf(tree);
  assert.match(text, /grok-byapi/);
  assert.match(text, /插件 → dsh-grok-byapi → Grok ByAPI/);
  assert.match(text, /只读/);
});

test('配置挂在插件上，七个工具都有结果卡片', () => {
  const Client = loadClient();
  const registered = [];
  const ctx = {
    slots: { inject: (name, fn) => { fn(); }, register: (options, component) => { registered.push({ name: options.name, key: options.key, component }); return () => {}; } },
    documentPreviews: { register: () => () => {} },
    remote: { marker: true },
    effect: fn => fn(),
  };
  Client.exports.apply(ctx);
  const bundles = registered.filter(r => r.name === 'plugins.bundle.config');
  assert.equal(bundles.length, 1);
  assert.equal(bundles[0].key, 'dsh-grok-byapi');
  assert.match(textsOf(bundles[0].component({ view: 'summary' })), /Grok 连接、密钥与模型参数/);
  assert.equal(registered.filter(r => r.name === 'plugins.row.config').length, 0);
  const toolviews = registered.filter(r => r.name === 'tool.call.toolview').map(r => r.key);
  assert.deepEqual(toolviews.sort(), [...TOOL_KEYS].sort(), '七个工具都要有结果卡片');
});

test('插件详情页自己读取设置，不依赖页面传入的表单', async () => {
  const Client = loadClient();
  const runtime = Client.runtime;
  runtime.cursor = 0;
  runtime.hooks = [];
  const value = { connection: { baseURL: 'http://127.0.0.1:8317/v1' }, media: {}, modelOverrides: [] };
  const seen = [];
  runtime.render = () => { runtime.cursor = 0; runtime.effects = []; return Client.exports.GrokSettings({ view: 'page', remote: { settings: { describe: async () => { seen.push('describe'); return { ok: true, value: { namespaces: [{ ns: 'grok-byapi', value, revision: 3 }] } }; } } } }); };
  runtime.renders = [runtime.render()];
  const before = runtime.renders.length;
  for (const effect of runtime.effects.slice()) effect();
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(seen, ['describe']);
});

test('首次挂载（还没获取模型）不抛错：effect 不能解引用 null', async () => {
  const Client = loadClient();
  const runtime = Client.runtime;
  runtime.cursor = 0;
  runtime.hooks = [];
  runtime.effects = [];
  const form = { state: { value: { connection: { baseURL: 'http://127.0.0.1:8317/v1' }, media: {}, modelOverrides: [] }, revision: 1, writable: true }, mutate: async () => true };
  runtime.render = () => { runtime.cursor = 0; runtime.effects = []; return Client.exports.GrokSettings({ view: 'page', form, remote: { llm: { discoverModels: async () => DISCOVERED } } }); };
  runtime.renders = [runtime.render()];
  // 只跑挂载时注册的那批 effect：runtime.hooks 会随渲染增长，用 for...of 会无限循环。
  for (const effect of runtime.effects.slice()) await effect();
  await new Promise(r => setTimeout(r, 0));
  const text = textsOf(runtime.renders[runtime.renders.length - 1]) || '';
  assert.match(text, /对话模型/, '面板应完整渲染');
  assert.match(text, /获取模型/);
});

test('摘要视图返回一句话', () => {
  const Client = loadClient();
  assert.match(textsOf(Client.exports.GrokSettings({ view: 'summary' })), /Grok 连接、密钥与模型参数/);
});

test('保存时把密钥写入凭据库，配置里不留明文', async () => {
  const Client = loadClient();
  const stored = [];
  const current = mount(Client, { setCredential: async (ref, value) => { stored.push({ ref, value }); return { ok: true }; } });
  byLabel(current(), 'API Key').props.onChange({ target: { value: 'saved-key' } });
  await buttonByText(current(), '保存地址和密钥').props.onClick();
  assert.deepEqual(stored, [{ ref: 'GROK_ALL_API_KEY', value: 'saved-key' }]);
  assert.equal(byLabel(current(), 'API Key').props.value, '');
});

test('空地址回显默认值，保存写入同一地址', async () => {
  const Client = loadClient();
  const calls = [];
  const current = mount(Client, {
    state: { connection: { baseURL: '' }, media: {}, modelOverrides: [] },
    mutate: async ops => { calls.push(ops); return true; },
  });
  assert.equal(byLabel(current(), 'API 地址').props.value, 'http://127.0.0.1:8317/v1');
  await buttonByText(current(), '保存地址和密钥').props.onClick();
  const connection = calls[0].find(op => op.path[0] === 'connection').value;
  assert.equal(connection.baseURL, 'http://127.0.0.1:8317/v1');
  assert.equal(connection.apiKey, '');
});

test('已保存的 API 地址原样回显', () => {
  const Client = loadClient();
  const current = mount(Client, { state: {
    connection: { baseURL: 'https://gateway.example/v1' }, media: {}, modelOverrides: [],
  } });
  assert.equal(byLabel(current(), 'API 地址').props.value, 'https://gateway.example/v1');
});

test('未获取清单时保存媒体模型仍保留已选 ID', async () => {
  const Client = loadClient();
  const calls = [];
  const current = mount(Client, {
    state: {
      connection: { baseURL: 'http://127.0.0.1:8317/v1' },
      media: { imageModel: 'grok-imagine-image-2.0', videoModel: '', speechModel: '', defaultModel: 'grok-4.7' },
      modelOverrides: [],
    },
    mutate: async ops => { calls.push(ops); return true; },
  });
  buttonByText(current(), '媒体模型').props.onClick();
  assert.equal(byLabel(current(), '生成图片').props.value, 'grok-imagine-image-2.0');
  assert.equal(byLabel(current(), '启用生成图片'), undefined);
  await buttonByText(current(), '保存媒体模型').props.onClick();
  const media = calls[0].find(op => op.path.length === 1 && op.path[0] === 'media').value;
  assert.equal(media.imageModel, 'grok-imagine-image-2.0');
  assert.equal('defaultModel' in media, false);
});

test('选不使用后再保存会清空该媒体模型', async () => {
  const Client = loadClient();
  const calls = [];
  const current = mount(Client, {
    state: {
      connection: { baseURL: 'http://127.0.0.1:8317/v1' },
      media: { imageModel: 'grok-imagine-image-2.0', videoModel: '', speechModel: '' },
      modelOverrides: [],
    },
    mutate: async ops => { calls.push(ops); return true; },
  });
  buttonByText(current(), '媒体模型').props.onClick();
  byLabel(current(), '生成图片').props.onChange({ target: { value: '' } });
  assert.equal(byLabel(current(), '生成图片').props.value, '');
  await buttonByText(current(), '保存媒体模型').props.onClick();
  const media = calls[0].find(op => op.path.length === 1 && op.path[0] === 'media').value;
  assert.equal(media.imageModel, '');
});
