import React, { useEffect, useRef, useState } from 'react';

const EFFORT_ORDER = ['none', 'low', 'medium', 'high', 'xhigh'];
function defaultImageSupported(id) {
  return /^grok-4\.[34567](?:-|$)/.test(id) || /^grok-4\.20(?:-|$)/.test(id) || /^grok-build-0\.1(?:-|$)/.test(id);
}
function defaultReasoningEfforts(id) {
  if (/^grok-4\.[67](?:-|$)/.test(id)) return ['low', 'medium', 'high', 'xhigh'];
  if (/^grok-4\.5(?:-|$)/.test(id)) return ['low', 'medium', 'high'];
  if (/^grok-4\.3(?:-|$)/.test(id)) return ['none', 'low', 'medium', 'high', 'xhigh'];
  return [];
}

export const inject = ['slots', 'documentPreviews', 'remote', 'remote.llm', 'remote.settings', 'remote.credentials'];
const h = React.createElement;
const MEDIA_ID = 'dsh-grok-byapi/media-preview';
// 设置命名空间 = Grok ByAPI 这一行在 profile 里的实例 id（cordis.patch.yml 的 - id:）。
const SETTINGS_NS = 'grok-byapi';
// 包名 = 插件管理器里「插件包」那一行的标识，槽位 key 用的是它
const PKG_NAME = 'dsh-grok-byapi';
// 与 Config.connection.baseURL 的 schema 默认值一致。详情页没有表单，首屏 connection 是空的。
const DEFAULT_BASE_URL = 'http://127.0.0.1:8317/v1';
function resolveBaseURL(source) {
  const raw = source?.connection?.baseURL;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : DEFAULT_BASE_URL;
}
function readSettingsEntry(found) {
  const payload = found?.ok ? found.value : found;
  const listed = Array.isArray(payload) ? payload : payload?.namespaces;
  const entry = Array.isArray(listed) ? listed.find(row => row?.ns === SETTINGS_NS) : listed?.[SETTINGS_NS];
  const next = entry?.value || entry;
  if (!next || typeof next !== 'object' || !(next.connection || next.media || next.modelOverrides)) return null;
  return { value: next, revision: entry?.revision ?? 0 };
}
function discoveryErrorText(message) {
  if (typeof message === 'string' && /provider route or a baseURL/.test(message)) return '还没有可用的 API 地址，无法获取模型。';
  return message;
}
const states = {
  submitting: '提交中', generating: '生成中', downloading: '正在保存', saved: '已保存',
  failed: '失败', 'submission-unknown': '提交结果未知，请勿重复生成',
  'download-failed': '生成完成，保存失败，可重试下载',
};
const tools = ['grok_generate_image', 'grok_generate_video', 'grok_speak', 'grok_media_status', 'grok_media_retry_download', 'grok_media_list', 'grok_models'];

export function resultValue(block) {
  try { return JSON.parse((block?.content || []).filter(x => x.type === 'text').map(x => x.text).join('\n')); }
  catch { return undefined; }
}

export function GrokToolCard({ toolName, phase, block, openFile }) {
  if (phase !== 'result') return h('div', { role: 'status', style: { padding: 10 } }, 'Grok · 正在执行 ', toolName);
  const value = resultValue(block);
  const tasks = Array.isArray(value) ? value : value?.id ? [value] : [];
  if (!value || block?.isError) return h('div', { role: 'alert', style: { padding: 10 } }, 'Grok · ', block?.content?.filter(x => x.type === 'text').map(x => x.text).join('\n') || '调用失败');
  if (value.models) return h('details', { style: { padding: 10 } }, h('summary', null, `Grok 模型目录 · ${value.models.length} 个`),
    value.error ? h('p', { role: 'alert' }, value.error) : null,
    ...['chat', 'image', 'video', 'speech', 'research', 'unknown'].map(category => h('div', { key: category }, h('strong', null, category + '：'), value.models.filter(x => x.category === category).map(x => x.id).join('、') || '无')));
  return h('div', { style: { padding: 12, border: '1px solid var(--border-color, #8885)', borderRadius: 8 } },
    ...tasks.map(task => h('div', { key: task.id, style: { marginBottom: 8 } },
      h('strong', null, `Grok ${task.kind || ''} · ${states[task.status] || task.status}`),
      h('div', null, task.model),
      h('div', null, '任务：', task.id),
      Number.isFinite(task.progress) ? h('div', null, `上游进度：${task.progress}%`) : null,
      task.error ? h('p', { role: 'alert' }, typeof task.error === 'string' ? task.error : JSON.stringify(task.error)) : null,
      ...(task.files || []).map(file => h('button', { key: file.path, type: 'button', onClick: () => openFile?.(file.path), disabled: !openFile, style: { display: 'block', marginTop: 6 } }, '打开结果 · ', file.path.split(/[\\/]/).pop())),
      ['generating', 'submitting'].includes(task.status) ? h('small', null, '调用 grok_media_status 查询原任务；本卡片显示该次调用记录的状态。') : null,
    )), tasks.length ? null : h('pre', { style: { whiteSpace: 'pre-wrap' } }, JSON.stringify(value, null, 2)));
}

export function MediaPreview({ content }) {
  const [url, setUrl] = useState(null);
  const [failed, setFailed] = useState(false);
  const data = content?.kind === 'bytes' ? content.data : undefined;
  useEffect(() => {
    if (!data) { setUrl(null); return; }
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    const audio = bytes.length >= 3 && ((bytes[0] === 0x49 && bytes[1] === 0x44) || (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) || (bytes[0] === 0x52 && bytes[1] === 0x49));
    const objectUrl = URL.createObjectURL(new Blob([bytes], { type: audio ? (bytes[0] === 0x52 ? 'audio/wav' : 'audio/mpeg') : 'video/mp4' }));
    setUrl({ value: objectUrl, audio }); setFailed(false);
    return () => URL.revokeObjectURL(objectUrl);
  }, [data]);
  if (!url) return h('p', { role: 'status' }, '正在加载媒体文件…');
  return h('div', { style: { padding: 16 } },
    failed ? h('p', { role: 'alert' }, '当前客户端无法播放该文件。请使用文件卡片在系统应用中打开。') : null,
    h(url.audio ? 'audio' : 'video', { src: url.value, controls: true, preload: 'metadata', onError: () => setFailed(true), style: { width: '100%', maxHeight: '75vh' } }));
}

const KEY_REF = 'GROK_ALL_API_KEY';
const ui = {
  page: { maxWidth: 860, display: 'grid', gap: 16, color: 'var(--dsw-alias-label-primary)' },
  card: { border: '0.5px solid var(--dsw-alias-settings-card-stroke, var(--dsw-alias-border-l4))', background: 'var(--dsw-alias-settings-card-fill, var(--dsw-alias-bg-layer-2))', borderRadius: 'var(--dsw-radius-xl, 20px)', padding: 16, display: 'grid', gap: 12 },
  title: { margin: 0, fontSize: 14, fontWeight: 600 },
  hint: { margin: 0, color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, lineHeight: 1.5 },
  label: { display: 'grid', gap: 6, color: 'var(--dsw-alias-label-secondary)', fontSize: 12 },
  control: { height: 36, boxSizing: 'border-box', font: 'inherit', fontSize: 13, padding: '0 12px', color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-1)', border: '0.5px solid var(--dsw-alias-border-l2)', borderRadius: 'var(--dsw-radius-md, 12px)' },
  button: { height: 32, padding: '0 14px', font: 'inherit', fontSize: 13, color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-1)', border: '0.5px solid var(--dsw-alias-border-l2)', borderRadius: 'var(--dsw-radius-sm, 8px)', cursor: 'pointer' },
  primary: { height: 32, padding: '0 14px', font: 'inherit', fontSize: 13, color: 'var(--dsw-alias-bg-base, #fff)', background: 'var(--dsw-alias-button-primary-fill, var(--dsw-alias-brand-primary))', border: 0, borderRadius: 'var(--dsw-radius-sm, 8px)', cursor: 'pointer' },
  row: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
  table: { width: '100%', borderCollapse: 'separate', borderSpacing: 0, fontSize: 12 },
  head: { textAlign: 'left', padding: '8px 6px', color: 'var(--dsw-alias-label-tertiary)', fontWeight: 500, borderBottom: '0.5px solid var(--dsw-alias-border-l3)' },
  status: { margin: 0, color: 'var(--dsw-alias-label-secondary)', fontSize: 12 },
  alert: { margin: 0, color: 'var(--dsw-alias-state-error-primary)', fontSize: 12 },
};
// 与官方模型配置同一套写法：密钥写进 dsh 凭据库（credentials/set），
// 配置里只保留引用名 apiKeyEnv；输入框 type=password，草稿留空表示沿用已存密钥。
const LEGAL_API_KEY = /^[\x21-\x7E]+$/;
function keyFailureOf(draft) {
  if (draft.length === 0) return undefined;
  const value = draft.trim();
  if (value.length === 0) return '不能只有空白字符；想沿用已存密钥请留空。';
  if (!LEGAL_API_KEY.test(value)) return '密钥只能是可打印 ASCII 字符，不能有空格、引号或换行；请只粘贴密钥本身。';
  return undefined;
}

const SIZE_UNITS = { '': 1, k: 1000, m: 1000000 };
// 官方支持的思考强度：4.7/4.6 含 xhigh，4.5 三档，4.3 另有 none；这里列出全部可选值，勾选即声明。
const ALL_EFFORTS = EFFORT_ORDER;
const MEDIA_FIELDS = [
  ['imageModel', '生成图片', '启用生成图片', ['grok-imagine-image']],
  ['videoModel', '生成视频', '启用生成视频', ['grok-imagine-video']],
  ['speechModel', '生成音频', '启用生成音频', ['grok-tts', 'grok-voice-tts']],
];
function blankChatRow(isDefault = false) {
  return { id: '', displayName: '', contextWindow: '', maxTokens: '', image: false, efforts: [], isDefault };
}
function EffortPicker({ index, efforts, disabled, onChange }) {
  const [open, setOpen] = useState(false);
  const root = useRef(null);
  const selected = Array.isArray(efforts) ? efforts : [];
  const summary = selected.length ? selected.join(', ') : '未设置';
  useEffect(() => {
    if (!open) return undefined;
    const close = event => {
      if (root.current && root.current.contains(event.target)) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [open]);
  return h('div', { ref: root, style: { position: 'relative', minWidth: 148 } },
    h('button', {
      type: 'button', disabled, 'aria-label': '思考强度 ' + index, 'aria-expanded': open ? 'true' : 'false',
      onClick: () => setOpen(value => !value),
      style: { ...ui.control, height: 32, width: '100%', padding: '0 8px', textAlign: 'left', cursor: disabled ? 'default' : 'pointer' },
    }, summary),
    open ? h('div', {
      role: 'group', 'aria-label': '思考强度选项 ' + index,
      style: { position: 'absolute', zIndex: 20, top: 36, left: 0, minWidth: 148, display: 'grid', gap: 6, padding: 8,
        background: 'var(--dsw-alias-bg-layer-2, var(--dsw-alias-bg-layer-1))', border: '0.5px solid var(--dsw-alias-border-l2)', borderRadius: 'var(--dsw-radius-md, 12px)' },
    }, ...ALL_EFFORTS.map(level => h('label', { key: level, style: { display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 } },
      h('input', {
        type: 'checkbox', checked: selected.includes(level), 'aria-label': '思考强度 ' + level + ' ' + index,
        onChange: event => {
          const next = event.target.checked ? [...selected, level] : selected.filter(item => item !== level);
          onChange(ALL_EFFORTS.filter(item => next.includes(item)));
        },
      }),
      level))) : null);
}

// 尺寸输入：支持 500K / 1M 这类写法，也接受纯数字。
function parseSize(text) {
  const value = String(text ?? '').trim();
  if (!value) return undefined;
  const matched = /^(\d+(?:\.\d+)?)\s*([kKmM]?)$/.exec(value);
  if (!matched) return undefined;
  const amount = Number(matched[1]) * SIZE_UNITS[matched[2].toLowerCase()];
  return Number.isSafeInteger(amount) && amount > 0 ? amount : undefined;
}
function formatSize(value) {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) return '';
  if (n % SIZE_UNITS.m === 0) return n / SIZE_UNITS.m + 'M';
  if (n % SIZE_UNITS.k === 0) return n / SIZE_UNITS.k + 'K';
  return String(n);
}
// 只读的提供商信息：模型配置弹窗里的「编辑」按钮打开的就是这里。
export function GrokProviderNotice({ view, form }) {
  const value = form?.state?.value;
  if (view === 'summary') return h('span', null, 'Grok 提供商（只读）');
  const connection = value?.connection || {};
  const baseURL = resolveBaseURL(value);
  const rows = [
    ['提供商 ID', 'xAI-CLIProxyAPI'],
    ['API 地址', baseURL],
    ['API Key', 'dsh 凭据库 · ' + KEY_REF],
    ['模型来源', '上游 /v1/models 发现 + 本页显式配置'],
    ['详细配置位置', '插件 → ' + PKG_NAME + ' → Grok ByAPI'],
  ];
  return h('section', { style: { maxWidth: 680, padding: '16px 0' } },
    h('h3', null, 'Grok 提供商'),
    h('p', { style: { opacity: 0.8, fontSize: 12, marginBottom: 12 } }, '此页只读。改地址、密钥和模型请到「插件 → ' + PKG_NAME + ' → Grok ByAPI」。'),
    h('table', { style: { width: '100%', borderCollapse: 'collapse', fontSize: 12 } },
      h('tbody', null, ...rows.map(([k, v]) => h('tr', { key: k },
        h('td', { style: { padding: '4px 8px 4px 0', opacity: 0.75, whiteSpace: 'nowrap' } }, k),
        h('td', { style: { padding: '4px 0' } }, h('code', null, String(v))))))));
}

export function GrokSettings(props) {
  const view = props?.view;
  // 插件管理器只在「组件 grok-byapi」这一行注入 { state, mutate }。
  // 包详情页没有表单，也不能从这里自己去读设置。
  const form = props?.form?.state ? props.form : null;
  const remote = props?.remote;
  const [draft, setDraft] = useState(null);
  const [keyDraft, setKeyDraft] = useState('');
  const [message, setMessage] = useState('');
  const [discoverNotice, setDiscoverNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [discovered, setDiscovered] = useState(null);
  const [categoryOf, setCategoryOf] = useState({});
  const [nameOf, setNameOf] = useState({});
  const [specOf, setSpecOf] = useState({});
  const [rows, setRows] = useState(null);
  const [mediaOn, setMediaOn] = useState({});
  const [loaded, setLoaded] = useState(form?.state?.value ? null : { connection: {}, media: {}, modelOverrides: [] });
  const [revision, setRevision] = useState(null);
  const [chatOpen, setChatOpen] = useState(false);
  const [mediaOpen, setMediaOpen] = useState(false);
  const accepted = form?.state?.value || loaded;
  const value = draft || accepted;
  // 详情页不带表单。自动获取必须等这份配置回来，否则首屏空地址会被宿主拒绝。
  // 每次 effect 换一个 promise：严格模式先卸载再挂载时，不能让第一次的空结果关掉下一次。
  const settingsGate = useRef({ generation: 0, ready: Promise.resolve(null) });
  useEffect(() => {
    const generation = ++settingsGate.current.generation;
    let resolveGate = () => {};
    const ready = new Promise(resolve => { resolveGate = resolve; });
    settingsGate.current.ready = ready;
    const finish = next => { if (generation === settingsGate.current.generation) resolveGate(next); };
    if (form?.state?.value || !remote?.settings?.describe) {
      finish(form?.state?.value || null);
      return () => { finish(null); };
    }
    let live = true;
    remote.settings.describe().then(found => {
      const entry = readSettingsEntry(found);
      if (!live || generation !== settingsGate.current.generation) return;
      if (!entry) {
        setMessage('没有读到已保存的 Grok ByAPI 配置，先按默认值显示。');
        finish(null);
        return;
      }
      setLoaded(entry.value);
      setRevision(entry.revision);
      finish(entry.value);
    }).catch(error => {
      if (generation !== settingsGate.current.generation) return;
      if (live) setMessage('读取已保存配置失败，先按默认值显示：' + (error?.message || '未知错误'));
      finish(null);
    });
    return () => { live = false; finish(null); };
  }, []);
  useEffect(() => { setDraft(null); }, [form?.state?.revision, revision]);
  const autoRan = useRef(false);
  const media = value?.media || {};
  const ids = discovered || [];
  // 已配置的模型即使还没点「获取模型」也要能显示和编辑。
  const savedRows = (value?.modelOverrides || []).map(o => ({
    id: o.id, displayName: o.displayName || o.id,
    contextWindow: formatSize(o.contextWindow), maxTokens: formatSize(o.maxTokens),
    image: o.imageSupported === true, efforts: Array.isArray(o.reasoningEfforts) ? o.reasoningEfforts : [],
    isDefault: (media.defaultModel || '') === o.id,
  }));
  const rowList = rows || (savedRows.length ? savedRows : [blankChatRow(true)]);

  const setCredential = async (ref, secret) => {
    const response = await remote?.credentials?.set(ref, secret);
    if (response === undefined) throw new Error('当前页面保存不了密钥');
    return response.ok ? undefined : response.error?.message || '凭据写入失败';
  };
  const field = (section, key, label) => h('label', { key: section + key, style: ui.label }, label,
    h('input', { type: 'text', value: value[section]?.[key] ?? '', disabled: busy,
      onChange: event => setDraft({ ...value, [section]: { ...value[section], [key]: event.target.value } }),
      style: ui.control }));
  const setMedia = (key, patch) => setDraft({ ...value, media: { ...media, ...patch } });

  const mediaOptions = (prefixes, key) => {
    const saved = (value.modelOverrides || []).map(row => row.id).filter(id => prefixes.some(prefix => id === prefix || id.startsWith(prefix)));
    const listed = discovered ? ids.filter(id => prefixes.some(prefix => id === prefix || id.startsWith(prefix))) : [];
    const current = typeof media[key] === 'string' ? media[key] : '';
    return [...new Set([...(current ? [current] : []), ...saved, ...listed])];
  };
  // 已保存的模型先回显。获取后再并入清单并去重；勾选只在选中模型后可用。
  const mediaPicker = (key, label, enableLabel, prefixes) => {
    const options = mediaOptions(prefixes, key);
    const current = options.includes(media[key]) ? media[key] : '';
    const enabled = !!current && mediaOn[key] === true;
    return h('div', { key: 'media' + key, style: { display: 'grid', gridTemplateColumns: '1fr auto', gap: 8, alignItems: 'end' } },
      h('label', { style: ui.label }, label,
        h('select', { value: current, disabled: busy, 'aria-label': label,
          onChange: event => {
            setMedia(key, { [key]: event.target.value });
            setMediaOn(state => ({ ...state, [key]: false }));
          },
          style: ui.control },
          h('option', { value: '' }, options.length || discovered ? '不使用' : '先获取模型'),
          ...options.map(id => h('option', { key: id, value: id }, id)))),
      h('label', { style: { ...ui.label, display: 'flex', alignItems: 'center', gap: 6, height: 36 } },
        h('input', {
          type: 'checkbox', checked: enabled, disabled: busy || !current, 'aria-label': enableLabel,
          onChange: event => setMediaOn(state => ({ ...state, [key]: event.target.checked })),
        }),
        '启用'));
  };

  const chatIdOptions = exclude => {
    const excluded = ['image', 'video', 'speech'];
    const saved = (value.modelOverrides || []).map(row => row.id).filter(id => id && !excluded.includes(categoryOf[id]));
    const listed = discovered ? ids.filter(id => !excluded.includes(categoryOf[id])) : [];
    const list = [...new Set([...saved, ...listed])];
    const taken = new Set(rowList.filter(r => r.id !== exclude).map(r => r.id).filter(Boolean));
    return list.filter(id => !taken.has(id) || id === exclude);
  };

  async function discover(source) {
    const current = source === undefined ? value : source;
    const baseURL = resolveBaseURL(current);
    const mediaNow = current?.media || {};
    setDiscovering(true); setMessage(''); setDiscoverNotice(null);
    try {
      const api = remote?.llm;
      if (!api?.discoverModels) { setDiscoverNotice({ ok: false, text: '当前页面没有模型发现接口，请改用 grok_models 工具。' }); return; }
      const request = { baseURL, api: current?.connection?.api === 'openai-completions' ? 'openai-completions' : 'openai-responses' };
      if (keyDraft.trim()) request.apiKey = keyDraft.trim();
      const found = await api.discoverModels(SETTINGS_NS, request);
      // 远程调用返回 { ok, value }；测试和宿主直连则直接给数组。
      const listed = Array.isArray(found) ? found : (found?.ok ? found.value : undefined);
      if (!Array.isArray(listed)) {
        const raw = found?.error?.message;
        setDiscoverNotice({ ok: false, text: discoveryErrorText(raw) || '获取模型失败：返回的不是模型列表。' });
        return;
      }
      const models = listed.map(m => ({
        id: m.id, name: m.name, category: m.category || (String(m.id).toLowerCase().includes('image') ? 'image' : String(m.id).toLowerCase().includes('video') ? 'video' : String(m.id).toLowerCase().includes('tts') ? 'speech' : 'chat'),
        contextWindow: m.contextWindow, maxTokens: m.maxTokens,
        input: Array.isArray(m.inputModalities) ? m.inputModalities : ['text'],
      }));
      const byCategory = new Map();
      const names = new Map();
      const specs = new Map();
      for (const m of models) {
        byCategory.set(m.id, m.category || '');
        names.set(m.id, m.name || m.id);
        specs.set(m.id, {
          contextWindow: m.contextWindow,
          maxTokens: m.maxTokens,
          image: defaultImageSupported(m.id) || (Array.isArray(m.input) && m.input.includes('image')),
          efforts: defaultReasoningEfforts(m.id),
        });
      }
      setDiscovered(models.map(m => m.id));
      setCategoryOf(Object.fromEntries(byCategory));
      setNameOf(Object.fromEntries(names));
      setSpecOf(Object.fromEntries(specs));
      const nextRows = (current?.modelOverrides || []).map(o => ({
        id: o.id, displayName: o.displayName || names.get(o.id) || o.id,
        contextWindow: formatSize(o.contextWindow), maxTokens: formatSize(o.maxTokens),
        image: o.imageSupported !== false && (o.imageSupported === true || defaultImageSupported(o.id)), efforts: Array.isArray(o.reasoningEfforts) && o.reasoningEfforts.length ? o.reasoningEfforts : defaultReasoningEfforts(o.id),
        isDefault: (mediaNow.defaultModel || '') === o.id,
      }));
      setRows(nextRows.length ? nextRows : [blankChatRow(true)]);
      const nextMediaOn = {};
      for (const [key, , , prefixes] of MEDIA_FIELDS) {
        const options = models.map(m => m.id).filter(id => prefixes.some(prefix => id === prefix || id.startsWith(prefix)));
        nextMediaOn[key] = options.includes(mediaNow[key]);
      }
      setMediaOn(nextMediaOn);
      setDiscoverNotice({ ok: models.length > 0, text: '已从 Grok ByAPI 发现 ' + models.length + ' 个模型，按需添加行并保存。' });
      if (models.length) setChatOpen(true);
    } catch (error) {
      setDiscoverNotice({ ok: false, text: '获取模型失败：' + (discoveryErrorText(error?.message) || '未知错误') });
    } finally { setDiscovering(false); }
  }

  const updateRow = (index, patch) => setRows(rowList.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  function addRow() {
    const used = new Set(rowList.map(r => r.id));
    const candidate = chatIdOptions().find(id => !used.has(id)) || '';
    const spec = specOf[candidate] || {};
    setRows([...rowList, {
      id: candidate, displayName: nameOf[candidate] || candidate,
      contextWindow: spec.contextWindow ? formatSize(spec.contextWindow) : '',
      maxTokens: spec.maxTokens ? formatSize(spec.maxTokens) : '',
      image: spec.image !== false && (spec.image === true || defaultImageSupported(candidate)), efforts: Array.isArray(spec.efforts) ? spec.efforts : defaultReasoningEfforts(candidate), isDefault: rowList.length === 0,
    }]);
  }
  const removeRow = index => setRows(rowList.filter((_, i) => i !== index));
  function pickRowModel(index, id) {
    const spec = specOf[id] || {};
    updateRow(index, {
      id, displayName: nameOf[id] || id,
      contextWindow: spec.contextWindow ? formatSize(spec.contextWindow) : '',
      maxTokens: spec.maxTokens ? formatSize(spec.maxTokens) : '',
      image: spec.image !== false && (spec.image === true || defaultImageSupported(id)),
      efforts: Array.isArray(spec.efforts) ? spec.efforts : defaultReasoningEfforts(id),
    });
  }

  // 进入页面后只自动获取一次。先等已保存地址，再确认凭据库里已有密钥。
  // 详情页首屏没有表单，空 baseURL 会被宿主拒绝成 “provider route or a baseURL”。
  useEffect(() => {
    if (autoRan.current || !remote?.credentials?.describe) return undefined;
    let live = true;
    (async () => {
      const source = await settingsGate.current.ready;
      if (!live || autoRan.current) return;
      let found;
      try { found = await remote.credentials.describe([KEY_REF]); }
      catch { return; }
      if (!live || autoRan.current) return;
      const payload = found?.ok ? found.value : found;
      const info = payload?.[KEY_REF] || payload;
      if (info?.configured !== true) return;
      autoRan.current = true;
      return discover(source || {});
    })().catch(() => {});
    return () => { live = false; };
  }, []);

  const keyFailure = keyFailureOf(keyDraft);
  if (view === 'summary') return h('span', null, 'Grok 连接、密钥与模型参数');
  function configuredRows() { return rowList.filter(row => row.id); }
  function overrideOps() {
    const ops = [];
    for (const row of configuredRows()) {
      const contextWindow = parseSize(row.contextWindow);
      const maxTokens = parseSize(row.maxTokens);
      if (contextWindow === undefined) { setMessage(row.id + '：上下文大小要写成像 500K / 1M / 200000 这样的正数。'); return undefined; }
      if (maxTokens === undefined) { setMessage(row.id + '：最大输出 token 要写成像 32K / 64K 这样的正数。'); return undefined; }
      const previous = (value.modelOverrides || []).find(x => x.id === row.id) || {};
      const next = { ...previous, id: row.id, displayName: row.displayName || row.id, imageSupported: !!row.image, contextWindow, maxTokens, reasoningEfforts: row.efforts };
      if (previous.displayName !== next.displayName || (previous.imageSupported === true) !== next.imageSupported
        || previous.contextWindow !== contextWindow || previous.maxTokens !== maxTokens
        || JSON.stringify(previous.reasoningEfforts || []) !== JSON.stringify(row.efforts)) ops.push(next);
    }
    return ops;
  }

  async function commit(ops, note) {
    const writer = form?.mutate || remote?.settings?.mutate;
    const expected = form?.state?.revision ?? revision;
    if (typeof writer !== 'function') { setMessage('当前页面写不了配置。'); return false; }
    setBusy(true); setMessage('');
    try {
      const landed = form ? await form.mutate(ops, expected) : await remote.settings.mutate(SETTINGS_NS, ops, expected);
      const result = form ? landed : (landed?.ok === false ? false : landed);
      if (result === false) { setMessage('未保存，请检查权限、配置来源或是否被其他窗口更新。'); return false; }
      if (!form && result?.value) { setLoaded(result.value); setRevision(result.revision ?? revision); }
      setDraft(null);
      setMessage(note);
      return true;
    } catch { setMessage('保存失败，草稿已保留，请检查配置或重新加载。'); return false; }
    finally { setBusy(false); }
  }
  async function saveConnection() {
    if (keyFailure) { setMessage(keyFailure); return; }
    const connection = { ...(value.connection || {}), apiKeyEnv: KEY_REF, apiKey: '' };
    const saved = await commit([{ op: 'set', path: ['connection'], value: connection }], '地址已保存' + (keyDraft.trim() ? '，正在写入密钥。' : '。'));
    if (!saved) return;
    if (keyDraft.trim()) {
      const failure = await setCredential(KEY_REF, keyDraft.trim());
      if (failure) { setMessage('地址已保存，但密钥未写入：' + failure); return; }
      setKeyDraft('');
      setMessage('地址和密钥已保存。密钥在凭据库（' + KEY_REF + '）。');
    }
  }
  async function saveChat() {
    if (!discovered && !configuredRows().length) { setMessage('先点「获取模型」，或先选择一条对话模型。'); return; }
    const pending = overrideOps();
    if (pending === undefined) return;
    const savingRows = configuredRows();
    const defaultRow = savingRows.find(r => r.isDefault) || savingRows[0];
    const kept = (value.modelOverrides || []).filter(x => !savingRows.some(r => r.id === x.id));
    const nextRows = [...kept, ...savingRows.map(row => {
      const previous = (value.modelOverrides || []).find(x => x.id === row.id) || {};
      return { ...previous, id: row.id, displayName: row.displayName || row.id, imageSupported: !!row.image,
        contextWindow: parseSize(row.contextWindow), maxTokens: parseSize(row.maxTokens), reasoningEfforts: row.efforts };
    })];
    await commit([
      { op: 'set', path: ['modelOverrides'], value: nextRows },
      { op: 'set', path: ['media', 'defaultModel'], value: defaultRow ? defaultRow.id : '' },
    ], '已保存 ' + savingRows.length + ' 条对话模型。');
  }
  async function saveMedia() {
    const nextMedia = { ...media };
    for (const [key, , , prefixes] of MEDIA_FIELDS) {
      const options = mediaOptions(prefixes, key);
      nextMedia[key] = mediaOn[key] === true && options.includes(media[key]) ? media[key] : '';
    }
    await commit([{ op: 'set', path: ['media'], value: nextMedia }], '媒体模型已保存。');
  }

  const cellInput = { ...ui.control, height: 32, padding: '0 8px' };
  const cell = { padding: '8px 6px', borderBottom: '0.5px solid var(--dsw-alias-border-l4)', verticalAlign: 'middle' };
  const chatOptions = id => chatIdOptions(id);

  return h('section', { style: ui.page },
    h('section', { style: ui.card },
      h('h3', { style: ui.title }, '连接'),
      h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 220px', gap: 12 } },
        field('connection', 'baseURL', 'API 地址'),
        h('label', { style: ui.label }, 'API 协议',
          h('select', {
            value: value.connection?.api === 'openai-completions' ? 'openai-completions' : 'openai-responses',
            disabled: busy, 'aria-label': 'API 协议',
            onChange: event => setDraft({ ...value, connection: { ...value.connection, api: event.target.value } }),
            style: ui.control,
          },
          h('option', { value: 'openai-completions' }, 'Chat Completions'),
          h('option', { value: 'openai-responses' }, 'Responses')))),
      h('label', { style: ui.label }, 'API Key',
        h('input', { type: 'password', autoComplete: 'new-password', value: keyDraft, disabled: busy, placeholder: '留空沿用已存密钥',
          'aria-label': 'API Key', onChange: event => setKeyDraft(event.target.value), style: ui.control })),
      keyFailure ? h('p', { role: 'alert', style: ui.alert }, keyFailure) : null,
      h('p', { style: ui.hint }, '填写后保存即写入 dsh 凭据库（' + KEY_REF + '），不会写进插件配置文件。'),
      h('div', { style: ui.row },
        h('button', { type: 'button', disabled: busy || discovering, onClick: () => discover(), style: ui.button }, discovering ? '获取中…' : '获取模型'),
        discoverNotice ? h('span', { role: 'status', style: { color: discoverNotice.ok ? 'var(--dsw-alias-state-success-primary)' : 'var(--dsw-alias-state-error-primary)', fontSize: 13 } }, discoverNotice.text) : null,
        h('button', { type: 'button', disabled: busy || form?.state?.writable === false, onClick: saveConnection, style: { ...ui.primary, marginLeft: 'auto' } }, busy ? '保存中…' : '保存地址和密钥'))),
    h('section', { style: ui.card },
      h('button', { type: 'button', 'aria-expanded': chatOpen ? 'true' : 'false', onClick: () => setChatOpen(open => !open), style: { ...ui.row, width: '100%', background: 'transparent', border: 0, color: 'inherit', cursor: 'pointer', padding: 0 } },
        h('h3', { style: ui.title }, (chatOpen ? '▾ ' : '▸ ') + '对话模型')),
      chatOpen ? h('p', { style: ui.hint }, '这里配置的模型会出现在对话右下角。模型弹窗里的本提供商只读。生成结果默认保存在 ~/.dsh/plugins/dsh-grok-byapi。') : null,
      chatOpen ? h('p', { style: ui.hint }, discovered ? '已获取 ' + ids.length + ' 个模型。' : '已有一行默认配置。先获取模型，下拉才会出现可选项。') : null,
      chatOpen ? h('div', { style: { overflow: 'visible' } },
        h('table', { style: ui.table },
          h('thead', null, h('tr', null, ...['默认', '模型 ID', '显示名称', '图片', '上下文', '最大输出', '思考强度', ''].map(label => h('th', { key: label || 'actions', style: ui.head }, label)))),
          h('tbody', null, ...rowList.map((row, index) => h('tr', { key: index },
            h('td', { style: cell }, h('input', { type: 'radio', name: 'grok-byapi-default-model', checked: !!row.isDefault, 'aria-label': '默认模型 ' + (row.id || index), onChange: () => setRows(rowList.map((r, i) => ({ ...r, isDefault: i === index }))) })),
            h('td', { style: cell }, h('select', { value: row.id, disabled: busy, 'aria-label': '模型 ID ' + index, onChange: event => pickRowModel(index, event.target.value), style: cellInput },
              h('option', { value: '' }, chatOptions(row.id).length ? '选择模型' : '先获取模型'),
              ...chatOptions(row.id).map(id => h('option', { key: id, value: id }, id)))),
            h('td', { style: cell }, h('input', { type: 'text', value: row.displayName ?? '', disabled: busy, 'aria-label': '显示名称 ' + index, onChange: event => updateRow(index, { displayName: event.target.value }), style: { ...cellInput, width: 120 } })),
            h('td', { style: cell }, h('input', { type: 'checkbox', checked: !!row.image, disabled: busy, 'aria-label': '支持图片 ' + index, onChange: event => updateRow(index, { image: event.target.checked }) })),
            h('td', { style: cell }, h('input', { type: 'text', value: row.contextWindow ?? '', disabled: busy, placeholder: '500K', 'aria-label': '上下文 ' + index, onChange: event => updateRow(index, { contextWindow: event.target.value }), style: { ...cellInput, width: 84 } })),
            h('td', { style: cell }, h('input', { type: 'text', value: row.maxTokens ?? '', disabled: busy, placeholder: '32K', 'aria-label': '最大输出 ' + index, onChange: event => updateRow(index, { maxTokens: event.target.value }), style: { ...cellInput, width: 84 } })),
            h('td', { style: cell }, h(EffortPicker, { index, efforts: row.efforts, disabled: busy, onChange: efforts => updateRow(index, { efforts }) })),
            h('td', { style: cell }, index === rowList.length - 1
              ? h('button', { type: 'button', disabled: busy || !discovered, 'aria-label': '添加模型行', onClick: addRow, style: ui.button }, '添加')
              : h('button', { type: 'button', disabled: busy, 'aria-label': '删除第 ' + (index + 1) + ' 行', onClick: () => removeRow(index), style: ui.button }, '删除'))))),
          rowList.length ? null : h('tfoot', null, h('tr', null, h('td', { colSpan: 8, style: { ...cell, color: 'var(--dsw-alias-label-tertiary)' } }, '还没有配置行。'))))) : null,
      chatOpen ? h('div', { style: { ...ui.row, justifyContent: 'flex-end' } },
        h('button', { type: 'button', disabled: busy || form?.state?.writable === false, onClick: saveChat, style: ui.primary }, busy ? '保存中…' : '保存对话模型')) : null),
    h('section', { style: ui.card },
      h('button', { type: 'button', 'aria-expanded': mediaOpen ? 'true' : 'false', onClick: () => setMediaOpen(open => !open), style: { ...ui.row, width: '100%', background: 'transparent', border: 0, color: 'inherit', cursor: 'pointer', padding: 0 } },
        h('h3', { style: ui.title }, (mediaOpen ? '▾ ' : '▸ ') + '媒体模型')),
      mediaOpen ? h(React.Fragment, null, ...MEDIA_FIELDS.map(field => mediaPicker(...field)),
        h('div', { style: { ...ui.row, justifyContent: 'flex-end' } },
          h('button', { type: 'button', disabled: busy || form?.state?.writable === false, onClick: saveMedia, style: ui.primary }, busy ? '保存中…' : '保存媒体模型'))) : null),
    form?.state?.writable === false ? h('p', { role: 'alert', style: ui.alert }, '当前配置被更高优先级的配置层覆盖，不能从此页修改。') : null,
    message ? h('p', { role: 'status', style: ui.status }, message) : null);
}
export function apply(ctx) {
  const page = props => GrokSettings({ ...props, remote: ctx.remote });
  // 配置只放插件详情页。组件行不再挂第二份。
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({ name: 'plugins.bundle.config', key: PKG_NAME }, page));
  for (const key of tools) ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key }, GrokToolCard));
  ctx.effect(() => ctx.documentPreviews.register({ id: MEDIA_ID, extensions: ['mp4', 'mp3', 'wav'], binaryExtensions: ['mp4', 'mp3', 'wav'], priority: 'extension', title: () => 'Grok 媒体播放', loading: 'bytes-complete', wrap: false }));
  ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register({ name: 'sidebar.right.tab.document', key: MEDIA_ID }, MediaPreview));
}