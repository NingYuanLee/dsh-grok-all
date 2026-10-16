import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyModel, normalizeBaseURL, readCatalog, chatModels } from '../src/catalog.js';

test('known media and research models never leak into agent chat catalog', () => {
  const catalog = readCatalog({ data: ['grok-4.7', 'grok-4.7-build-fast', 'grok-imagine-image-2.0', 'grok-imagine-video-1.5', 'grok-tts', 'grok-4.20-multi-agent-0309', 'grok-future-unknown'].map(id => ({ id })) });
  assert.deepEqual(chatModels(catalog).map(x => x.id), ['grok-4.7', 'grok-4.7-build-fast']);
  assert.ok(catalog.every(x => x.verified === false));
  assert.equal(catalog.find(x => x.id === 'grok-future-unknown').category, 'unknown');
});
test('explicit override supports future model without inventing verification', () => {
  const c = readCatalog({ data: [{ id: 'future' }, { id: 'future' }] }, [{ id: 'future', category: 'chat', contextWindow: 10000, reasoningEfforts: ['low'] }]);
  assert.equal(c.length, 1);
  assert.equal(c[0].source, 'override');
  assert.equal(c[0].verified, false);
  assert.equal(chatModels(c)[0].contextWindow, 10000);
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
