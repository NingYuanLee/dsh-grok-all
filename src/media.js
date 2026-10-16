import { mkdir, readdir, readFile, writeFile, rename, unlink, open } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const now = () => new Date().toISOString();
const mimeTypes = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif', 'video/mp4': '.mp4', 'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/x-wav': '.wav' };
class HttpFailure extends Error { constructor(status) { super('上游请求失败：HTTP ' + status); this.status = status; } }
function sniff(bytes) {
  if (bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.subarray(0,3).toString() === 'GIF') return 'image/gif';
  if (bytes.subarray(0,4).toString() === 'RIFF') return bytes.subarray(8,12).toString() === 'WEBP' ? 'image/webp' : bytes.subarray(8,12).toString() === 'WAVE' ? 'audio/wav' : undefined;
  if (bytes.subarray(4,8).toString() === 'ftyp') return 'video/mp4';
  if (bytes.subarray(0,3).toString() === 'ID3' || bytes[0] === 255 && (bytes[1] & 224) === 224) return 'audio/mpeg';
}
async function bounded(response, limit, signal) {
  if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw new Error('响应超过大小限制'); }
  const parts = []; let count = 0;
  const reader = response.body?.getReader();
  if (!reader) throw new Error('响应没有内容');
  try { for (;;) { signal?.throwIfAborted(); const { done, value } = await reader.read(); if (done) break; count += value.length; if (count > limit) throw new Error('响应超过大小限制'); parts.push(value); } }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return Buffer.concat(parts, count);
}

export class MediaManager {
  constructor({ baseURL, resolveKey, dataDir, fetchImpl = fetch, timeoutMs = 60000, maxDownloadBytes = 268435456 }) {
    this.baseURL = baseURL.replace(/\/$/, ''); this.resolveKey = resolveKey; this.root = resolve(dataDir, 'tasks');
    this.fetch = fetchImpl; this.timeoutMs = timeoutMs; this.maxBytes = maxDownloadBytes; this.tasks = new Map(); this.locks = new Map();
  }
  async init() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    for (const entry of await readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !ID.test(entry.name)) continue;
      try {
        const raw = await readFile(join(this.root, entry.name, 'task.json'), 'utf8');
        if (raw.length > 48 * 1024 * 1024) continue;
        const task = JSON.parse(raw);
        if (task.id !== entry.name || typeof task.owner !== 'string' || !['image','video','speech'].includes(task.kind)) continue;
        if (!Array.isArray(task.files) || !Array.isArray(task.sources)) continue;
        // Records never authorize arbitrary saved paths after restart.
        task.files = task.files.filter(f => typeof f.name === 'string' && /^result-\d+\.(png|jpg|gif|webp|mp4|mp3|wav)$/.test(f.name));
        if (task.status === 'submitting') { task.status = 'submission-unknown'; task.error = '上次提交中断，结果未知，请勿自动重新生成'; }
        if (task.status === 'downloading') { task.status = 'download-failed'; task.error = '保存中断，可重试下载已有结果'; }
        this.tasks.set(task.id, task); await this.persist(task);
      } catch { /* Corrupt records are not adopted into another session. */ }
    }
  }
  directory(task) { return join(this.root, task.id); }
  async persist(task) {
    task.updatedAt = now(); await mkdir(this.directory(task), { recursive: true, mode: 0o700 });
    const file = join(this.directory(task), 'task.json'); const temp = file + '.' + randomUUID() + '.tmp';
    await writeFile(temp, JSON.stringify(task), { mode: 0o600 }); await rename(temp, file);
  }
  public(task) {
    const { id, owner, kind, model, status, remoteId, progress, error, createdAt, updatedAt } = task;
    return { id, owner, kind, model, status, ...(remoteId ? { remoteId } : {}), ...(Number.isFinite(progress) ? { progress } : {}), ...(error ? { error } : {}), createdAt, updatedAt,
      files: task.files.map(f => ({ path: join(this.directory(task), f.name), mime: f.mime, size: f.size })) };
  }
  lookup(id, owner) {
    const task = this.tasks.get(id);
    if (!ID.test(id) || !task || task.owner !== owner) throw new Error('任务不存在或不属于当前会话');
    return task;
  }
  get(id, owner) { return this.public(this.lookup(id, owner)); }
  list(owner) { return [...this.tasks.values()].filter(t => t.owner === owner).sort((a,b) => b.createdAt.localeCompare(a.createdAt)).map(t => this.public(t)); }
  async locked(id, operation) {
    if (this.locks.has(id)) throw new Error('该任务正在处理，请稍后查询');
    const running = operation(); this.locks.set(id, running);
    try { return await running; } finally { this.locks.delete(id); }
  }
  signal(signal) { return AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(this.timeoutMs)]); }
  async api(path, payload, signal) {
    signal?.throwIfAborted(); const key = await this.resolveKey();
    return this.fetch(this.baseURL + path, { method: payload === undefined ? 'GET' : 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }), redirect: 'error', signal });
  }
  async json(response, signal) {
    if (!response.ok) { await response.body?.cancel(); throw new HttpFailure(response.status); }
    return JSON.parse((await bounded(response, 32 * 1024 * 1024, signal)).toString('utf8'));
  }
  validateURL(value) {
    const url = new URL(value); const base = new URL(this.baseURL);
    if (url.username || url.password || url.hash) throw new Error('无效媒体链接');
    const local = ['127.0.0.1','localhost','[::1]'].includes(url.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local && url.origin === base.origin)) throw new Error('媒体链接必须使用 HTTPS');
    if (local && url.origin !== base.origin) throw new Error('拒绝跨服务本机媒体链接');
    return url;
  }
  async download(url, signal) {
    let current = this.validateURL(url);
    for (let n = 0; n <= 5; n++) {
      // Intentionally no API Authorization or cookies, even on same-origin URLs.
      const response = await this.fetch(current, { redirect: 'manual', signal, credentials: 'omit' });
      if ([301,302,303,307,308].includes(response.status)) {
        const location = response.headers.get('location'); await response.body?.cancel();
        if (!location || n === 5) throw new Error('媒体重定向失败');
        current = this.validateURL(new URL(location, current).href); continue;
      }
      if (!response.ok) { await response.body?.cancel(); throw new Error('媒体下载失败'); }
      return { bytes: await bounded(response, this.maxBytes, signal), declared: response.headers.get('content-type')?.split(';')[0] };
    }
  }
  async saveResults(task, signal) {
    task.status = 'downloading'; delete task.error; await this.persist(task);
    try {
      if (!task.sources.length) throw new Error('没有可保存的结果');
      for (let i = task.files.length; i < task.sources.length; i++) {
        signal?.throwIfAborted(); const source = task.sources[i];
        let bytes, declared;
        if (source.b64) { if (!/^[A-Za-z0-9+/]*={0,2}$/.test(source.b64)) throw new Error('无效图片编码'); bytes = Buffer.from(source.b64, 'base64'); }
        else if (source.raw) { bytes = Buffer.from(source.raw, 'base64'); }
        else ({ bytes, declared } = await this.download(source.url, signal));
        if (!bytes.length || bytes.length > this.maxBytes) throw new Error('结果大小无效');
        const mime = sniff(bytes);
        const prefix = task.kind === 'speech' ? 'audio/' : task.kind + '/';
        if (!mime?.startsWith(prefix) || !mimeTypes[mime] || declared?.includes('text/html')) throw new Error('结果不是期望的媒体文件');
        const name = 'result-' + (i+1) + mimeTypes[mime]; const path = join(this.directory(task), name); const partial = path + '.part';
        const handle = await open(partial, 'w', 0o600);
        try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
        await rename(partial, path); task.files.push({ name, mime, size: bytes.length });
        await this.persist(task);
      }
      task.status = 'saved'; delete task.error;
      // Inline media no longer needs a duplicate payload once safely saved.
      task.sources = task.sources.map(s => s.url ? { url: s.url } : {});
    } catch {
      task.status = 'download-failed'; task.error = '结果保存失败（网络、格式或文件系统限制），可重试下载；不会重新生成';
    }
    await this.persist(task); return this.public(task);
  }
  async create(kind, args, owner, signal) {
    if (typeof owner !== 'string' || !owner || typeof args.model !== 'string' || !args.model) throw new Error('缺少任务归属或模型');
    const text = kind === 'speech' ? args.input : args.prompt;
    if (typeof text !== 'string' || !text.trim() || text.length > 60000) throw new Error('生成内容不能为空或超过 60000 字符');
    if (kind === 'image' && (!Number.isInteger(args.n ?? 1) || (args.n ?? 1) < 1 || (args.n ?? 1) > 4)) throw new Error('图片数量必须为 1 到 4');
    if (kind === 'video' && (!Number.isInteger(args.duration ?? 2) || (args.duration ?? 2) < 1 || (args.duration ?? 2) > 15)) throw new Error('视频时长必须为 1 到 15 秒');
    signal?.throwIfAborted();
    // Resolve missing credentials before creating a potentially ambiguous task.
    await this.resolveKey();
    const task = { id: randomUUID(), owner, kind, model: args.model, status: 'submitting', files: [], sources: [], createdAt: now(), updatedAt: now() };
    this.tasks.set(task.id, task); await this.persist(task);
    return this.locked(task.id, async () => {
      const active = this.signal(signal); let accepted = false;
      try {
        const path = kind === 'image' ? '/images/generations' : kind === 'video' ? '/videos/generations' : '/audio/speech';
        const payload = kind === 'speech' ? { model: args.model, input: text, voice: args.voice || 'eve', response_format: 'mp3' } : { model: args.model, prompt: text, ...(kind === 'image' ? { n: args.n ?? 1 } : { duration: args.duration ?? 2 }) };
        const response = await this.api(path, payload, active);
        if (!response.ok) { await response.body?.cancel(); throw new HttpFailure(response.status); }
        accepted = true;
        if (kind === 'speech') {
          task.sources = [{ raw: (await bounded(response, Math.min(this.maxBytes, 32 * 1024 * 1024), active)).toString('base64') }];
        } else {
          const body = await this.json(response, active);
          if (kind === 'video') {
            if (typeof body.request_id !== 'string' || !body.request_id || body.request_id.length > 300) throw new Error('视频响应缺少任务 ID');
            task.remoteId = body.request_id; task.status = 'generating'; await this.persist(task); return this.public(task);
          }
          if (!Array.isArray(body.data) || body.data.length < 1 || body.data.length > 4) throw new Error('图片响应无结果');
          task.sources = body.data.map(x => typeof x.url === 'string' ? { url: x.url } : typeof x.b64_json === 'string' ? { b64: x.b64_json } : {});
        }
        return await this.saveResults(task, active);
      } catch (error) {
        task.status = error instanceof HttpFailure ? 'failed' : 'submission-unknown';
        task.error = error instanceof HttpFailure ? error.message : accepted ? '上游已接受请求，但未取得完整结果，请勿自动重复生成' : '提交结果未知，请检查上游记录，不要自动重新生成';
        await this.persist(task); return this.public(task);
      }
    });
  }
  image(args, owner, signal) { return this.create('image', args, owner, signal); }
  speech(args, owner, signal) { return this.create('speech', args, owner, signal); }
  video(args, owner, signal) { return this.create('video', args, owner, signal); }
  async poll(id, owner, signal) {
    const task = this.lookup(id, owner);
    if (task.kind !== 'video' || !task.remoteId || ['saved','failed'].includes(task.status)) return this.public(task);
    return this.locked(id, async () => {
      const active = this.signal(signal);
      try {
        const body = await this.json(await this.api('/videos/' + encodeURIComponent(task.remoteId), undefined, active), active);
        if (Number.isFinite(body.progress)) task.progress = Math.max(0, Math.min(100, body.progress));
        if (body.status === 'done' && typeof body.video?.url === 'string') { task.sources = [{ url: body.video.url }]; return await this.saveResults(task, active); }
        if (['failed', 'error', 'expired'].includes(body.status)) { task.status = 'failed'; task.error = '上游视频任务失败或已过期'; }
        else { task.status = 'generating'; delete task.error; }
      } catch { task.error = '暂时无法查询，保留原任务 ID，稍后可以继续查询'; }
      await this.persist(task); return this.public(task);
    });
  }
  async retryDownload(id, owner, signal) {
    const task = this.lookup(id, owner);
    if (task.status === 'saved') return this.public(task);
    if (task.kind === 'video' && task.remoteId && !task.sources.length) return this.poll(id, owner, signal);
    if (!task.sources.length) throw new Error('该任务没有可恢复的下载结果，不能以重试下载方式重新生成');
    return this.locked(id, () => this.saveResults(task, this.signal(signal)));
  }
}
