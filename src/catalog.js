const CATEGORIES = new Set(['chat', 'image', 'video', 'speech', 'research', 'unknown']);

export function normalizeBaseURL(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('API 地址必须是无凭据、查询参数和片段的 HTTP(S) 根地址');
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('非本机 API 地址必须使用 HTTPS');
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith('/v1') ? path : path + '/v1';
  return url.href.replace(/\/$/, '');
}

function positive(value) { return Number.isSafeInteger(value) && value > 0 ? value : undefined; }

export function classifyModel(raw, override = {}) {
  const id = typeof raw === 'string' ? raw : raw?.id;
  if (typeof id !== 'string' || !id.trim() || id.length > 200) throw new Error('无效模型 ID');
  let category = 'unknown';
  if (/^grok-imagine-image(?:-|$)/.test(id)) category = 'image';
  else if (/^grok-imagine-video(?:-|$)/.test(id)) category = 'video';
  else if (/^grok-(?:tts|voice-tts)(?:-|$)/.test(id)) category = 'speech';
  else if (/^grok-4\.20-multi-agent(?:-|$)/.test(id)) category = 'research';
  else if (/^grok-(?:4\.[3567](?:-|$)|build-0\.1$|composer-2\.5-fast$|3-mini(?:-fast)?$|4\.20-0309-(?:non-)?reasoning$)/.test(id)) category = 'chat';
  const source = override.category ? 'override' : category === 'unknown' ? 'unknown' : 'known-rule';
  if (override.category) {
    if (!CATEGORIES.has(override.category)) throw new Error('无效模型类别');
    category = override.category;
  }
  const spec = typeof raw === 'object' && raw !== null ? raw : {};
  const is47 = /^grok-4\.7(?:-|$)/.test(id);
  const is46 = /^grok-4\.6(?:-|$)/.test(id);
  const is45 = /^grok-4\.5(?:-|$)/.test(id);
  const efforts = override.reasoningEfforts ?? ((is47 || is46) ? ['low', 'medium', 'high', 'xhigh'] : is45 ? ['low', 'medium', 'high'] : []);
  if (!Array.isArray(efforts) || efforts.some(x => !['low', 'medium', 'high', 'xhigh'].includes(x))) throw new Error('无效思考等级');
  const input = override.input ?? spec.inputModalities ?? ((is47 || is46 || is45) ? ['text', 'image'] : ['text']);
  if (!Array.isArray(input) || input.length === 0 || input.some(x => !['text', 'image'].includes(x))) throw new Error('无效输入模态');
  return {
    id, name: override.name || spec.name || id, category, source,
    verified: false,
    contextWindow: positive(override.contextWindow) ?? positive(spec.contextWindow) ?? positive(spec.context_window) ?? ((is47 || is46 || is45) ? 500000 : 262144),
    maxTokens: positive(override.maxTokens) ?? positive(spec.maxTokens) ?? positive(spec.max_output_tokens) ?? 32768,
    input, reasoningEfforts: efforts,
  };
}

export function readCatalog(body, overrides = []) {
  if (!body || !Array.isArray(body.data) || body.data.length > 2000) throw new Error('模型接口必须返回有界的 data 数组');
  const byId = new Map(overrides.map(x => [x.id, x]));
  const seen = new Set();
  return body.data.flatMap(raw => {
    if (!raw?.id || seen.has(raw.id)) return [];
    seen.add(raw.id);
    return [classifyModel(raw, byId.get(raw.id))];
  });
}

export function chatModels(catalog) {
  return catalog.filter(x => x.category === 'chat').map(x => ({
    id: x.id, name: x.name, contextWindow: x.contextWindow, maxTokens: x.maxTokens, input: x.input,
    ...(x.reasoningEfforts.length ? { reasoningEfforts: Object.fromEntries(x.reasoningEfforts.map(e => [e, e])) } : {}),
  }));
}
