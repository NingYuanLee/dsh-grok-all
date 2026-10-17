import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyModel, normalizeBaseURL, readCatalog, chatModels, expandPath } from '../src/catalog.js';

test('known media and research models never leak into agent chat catalog', () => {
  const catalog = readCatalog({ data: ['grok-4.7', 'grok-4.7-build-fast', 'grok-imagine-image-2.0', 'grok-imagine-video-1.5', 'grok-tts', 'grok-4.20-multi-agent-0309', 'grok-future-unknown'].map(id => ({ id })) });
  assert.deepEqual(chatModels(catalog).map(x => x.id), []);
  assert.deepEqual(chatModels(catalog, [{ id: 'grok-4.7' }, { id: 'grok-4.7-build-fast' }]).map(x => x.id), ['grok-4.7', 'grok-4.7-build-fast']);
  assert.ok(catalog.every(x => x.verified === false));
  assert.equal(catalog.find(x => x.id === 'grok-imagine-image-2.0').category, 'image');
  assert.equal(catalog.find(x => x.id === 'grok-imagine-video-1.5').category, 'video');
  assert.equal(catalog.find(x => x.id === 'grok-tts').category, 'speech');
  assert.equal(catalog.find(x => x.id === 'grok-future-unknown').category, 'chat');
});
test('explicit override supports future model without inventing verification', () => {
  const c = readCatalog({ data: [{ id: 'future' }, { id: 'future' }] }, [{ id: 'future', category: 'chat', contextWindow: 10000, reasoningEfforts: ['low'] }]);
  assert.equal(c.length, 1);
  assert.equal(c[0].source, 'override');
  assert.equal(c[0].verified, false);
  assert.equal(chatModels(c, [{ id: 'future' }])[0].contextWindow, 10000);
});
test('base URL strips trailing slash, preserves deployment prefix and rejects unsafe forms', () => {
  assert.equal(normalizeBaseURL('http://127.0.0.1:8317/'), 'http://127.0.0.1:8317/v1');
  assert.equal(normalizeBaseURL('https://example.com/proxy/v1/'), 'https://example.com/proxy/v1');
  for (const u of ['http://example.com', 'https://key@example.com', 'https://example.com?key=x', 'file:///tmp']) assert.throws(() => normalizeBaseURL(u));
});
test('malformed metadata and invalid overrides fail early', () => {
  assert.throws(() => readCatalog({}));
  assert.throws(() => classifyModel('x', { category: 'garbage' }));
  assert.throws(() => classifyModel('x', { input: ['audio'] }));
});

test('官方推理强度：4.7/4.6 含 xhigh，4.5 三档，4.3 含 none', () => {
  assert.deepEqual(classifyModel({ id: 'grok-4.7' }).reasoningEfforts, ['low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(classifyModel({ id: 'grok-4.6' }).reasoningEfforts, ['low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(classifyModel({ id: 'grok-4.5' }).reasoningEfforts, ['low', 'medium', 'high']);
  assert.deepEqual(classifyModel({ id: 'grok-4.3' }).reasoningEfforts, ['none', 'low', 'medium', 'high', 'xhigh']);
  assert.deepEqual(classifyModel({ id: 'grok-build-0.1' }).reasoningEfforts, []);
  assert.equal(classifyModel({ id: 'grok-4.3' }).contextWindow, 1000000);
});

test('三个可配置项：图片支持、上下文大小、最大输出 token', () => {
  // 默认（已知规则）：4.7 支持图片，4.5 也支持，3-mini 只有文本
  const base = classifyModel({ id: 'grok-4.7' });
  assert.deepEqual(base.input, ['text', 'image']);
  assert.equal(base.contextWindow, 500000);
  assert.equal(base.maxTokens, 32768);
  assert.deepEqual(classifyModel({ id: 'grok-3-mini' }).input, ['text']);
  assert.deepEqual(classifyModel({ id: 'grok-4.20-0309-reasoning' }).input, ['text', 'image']);
  assert.deepEqual(classifyModel({ id: 'grok-build-0.1' }).input, ['text', 'image']);

  // imageSupported:false 只关图片，文本保留
  const noImage = classifyModel({ id: 'grok-4.7' }, { imageSupported: false });
  assert.deepEqual(noImage.input, ['text']);

  // imageSupported:true 打开图片（含默认只有文本的模型）
  const withImage = classifyModel({ id: 'grok-3-mini' }, { imageSupported: true });
  assert.deepEqual(withImage.input, ['text', 'image']);

  // 上下文与最大输出可覆盖，并进入聊天模型清单
  const tuned = readCatalog({ data: [{ id: 'grok-4.7' }] }, [{ id: 'grok-4.7', imageSupported: false, contextWindow: 200000, maxTokens: 64000 }]);
  assert.equal(tuned[0].source, 'override');
  const chat = chatModels(tuned, [{ id: 'grok-4.7' }])[0];
  assert.deepEqual(chat.input, ['text']);
  assert.equal(chat.contextWindow, 200000);
  assert.equal(chat.maxTokens, 64000);
  assert.equal(chatModels([classifyModel({ id: 'grok-4.3' })], [{ id: 'grok-4.3' }])[0].reasoningEfforts.off, null);
  assert.equal(chatModels([classifyModel({ id: 'grok-4.7' })], [{ id: 'grok-4.7' }])[0].reasoningEfforts.xhigh, 'xhigh');
  const selected = readCatalog({ data: [{ id: 'grok-4.7' }, { id: 'grok-4.5' }, { id: 'grok-4.3' }] });
  assert.deepEqual(chatModels(selected, [{ id: 'grok-4.5' }, { id: 'grok-4.3' }]).map(x => x.id), ['grok-4.5', 'grok-4.3']);
});

test('上游自报的 inputModalities 仍被尊重，显式开关优先', () => {
  const upstream = classifyModel({ id: 'future-model', inputModalities: ['text', 'image'] });
  assert.deepEqual(upstream.input, ['text', 'image']);
  assert.deepEqual(classifyModel({ id: 'future-model', inputModalities: ['text', 'image'] }, { imageSupported: false }).input, ['text']);
  assert.deepEqual(classifyModel({ id: 'future-model', inputModalities: ['text'] }, { imageSupported: true }).input, ['text', 'image']);
});

test('结果保存目录支持 ~ 与环境变量写法', () => {
  process.env.GROK_TEST_DIR = 'D:\\grok-out';
  assert.equal(expandPath(''), '');
  assert.equal(expandPath('  '), '');
  assert.equal(expandPath('%GROK_TEST_DIR%\\img'), 'D:\\grok-out\\img');
  assert.equal(expandPath('$GROK_TEST_DIR'), 'D:\\grok-out');
  assert.equal(expandPath('${GROK_TEST_DIR}\\a'), 'D:\\grok-out\\a');
  const home = process.env.HOME || process.env.USERPROFILE || '';
  assert.equal(expandPath('~/pics'), home + '/pics');
  // 未定义的变量保持原样，便于用户看出写错了
  assert.equal(expandPath('%NOT_SET_VAR_XYZ%\\a'), '%NOT_SET_VAR_XYZ%\\a');
  delete process.env.GROK_TEST_DIR;
});
