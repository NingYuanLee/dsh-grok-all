import React, { useEffect, useState } from 'react';

export const inject = ['slots', 'documentPreviews'];
const h = React.createElement;
const MEDIA_ID = 'dsh-grok-all/media-preview';
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

export function GrokSettings({ view, form }) {
  const [draft, setDraft] = useState(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const accepted = form?.state?.value;
  const value = draft || accepted;
  if (view === 'summary') return h('span', null, 'Grok 连接、媒体模型和本地保存');
  if (!value) return h('p', { role: 'status' }, '正在读取 Grok 配置…');
  const field = (section, key, label, type = 'text') => h('label', { key: section + key, style: { display: 'grid', gap: 6, marginBottom: 14 } }, label,
    h('input', { type, value: value[section]?.[key] ?? '', disabled: busy,
      onChange: event => setDraft({ ...value, [section]: { ...value[section], [key]: type === 'number' ? Number(event.target.value) : event.target.value } }),
      style: { font: 'inherit', padding: 9, color: 'inherit', background: 'transparent', border: '1px solid #8886', borderRadius: 6 } }));
  async function save() {
    setBusy(true); setMessage('');
    try {
      const landed = await form.mutate(['connection', 'media'].map(key => ({ op: 'set', path: [key], value: value[key] })), form.state.revision);
      if (landed === false) setMessage('未保存，请检查权限、配置来源或是否被其他窗口更新。');
      else { setDraft(null); setMessage('已保存，正在重新发现模型。可通过 grok_models 查看连接结果。'); }
    } catch { setMessage('保存失败，草稿已保留，请检查配置或重新加载。'); }
    finally { setBusy(false); }
  }
  return h('section', { style: { maxWidth: 680, padding: '16px 0' } },
    h('h3', null, 'Grok All 连接与媒体'),
    field('connection', 'baseURL', 'API 地址'),
    field('connection', 'apiKeyEnv', '调用密钥的凭据引用名称（不填写密钥本身）'),
    field('connection', 'timeoutMs', '请求超时（毫秒）', 'number'),
    field('media', 'imageModel', '默认图片模型'), field('media', 'videoModel', '默认视频模型'), field('media', 'speechModel', '默认语音模型'),
    field('media', 'dataDir', '结果保存目录（留空使用插件默认目录）'),
    h('p', null, '密钥通过 dsh 凭据服务或启动环境变量配置。聊天模型自动发现；媒体模型不会混进聊天选择器。'),
    form.state.writable === false ? h('p', { role: 'alert' }, '当前配置被更高优先级的配置层覆盖，不能从此页修改。') : null,
    h('button', { type: 'button', disabled: busy || !draft || form.state.writable === false, onClick: save }, busy ? '保存中…' : '保存并刷新模型'),
    h('button', { type: 'button', disabled: busy || !draft, onClick: () => { setDraft(null); setMessage(''); }, style: { marginLeft: 12 } }, '放弃修改'),
    message ? h('p', { role: 'status' }, message) : null);
}

export function apply(ctx) {
  ctx.slots.inject('plugins.row.config', () => ctx.slots.register({ name: 'plugins.row.config', key: 'dsh-grok-all#grok-all' }, GrokSettings));
  for (const key of tools) ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({ name: 'tool.call.toolview', key }, GrokToolCard));
  ctx.effect(() => ctx.documentPreviews.register({ id: MEDIA_ID, extensions: ['mp4', 'mp3', 'wav'], binaryExtensions: ['mp4', 'mp3', 'wav'], priority: 'extension', title: () => 'Grok 媒体播放', loading: 'bytes-complete', wrap: false }));
  ctx.slots.inject('sidebar.right.tab.document', () => ctx.slots.register({ name: 'sidebar.right.tab.document', key: MEDIA_ID }, MediaPreview));
}
