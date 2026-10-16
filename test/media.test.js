import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { MediaManager } from '../src/media.js';

const png = Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);
const mp4 = Buffer.concat([Buffer.from([0,0,0,24]), Buffer.from('ftypisom'), Buffer.alloc(16)]);
async function fixture(t, handler) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-grok-test-'));
  const server = createServer(handler); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); assert.equal(dirname(resolve(dir)), resolve(tmpdir())); assert.ok(dir.split(/[\\/]/).pop().startsWith('dsh-grok-test-')); await rm(dir, { recursive: true }); });
  const baseURL = `http://127.0.0.1:${server.address().port}`;
  const options = { baseURL: baseURL + '/v1', resolveKey: async () => 'SECRET_KEY', dataDir: dir };
  const manager = new MediaManager(options); await manager.init();
  return { manager, options, baseURL };
}
const json = (res, body) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };

test('image result is saved immediately; credential and signed source do not escape', async t => {
  let calls = 0, downloaded = 0;
  const f = await fixture(t, (req, res) => {
    if (req.url === '/v1/images/generations') { calls++; assert.equal(req.headers.authorization, 'Bearer SECRET_KEY'); json(res, { data: [{ url: `http://${req.headers.host}/image?signature=PRIVATE` }] }); }
    else { downloaded++; assert.equal(req.headers.authorization, undefined); res.writeHead(200, { 'content-type': 'image/png' }); res.end(png); }
  });
  const result = await f.manager.image({ model: 'grok-imagine-image-2.0', prompt: 'blue circle' }, 'owner-a');
  assert.equal(result.status, 'saved'); assert.equal(calls, 1); assert.equal(downloaded, 1);
  assert.deepEqual(await readFile(result.files[0].path), png);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE|SECRET_KEY|signature|sources/);
  assert.throws(() => f.manager.get(result.id, 'other-owner'));
  assert.deepEqual(f.manager.list('other-owner'), []);
});
test('download retry survives restart and never repeats paid image submission', async t => {
  let creates = 0, gets = 0;
  const f = await fixture(t, (req, res) => {
    if (req.url === '/v1/images/generations') { creates++; json(res, { data: [{ url: `http://${req.headers.host}/image` }] }); }
    else if (++gets === 1) { res.writeHead(503); res.end(); }
    else { res.writeHead(200, { 'content-type': 'image/png' }); res.end(png); }
  });
  const failed = await f.manager.image({ model: 'image', prompt: 'hello' }, 's'); assert.equal(failed.status, 'download-failed');
  const restart = new MediaManager(f.options); await restart.init();
  const recovered = await restart.retryDownload(failed.id, 's'); assert.equal(recovered.status, 'saved'); assert.equal(creates, 1); assert.equal(gets, 2);
});
test('video remote ID and pending state survive restart then save completed video', async t => {
  let posts = 0, polls = 0;
  const f = await fixture(t, (req, res) => {
    if (req.url === '/v1/videos/generations') { posts++; json(res, { request_id: 'remote-123' }); }
    else if (req.url === '/v1/videos/remote-123') { polls++; json(res, polls === 1 ? { status: 'pending', progress: 20 } : { status: 'done', progress: 100, video: { url: `http://${req.headers.host}/video` } }); }
    else { assert.equal(req.headers.authorization, undefined); res.writeHead(200, { 'content-type': 'video/mp4' }); res.end(mp4); }
  });
  const submitted = await f.manager.video({ model: 'video', prompt: 'motion' }, 's'); assert.equal(submitted.status, 'generating');
  const pending = await f.manager.poll(submitted.id, 's'); assert.equal(pending.progress, 20);
  const restarted = new MediaManager(f.options); await restarted.init();
  await assert.rejects(restarted.poll(submitted.id, 'wrong-owner'));
  const done = await restarted.poll(submitted.id, 's'); assert.equal(done.status, 'saved'); assert.equal(posts, 1); assert.equal(done.remoteId, 'remote-123');
});
test('ambiguous submission is retained without automatic resubmission', async t => {
  let dispatches = 0;
  const f = await fixture(t, (_req, res) => res.end());
  const manager = new MediaManager({ ...f.options, fetchImpl: async () => { dispatches++; throw new Error('secret URL and key'); } }); await manager.init();
  const result = await manager.image({ model: 'image', prompt: 'hello' }, 's');
  assert.equal(result.status, 'submission-unknown'); assert.equal(dispatches, 1); assert.doesNotMatch(JSON.stringify(result), /secret URL/);
  await assert.rejects(manager.retryDownload(result.id, 's')); assert.equal(dispatches, 1);
  const restart = new MediaManager(f.options); await restart.init(); assert.equal(restart.get(result.id, 's').status, 'submission-unknown');
});
test('TTS saves audio; invalid video duration never dispatches', async t => {
  let calls = 0;
  const f = await fixture(t, (req, res) => { calls++; assert.equal(req.url, '/v1/audio/speech'); res.writeHead(200, { 'content-type': 'audio/mpeg' }); res.end(Buffer.from('ID3-test-audio')); });
  const audio = await f.manager.speech({ model: 'grok-tts', input: 'hello' }, 's'); assert.equal(audio.status, 'saved'); assert.equal(audio.files[0].mime, 'audio/mpeg');
  await assert.rejects(f.manager.video({ model: 'v', prompt: 'x', duration: 0 }, 's')); assert.equal(calls, 1);
});
test('rejects HTML media, unsafe schemes and download size excess', async t => {
  const f = await fixture(t, (req, res) => {
    if (req.url === '/v1/images/generations') json(res, { data: [{ url: `http://${req.headers.host}/image` }] });
    else { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<html>not an image</html>'); }
  });
  const result = await f.manager.image({ model: 'img', prompt: 'x' }, 's'); assert.equal(result.status, 'download-failed'); assert.equal(result.files.length, 0);
  for (const url of ['file:///secret', 'http://example.com/a', 'https://key@example.com/a', 'http://127.0.0.1:1/a']) assert.throws(() => f.manager.validateURL(url));
  const smaller = new MediaManager({ ...f.options, maxDownloadBytes: 4 }); await smaller.init();
  const tooBig = await smaller.retryDownload(result.id, 's'); assert.equal(tooBig.status, 'download-failed');
});
