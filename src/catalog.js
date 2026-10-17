const CATEGORIES = new Set(['chat', 'image', 'video', 'speech', 'research', 'unknown']);
const EFFORTS = new Set(['none', 'low', 'medium', 'high', 'xhigh']);

export function defaultReasoningEfforts(id) {
  if (/^grok-4\.[67](?:-|$)/.test(id)) return ['low', 'medium', 'high', 'xhigh'];
  if (/^grok-4\.5(?:-|$)/.test(id)) return ['low', 'medium', 'high'];
  if (/^grok-4\.3(?:-|$)/.test(id)) return ['none', 'low', 'medium', 'high', 'xhigh'];
  return [];
}

// xAI 文档写明 text, image → text 的聊天模型。旧的 grok-3 系列没有图片输入。
export function defaultImageSupported(id) {
  return /^grok-4\.[34567](?:-|$)/.test(id) || /^grok-4\.20(?:-|$)/.test(id) || /^grok-build-0\.1(?:-|$)/.test(id);
}

export function defaultContextWindow(id) {
  if (/^grok-4\.3(?:-|$)/.test(id)) return 1000000;
  if (/^grok-4\.[567](?:-|$)/.test(id)) return 500000;
  if (/^grok-build-0\.1(?:-|$)/.test(id)) return 256000;
  return 262144;
}

export function normalizeBaseURL(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('API 地址必须是无凭据、查询参数和片段的 HTTP(S) 根地址');
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('非本机 API 地址必须使用 HTTPS');
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith('/v1') ? path : path + '/v1';
  return url.href.replace(/\/$/, '');
}

function positive(value) { return Number.isSafeInteger(value) && value > 0 ? value : undefined; }

const HOME = process.env.HOME || process.env.USERPROFILE || '';

// 结果保存目录：支持 ~ 与 %VAR% / ${VAR} / $VAR 写法，用户可以直接粘贴 Windows 路径。
export function expandPath(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return '';
  return raw
    .replace(/^~(?=$|[\\/])/, HOME)
    .replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (whole, name) => process.env[name] ?? whole)
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (whole, name) => process.env[name] ?? whole)
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (whole, name) => process.env[name] ?? whole);
}

export function classifyModel(raw, override = {}) {
  const id = typeof raw === 'string' ? raw : raw?.id;
  if (typeof id !== 'string' || !id.trim() || id.length > 200) throw new Error('无效模型 ID');
  // 类型只看模型 ID：image 是生图，video 是视频，tts 是音频，其余都是聊天模型。
  const key = id.toLowerCase();
  let category = key.includes('image') ? 'image' : key.includes('video') ? 'video' : key.includes('tts') ? 'speech' : 'chat';
  // 只要给了覆盖项（不限于 category）就算显式配置，便于界面标出"已配"。
  const overridden = Object.keys(override).length > 0;
  const source = overridden ? 'override' : 'known-rule';
  if (override.category) {
    if (!CATEGORIES.has(override.category)) throw new Error('无效模型类别');
    category = override.category;
  }
  const spec = typeof raw === 'object' && raw !== null ? raw : {};
  // 空数组=显式声明"不支持思考等级"；未提供才回落到已知规则。
  // 依据 xAI 文档（2026-10）：4.7/4.6 含 xhigh；4.5 实际可用 low/medium/high；4.3 另支持 none。
  const efforts = Array.isArray(override.reasoningEfforts) ? override.reasoningEfforts : defaultReasoningEfforts(id);
  if (!Array.isArray(efforts) || efforts.some(x => !EFFORTS.has(x))) throw new Error('无效思考等级');
  // 图片支持优先级：显式 imageSupported > 完整 input 数组 > 上游声明 > 既有已知规则。
  // 显式布尔只负责切换图片，文本永远保留，避免用户把文本能力一起关掉。
  const upstreamInput = spec.inputModalities ?? spec.input_modalities ?? spec.modalities;
  const defaultInput = Array.isArray(upstreamInput) ? upstreamInput : (defaultImageSupported(id) ? ['text', 'image'] : ['text']);
  const input = typeof override.imageSupported === 'boolean'
    ? (override.imageSupported ? [...new Set(['text', 'image', ...defaultInput.filter(x => x !== 'text')])] : ['text'])
    : (override.input ?? defaultInput);
  if (!Array.isArray(input) || input.length === 0 || input.some(x => !['text', 'image'].includes(x))) throw new Error('无效输入模态');
  return {
    id, name: override.displayName || override.name || spec.name || id, category, source,
    verified: false,
    contextWindow: positive(override.contextWindow) ?? positive(spec.contextWindow) ?? positive(spec.context_window) ?? defaultContextWindow(id),
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

export function chatModels(catalog, overrides = []) {
  const selected = new Set(overrides.map(row => row?.id).filter(Boolean));
  if (!selected.size) return [];
  return catalog.filter(x => selected.has(x.id) && x.category === 'chat').map(x => ({
    id: x.id, name: x.name, contextWindow: x.contextWindow, maxTokens: x.maxTokens, input: x.input,
    ...(x.reasoningEfforts.length ? { reasoningEfforts: Object.fromEntries(x.reasoningEfforts.map(e => [e === 'none' ? 'off' : e, e === 'none' ? null : e])) } : {}),
  }));
}
