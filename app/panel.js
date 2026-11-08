'use strict';

const api = window.panelAPI;

const el = (id) => document.getElementById(id);

let info = null;
let state = null;
let overrides = {};
let values = null;
let groupsById = new Map();
let paramsByGroup = new Map();
let renderedRows = new Map(); // index -> { row, input, value , overridden }
let activeExpression = -1;
let activeTab = 'params';
let searchQuery = '';

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function fmt(v, step) {
  if (!Number.isFinite(v)) return '—';
  if (step >= 1) return v.toFixed(0);
  if (step >= 0.1) return v.toFixed(2);
  if (step >= 0.01) return v.toFixed(2);
  return v.toFixed(3);
}
function stepFor(param) {
  const range = param.max - param.min;
  if (range >= 20) return 0.1;
  if (range >= 1) return 0.01;
  return 0.001;
}
function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

// ---------------------------------------------------------------------------
// parameter rendering
// ---------------------------------------------------------------------------
function buildGroups() {
  groupsById = new Map();
  paramsByGroup = new Map();
  if (!info) return;
  for (const g of info.groups || []) {
    groupsById.set(g.id, g.name);
    paramsByGroup.set(g.id, []);
  }
  for (const p of info.params || []) {
    const gid = groupsById.has(p.group) ? p.group : '__other';
    if (!paramsByGroup.has(gid)) {
      paramsByGroup.set(gid, []);
      groupsById.set(gid, gid === '__other' ? '其它' : gid);
    }
    paramsByGroup.get(gid).push(p);
  }
  // drop empty groups
  for (const [gid, list] of [...paramsByGroup.entries()]) {
    if (!list.length) paramsByGroup.delete(gid);
  }
}

function makeRow(param) {
  const step = stepFor(param);
  const row = document.createElement('div');
  row.className = 'param';
  row.dataset.index = String(param.index);
  row.dataset.id = param.id;

  const name = document.createElement('div');
  name.className = 'pname';
  name.title = param.id;
  name.textContent = param.name || param.id;
  const small = document.createElement('small');
  small.textContent = param.id;
  name.appendChild(small);

  const input = document.createElement('input');
  input.type = 'range';
  input.min = String(param.min);
  input.max = String(param.max);
  input.step = String(step);
  input.value = String(Math.min(param.max, Math.max(param.min, param.def)));

  const valBox = document.createElement('div');
  valBox.className = 'pval';
  const val = document.createElement('span');
  val.textContent = fmt(param.def, step);
  const reset = document.createElement('button');
  reset.className = 'preset';
  reset.title = '恢复默认值';
  reset.textContent = '↺';
  valBox.appendChild(val);
  valBox.appendChild(reset);

  row.appendChild(name);
  row.appendChild(input);
  row.appendChild(valBox);

  const entry = { row, input, val, param, step };
  renderedRows.set(param.index, entry);
  applyOverrideStyle(entry);

  input.addEventListener('input', () => {
    const v = Number(input.value);
    val.textContent = fmt(v, step);
    overrides[param.id] = v;
    applyOverrideStyle(entry);
    api.setParam(param.id, v);
  });
  input.addEventListener('change', () => {
    api.setParam(param.id, Number(input.value));
  });
  reset.addEventListener('click', () => {
    delete overrides[param.id];
    applyOverrideStyle(entry);
    api.resetParam(param.id);
    input.value = String(clamp(param.def, param.min, param.max));
    val.textContent = fmt(param.def, step);
  });
  name.addEventListener('dblclick', () => reset.click());
  return row;
}

function applyOverrideStyle(entry) {
  const overridden = Object.prototype.hasOwnProperty.call(overrides, entry.param.id);
  entry.row.classList.toggle('overridden', overridden);
}

function renderParamList() {
  const box = el('param-list');
  box.innerHTML = '';
  renderedRows.clear();
  if (!info) {
    box.innerHTML = '<div class="hint">等待桌宠加载模型…</div>';
    return;
  }
  el('params-hint').textContent = `共 ${info.params.length} 个参数 · ${info.groups.length} 个分组 · 双击名称或点 ↺ 恢复默认`;

  if (searchQuery) {
    const q = searchQuery.toLowerCase();
    const matched = info.params.filter((p) => p.id.toLowerCase().includes(q) || (p.name || '').toLowerCase().includes(q));
    const wrap = document.createElement('div');
    wrap.className = 'group open';
    const head = document.createElement('div');
    head.className = 'group-head';
    head.innerHTML = `<span class="gname">搜索结果</span><span class="gcount">${matched.length} 个</span>`;
    const body = document.createElement('div');
    body.className = 'group-body';
    body.style.display = 'block';
    if (!matched.length) body.innerHTML = '<div class="hint">没有匹配的参数</div>';
    for (const p of matched.slice(0, 160)) body.appendChild(makeRow(p));
    wrap.appendChild(head);
    wrap.appendChild(body);
    box.appendChild(wrap);
    return;
  }

  for (const [gid, list] of paramsByGroup) {
    const group = document.createElement('div');
    group.className = 'group';
    const head = document.createElement('div');
    head.className = 'group-head';
    head.innerHTML = `<span class="gname">${groupsById.get(gid) || gid}</span><span class="gcount">${list.length}</span>`;
    const body = document.createElement('div');
    body.className = 'group-body';
    head.addEventListener('click', () => {
      const open = group.classList.toggle('open');
      if (open && !body.dataset.built) {
        body.dataset.built = '1';
        for (const p of list) body.appendChild(makeRow(p));
        syncValues();
      }
    });
    group.appendChild(head);
    group.appendChild(body);
    box.appendChild(group);
  }
}

// ---------------------------------------------------------------------------
// values stream
// ---------------------------------------------------------------------------
function syncValues() {
  if (!values || !info || values.length !== info.params.length) return;
  const active = document.activeElement;
  for (const [index, entry] of renderedRows) {
    if (!entry.row.isConnected) continue;
    if (entry.input === active) continue;
    const v = values[index];
    if (!Number.isFinite(v)) continue;
    if (Math.abs(Number(entry.input.value) - v) > entry.step * 0.5) entry.input.value = String(v);
    entry.val.textContent = fmt(v, entry.step);
  }
}

// ---------------------------------------------------------------------------
// expressions / motions
// ---------------------------------------------------------------------------
function renderExpressions() {
  const box = el('expression-list');
  box.innerHTML = '';
  activeExpression = -1;
  if (!info) return;
  for (const expr of info.expressions) {
    const btn = document.createElement('button');
    btn.textContent = expr.name;
    btn.addEventListener('click', () => {
      activeExpression = expr.index;
      for (const b of box.children) b.classList.remove('active');
      btn.classList.add('active');
      api.setExpression(expr.index);
    });
    box.appendChild(btn);
  }
  if (!info.expressions.length) box.innerHTML = '<div class="hint">这个模型没有表情文件。</div>';
}

function renderMotions() {
  const box = el('motion-list');
  box.innerHTML = '';
  if (!info) return;
  const byGroup = new Map();
  for (const m of info.motions) {
    if (!byGroup.has(m.group)) byGroup.set(m.group, []);
    byGroup.get(m.group).push(m);
  }
  if (!byGroup.size) {
    box.innerHTML = '<div class="hint">这个模型没有动作文件。</div>';
    return;
  }
  for (const [group, list] of byGroup) {
    const g = document.createElement('div');
    g.className = 'motion-group';
    const name = document.createElement('div');
    name.className = 'mg-name';
    name.textContent = group;
    const items = document.createElement('div');
    items.className = 'mg-items';
    for (const m of list) {
      const btn = document.createElement('button');
      btn.textContent = m.label + (group.toLowerCase() === 'idle' ? '（待机）' : '');
      btn.addEventListener('click', () => api.playMotion(m.group, m.index));
      items.appendChild(btn);
    }
    g.appendChild(name);
    g.appendChild(items);
    box.appendChild(g);
  }
}

// ---------------------------------------------------------------------------
// models
// ---------------------------------------------------------------------------
let modelStatusTimer = 0;

function hasModelList() {
  return !!(state && Array.isArray(state.models));
}

function modelsOf() {
  return hasModelList() ? state.models.filter((m) => m && m.id) : [];
}

function currentModel() {
  const models = modelsOf();
  if (!models.length) return null;
  const id = state && state.currentModelId;
  return models.find((m) => m.id === id) || models.find((m) => m.current) || null;
}

function showModelStatus(text) {
  const box = el('model-status');
  if (!box) return;
  box.textContent = text || '';
  box.hidden = !text;
  if (modelStatusTimer) clearTimeout(modelStatusTimer);
  modelStatusTimer = 0;
  if (text) modelStatusTimer = setTimeout(() => { box.hidden = true; }, 4500);
}

// Optional-chaining-style call: old preload builds may not expose the model APIs yet.
function callPanel(method, ...args) {
  const fn = api && api[method];
  if (typeof fn !== 'function') {
    showModelStatus('当前版本暂不支持这个操作（主进程未提供 ' + method + '）');
    return false;
  }
  try {
    const ret = fn.apply(api, args);
    if (ret && typeof ret.catch === 'function') {
      ret.catch((err) => showModelStatus('操作失败：' + (err && err.message ? err.message : String(err))));
    }
    return true;
  } catch (err) {
    showModelStatus('操作失败：' + (err && err.message ? err.message : String(err)));
    return false;
  }
}

function statCount(info, countKey, arrayKey) {
  if (Number.isFinite(info[countKey])) return info[countKey];
  if (Array.isArray(info[arrayKey])) return info[arrayKey].length;
  return null;
}

function modelStatsParts(mi) {
  const i = mi || {};
  const parts = [];
  const push = (label, count) => { if (count !== null && count !== undefined) parts.push([label, count]); };
  push('参数', statCount(i, 'paramCount', 'params'));
  push('贴图', statCount(i, 'textureCount', 'textures'));
  push('表情', statCount(i, 'expressionCount', 'expressions'));
  push('动作', statCount(i, 'motionCount', 'motions'));
  let groups = null;
  if (Number.isFinite(i.motionGroupCount)) groups = i.motionGroupCount;
  else if (Number.isFinite(i.groupCount)) groups = i.groupCount;
  else if (Array.isArray(i.groups)) groups = i.groups.length;
  push('分组', groups);
  return parts;
}

function renderCurrentModel() {
  const card = el('model-current-card');
  const fit = el('model-fit');
  const cur = currentModel();
  if (!card) return;
  card.hidden = !cur;
  if (fit) fit.hidden = !cur;
  if (!cur) return;

  el('cm-name').textContent = cur.name || cur.id || '未命名模型';
  const path = cur.dir || cur.modelFile || '—';
  el('cm-path').textContent = path;
  el('cm-path').title = path;

  const stats = el('cm-stats');
  stats.innerHTML = '';
  const parts = modelStatsParts(cur.info);
  if (parts.length) {
    for (const [label, count] of parts) {
      const chip = document.createElement('span');
      chip.className = 'model-stat';
      const b = document.createElement('b');
      b.textContent = String(count);
      chip.appendChild(document.createTextNode(label + ' '));
      chip.appendChild(b);
      stats.appendChild(chip);
    }
  } else {
    const chip = document.createElement('span');
    chip.className = 'model-stat';
    chip.textContent = '暂无统计信息';
    stats.appendChild(chip);
  }

  const warnings = el('cm-warnings');
  warnings.innerHTML = '';
  const list = cur.info && Array.isArray(cur.info.warnings) ? cur.info.warnings : [];
  warnings.hidden = !list.length;
  for (const w of list) {
    const line = document.createElement('div');
    line.textContent = String(w);
    warnings.appendChild(line);
  }

  // fit controls (only overwrite while the user is not dragging them)
  const flip = el('model-flipx');
  if (flip) flip.checked = !!cur.flipX;
  const scaleEl = el('model-scale');
  if (scaleEl && document.activeElement !== scaleEl) {
    const v = Number(cur.fitScale);
    if (Number.isFinite(v)) scaleEl.value = String(clamp(v, 0.7, 1.3));
  }
  if (scaleEl) el('val-model-scale').textContent = Number(scaleEl.value || 1).toFixed(2);
  const offEl = el('model-offset-y');
  if (offEl && document.activeElement !== offEl) {
    const v = Number(cur.offsetY);
    if (Number.isFinite(v)) offEl.value = String(clamp(v, -0.3, 0.3));
  }
  if (offEl) el('val-model-offset-y').textContent = Number(offEl.value || 0).toFixed(2);
}

function renderModelList() {
  const box = el('model-list');
  if (!box) return;
  const models = modelsOf();
  box.innerHTML = '';
  if (!hasModelList()) {
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = '当前版本暂不支持模型列表（主进程未提供 models 数据）。';
    box.appendChild(hint);
    return;
  }
  if (!models.length) {
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = '模型列表为空，导入后会显示在这里。';
    box.appendChild(hint);
    return;
  }

  const currentId = (state && state.currentModelId) || (currentModel() || {}).id;
  for (const m of models) {
    const active = m.id === currentId || !!m.current;
    const row = document.createElement('div');
    row.className = 'model-row' + (active ? ' active' : '');
    row.dataset.id = m.id;

    const main = document.createElement('div');
    main.className = 'mr-main';
    const name = document.createElement('div');
    name.className = 'mr-name';
    name.textContent = m.name || m.id || '未命名模型';
    name.title = m.dir || m.modelFile || '';
    const meta = document.createElement('div');
    meta.className = 'mr-meta';
    const stats = modelStatsParts(m.info);
    meta.textContent = stats.length ? stats.map(([k, v]) => k + ' ' + v).join(' · ')
      : (m.dir || m.modelFile || '');
    main.appendChild(name);
    main.appendChild(meta);
    row.appendChild(main);

    if (active) {
      const badge = document.createElement('span');
      badge.className = 'mr-current';
      badge.textContent = '使用中';
      row.appendChild(badge);
    }

    row.addEventListener('click', () => {
      if (active) return;
      callPanel('selectModel', m.id);
    });
    box.appendChild(row);
  }
}

function renderModels() {
  const empty = el('models-empty');
  if (empty) empty.hidden = !hasModelList() || modelsOf().length > 0;
  renderCurrentModel();
  renderModelList();
}

function setupModels() {
  const on = (id, fn) => {
    const node = el(id);
    if (node) node.addEventListener('click', fn);
  };
  on('btn-import-model-folder', () => callPanel('importModelFolder'));
  on('btn-import-model-file', () => callPanel('importModelFile'));
  on('btn-rescan-models', () => {
    if (callPanel('rescanModels')) showModelStatus('正在重新扫描模型…');
  });
  on('btn-model-open', () => {
    const cur = currentModel();
    if (!cur) { showModelStatus('还没有选择模型。'); return; }
    callPanel('openModelFolder', cur.id);
  });
  on('btn-model-remove', () => {
    const cur = currentModel();
    if (!cur) return;
    callPanel('removeModel', cur.id);
  });
  on('btn-model-view-reset', () => callPanel('resetView'));

  const flip = el('model-flipx');
  if (flip) flip.addEventListener('change', (e) => callPanel('setModelOption', 'flipX', !!e.target.checked));

  const scale = el('model-scale');
  if (scale) {
    scale.addEventListener('input', (e) => {
      const v = Number(e.target.value);
      el('val-model-scale').textContent = v.toFixed(2);
      callPanel('setModelOption', 'fitScale', v);
    });
  }

  const offsetY = el('model-offset-y');
  if (offsetY) {
    offsetY.addEventListener('input', (e) => {
      const v = Number(e.target.value);
      el('val-model-offset-y').textContent = v.toFixed(2);
      callPanel('setModelOption', 'offsetY', v);
    });
  }
}

// ---------------------------------------------------------------------------
// surfcore / ai
// ---------------------------------------------------------------------------
const SURF_CHAT_LIMIT = 20;
let surf = null;
let surfAutoStart = false;
let surfToken = '';
let surfTokenInfo = null;
let surfTokenLoaded = false;
let surfTokenVisible = false;
let surfTokenLoading = false;
let surfChatLog = [];
let surfSending = false;
let surfStatusTimer = 0;
let surfApiStatusTimer = 0;

function surfOf() {
  if (surf && typeof surf === 'object') return surf;
  if (state && state.surf && typeof state.surf === 'object') return state.surf;
  return null;
}

function errText(err) {
  if (!err) return '未知错误';
  if (typeof err === 'string') return err;
  return err.message ? String(err.message) : String(err);
}

// 统一异步调用：方法缺失 / 同步抛错 / Promise 失败都转成安全结果
function callAsync(method, ...args) {
  const fn = api && api[method];
  if (typeof fn !== 'function') return Promise.resolve({ ok: false, unsupported: true });
  let ret;
  try {
    ret = fn.apply(api, args);
  } catch (err) {
    return Promise.resolve({ ok: false, error: errText(err) });
  }
  return Promise.resolve(ret).catch((err) => ({ ok: false, error: errText(err) }));
}

function setSurfStatus(text, isError) {
  const box = el('surf-status');
  if (!box) return;
  box.textContent = text || '';
  box.hidden = !text;
  box.classList.toggle('error', !!isError);
  if (surfStatusTimer) clearTimeout(surfStatusTimer);
  surfStatusTimer = 0;
  if (text) surfStatusTimer = setTimeout(() => { box.hidden = true; }, 5500);
}

function setSurfApiStatus(text, isError) {
  const box = el('surf-api-status');
  if (!box) return;
  box.textContent = text || '';
  box.hidden = !text;
  box.classList.toggle('error', !!isError);
  if (surfApiStatusTimer) clearTimeout(surfApiStatusTimer);
  surfApiStatusTimer = 0;
  if (text) surfApiStatusTimer = setTimeout(() => { box.hidden = true; }, 5500);
}

function presenceText(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return '在线 · ' + value;
  if (value === true) return '在线';
  if (value === false) return '离线';
  return '—';
}

function toEpochMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : NaN;
}

function formatClock(ms) {
  try {
    return new Date(ms).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  } catch (_) {
    return new Date(ms).toISOString();
  }
}

function tokenLockText(info) {
  const parts = [];
  const until = info && info.lockedUntil;
  if (until) {
    const ms = toEpochMs(until);
    if (Number.isFinite(ms) && ms > Date.now()) parts.push('API 已临时锁定至 ' + formatClock(ms) + '。');
  }
  const failures = Number(info && info.failures);
  if (Number.isFinite(failures) && failures > 0) parts.push('近期鉴权失败 ' + failures + ' 次。');
  return parts.join(' ');
}

function setSurfIntervalValue(value) {
  const sel = el('surf-interval');
  if (!sel) return;
  const v = String(Number.isFinite(Number(value)) ? Number(value) : 20);
  if (sel.options) {
    let found = false;
    for (let i = 0; i < sel.options.length; i++) {
      if (String(sel.options[i].value) === v) { found = true; break; }
    }
    if (!found) {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = v + ' 分钟';
      sel.appendChild(opt);
    }
  }
  sel.value = v;
}

function renderSurf() {
  const roleEl = el('surf-role');
  if (!roleEl) return;
  const s = surfOf();
  const hasState = !!s;
  const badge = el('surf-conn');
  if (badge) {
    if (!hasState) {
      badge.textContent = '等待状态';
      badge.className = 'surf-badge';
    } else if (!s.enabled) {
      badge.textContent = '已停用';
      badge.className = 'surf-badge off';
    } else if (s.connected) {
      badge.textContent = '已连接';
      badge.className = 'surf-badge ok';
    } else {
      badge.textContent = '未发现 SurfCore';
      badge.className = 'surf-badge warn';
    }
  }
  roleEl.textContent = (s && s.roleName) || 'SurfCore';

  el('surf-model').textContent = '模型：' + (s
    ? ([s.provider, s.model].filter((v) => v !== undefined && v !== null && v !== '').join(' / ') || '—')
    : '—');
  el('surf-carrier').textContent = '主动搭话：' + (s && s.proactiveCarrier ? String(s.proactiveCarrier) : '—');
  el('surf-presence').textContent = '在线状态：' + (s ? presenceText(s.presenceOnline) : '—');

  const errorBox = el('surf-error');
  if (errorBox) {
    const err = s && s.lastError ? String(s.lastError) : '';
    errorBox.textContent = err ? '⚠ ' + err : '';
    errorBox.hidden = !err;
  }

  const enabled = el('surf-enabled');
  if (enabled) enabled.checked = !!(hasState && s.enabled);
  const autoTalk = el('surf-autotalk');
  if (autoTalk) autoTalk.checked = !!(hasState && s.autoTalk);
  setSurfIntervalValue(hasState ? s.intervalMin : 20);
  const autoStart = el('surf-autostart');
  if (autoStart) autoStart.checked = !!surfAutoStart;

  const chatDisabled = hasState && s.chatEnabled === false;
  const input = el('surf-chat-input');
  if (input) {
    input.disabled = chatDisabled;
    input.placeholder = chatDisabled ? 'SurfCore 对话未开启' : '和角色说点什么…';
  }
  const send = el('btn-surf-send');
  if (send) send.disabled = chatDisabled || surfSending;
}

function renderSurfToken() {
  const urlEl = el('surf-api-url');
  const tokenEl = el('surf-token');
  if (!urlEl || !tokenEl) return;
  const s = surfOf() || {};
  const info = surfTokenInfo || {};
  const port = Number(info.port || s.apiPort);
  let url = info.url || s.apiUrl || '';
  if (!url && Number.isFinite(port)) url = 'http://127.0.0.1:' + port + '/api/speak';
  urlEl.value = url;
  urlEl.placeholder = '—';

  tokenEl.value = surfToken || '';
  tokenEl.type = surfTokenVisible ? 'text' : 'password';
  tokenEl.placeholder = surfTokenLoaded ? '' : '点击「显示」获取';
  const toggle = el('btn-surf-token-toggle');
  if (toggle) toggle.textContent = surfTokenVisible ? '隐藏' : '显示';

  const apiState = el('surf-api-state');
  if (apiState) {
    let text = '';
    if (s.apiRunning === true) {
      text = '本地 API 服务：运行中' + (Number.isFinite(port) ? '（端口 ' + port + '）' : '');
    } else if (s.apiRunning === false) {
      text = '本地 API 服务：未运行';
    }
    apiState.textContent = text;
    apiState.hidden = !text;
  }

  const lockEl = el('surf-token-lock');
  if (lockEl) {
    const text = tokenLockText(info);
    lockEl.textContent = text;
    lockEl.hidden = !text;
  }
}

function renderSurfChat() {
  const box = el('surf-chat-log');
  if (!box) return;
  box.innerHTML = '';
  if (!surfChatLog.length) {
    const hint = document.createElement('div');
    hint.className = 'hint';
    hint.textContent = '还没有对话，先发一句试试。';
    box.appendChild(hint);
    return;
  }
  for (const m of surfChatLog) {
    const row = document.createElement('div');
    row.className = 'surf-msg ' + (m.kind === 'user' ? 'user' : m.kind === 'role' ? 'role' : 'sys');
    row.textContent = m.text;
    box.appendChild(row);
  }
  box.scrollTop = box.scrollHeight;
}

function pushSurfChat(kind, text) {
  const t = String(text === undefined || text === null ? '' : text).trim();
  if (!t) return;
  surfChatLog.push({ kind, text: t });
  if (surfChatLog.length > SURF_CHAT_LIMIT) surfChatLog = surfChatLog.slice(surfChatLog.length - SURF_CHAT_LIMIT);
  renderSurfChat();
}

async function sendSurfChat() {
  if (surfSending) return;
  const input = el('surf-chat-input');
  if (!input) return;
  const text = String(input.value || '').trim();
  if (!text) return;
  const s = surfOf();
  if (s && s.chatEnabled === false) {
    setSurfStatus('SurfCore 对话未开启，请先在 SurfCore 设置里打开。', true);
    return;
  }
  surfSending = true;
  input.value = '';
  input.disabled = true;
  const send = el('btn-surf-send');
  if (send) send.disabled = true;
  pushSurfChat('user', text);
  const res = await callAsync('surfChat', text);
  surfSending = false;
  renderSurf();
  if (!res || res.unsupported) {
    pushSurfChat('sys', '当前版本暂不支持对话（主进程未提供 surfChat）。');
    return;
  }
  if (res.ok === false) {
    pushSurfChat('sys', '发送失败：' + errText(res.error));
    return;
  }
  const reply = res.reply || {};
  const replyText = (reply && typeof reply === 'object' ? reply.text : '') || res.text || '';
  if (replyText) pushSurfChat('role', replyText);
  else pushSurfChat('sys', '没有收到回复内容。');
}

async function testSurfSpeak() {
  const btn = el('btn-surf-test');
  if (btn) btn.disabled = true;
  setSurfStatus('正在让角色说一句…', false);
  const res = await callAsync('surfTest');
  if (btn) btn.disabled = false;
  if (!res || res.unsupported) {
    setSurfStatus('当前版本暂不支持测试（主进程未提供 surfTest）。', true);
    return;
  }
  if (res.ok === false) {
    setSurfStatus('测试失败：' + errText(res.error), true);
    return;
  }
  const reply = res.reply;
  const text = reply && typeof reply === 'object' ? (reply.text || '') : (typeof reply === 'string' ? reply : '');
  if (text) pushSurfChat('role', text);
  setSurfStatus('已让角色说一句。', false);
}

async function refreshSurfStatus() {
  const btn = el('btn-surf-refresh');
  if (btn) btn.disabled = true;
  setSurfStatus('正在刷新状态…', false);
  const res = await callAsync('surfStatus');
  if (btn) btn.disabled = false;
  if (!res || res.unsupported) {
    setSurfStatus('当前版本暂不支持刷新（主进程未提供 surfStatus）。', true);
    return;
  }
  if (res.ok === false) {
    setSurfStatus('刷新失败：' + errText(res.error), true);
    return;
  }
  if (res.surf && typeof res.surf === 'object') surf = Object.assign({}, surf || {}, res.surf);
  if (typeof res.autoStart === 'boolean') surfAutoStart = res.autoStart;
  renderSurf();
  renderSurfToken();
  setSurfStatus('状态已刷新。', false);
}

function loadSurfToken(action) {
  if (surfTokenLoading) return Promise.resolve(null);
  surfTokenLoading = true;
  return callAsync('getApiToken', action || 'get').then((res) => {
    surfTokenLoading = false;
    if (!res || res.unsupported) {
      setSurfApiStatus('当前版本暂不支持（主进程未提供 getApiToken）。', true);
      return null;
    }
    if (res.ok === false) {
      setSurfApiStatus('获取 token 失败：' + errText(res.error), true);
      renderSurfToken();
      return null;
    }
    surfToken = res.token || surfToken || '';
    surfTokenInfo = res;
    surfTokenLoaded = true;
    renderSurfToken();
    if (action === 'regenerate') setSurfApiStatus('已重新生成 token，旧 token 已失效。', false);
    return res;
  });
}

function ensureSurfToken() {
  if (surfTokenLoaded || surfTokenLoading) return;
  loadSurfToken('get');
}

function toggleSurfToken() {
  if (!surfTokenLoaded) {
    loadSurfToken('get').then((res) => {
      if (res) {
        surfTokenVisible = true;
        renderSurfToken();
      }
    });
    return;
  }
  surfTokenVisible = !surfTokenVisible;
  renderSurfToken();
}

function fallbackCopy(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    if (document.body && document.body.appendChild) document.body.appendChild(ta);
    if (ta.select) ta.select();
    const ok = document.execCommand ? document.execCommand('copy') : false;
    if (document.body && document.body.removeChild) document.body.removeChild(ta);
    return !!ok;
  } catch (_) {
    return false;
  }
}

function copyText(text) {
  if (!text) return Promise.resolve(false);
  if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text).then(() => true).catch(() => Promise.resolve(fallbackCopy(text)));
  }
  return Promise.resolve(fallbackCopy(text));
}

function copySurfToken() {
  if (!surfTokenLoaded || !surfToken) {
    loadSurfToken('get').then((res) => {
      if (res && surfToken) copySurfToken();
      else setSurfApiStatus('还没有可复制的 token。', true);
    });
    return;
  }
  copyText(surfToken).then((ok) => {
    setSurfApiStatus(ok ? 'Token 已复制到剪贴板。' : '复制失败，请点「显示」后手动复制。', !ok);
  });
}

function regenerateSurfToken() {
  setSurfApiStatus('正在重新生成 token…', false);
  loadSurfToken('regenerate').then((res) => {
    if (res) {
      surfTokenVisible = false;
      renderSurfToken();
    }
  });
}

function surfSend(method, ...args) {
  const fn = api && api[method];
  if (typeof fn !== 'function') {
    setSurfStatus('当前版本暂不支持（主进程未提供 ' + method + '）。', true);
    return false;
  }
  try {
    fn.apply(api, args);
    return true;
  } catch (err) {
    setSurfStatus('操作失败：' + errText(err), true);
    return false;
  }
}

function setupSurf() {
  const on = (id, fn) => {
    const node = el(id);
    if (node) node.addEventListener('click', fn);
  };
  on('btn-surf-refresh', refreshSurfStatus);
  on('btn-surf-test', testSurfSpeak);
  on('btn-surf-settings', () => surfSend('surfOpenSettings'));
  on('btn-surf-token-toggle', toggleSurfToken);
  on('btn-surf-token-copy', copySurfToken);
  on('btn-surf-token-regen', regenerateSurfToken);

  const send = el('btn-surf-send');
  if (send) send.addEventListener('click', sendSurfChat);
  const input = el('surf-chat-input');
  if (input) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        if (e.preventDefault) e.preventDefault();
        sendSurfChat();
      }
    });
  }

  const enabled = el('surf-enabled');
  if (enabled) enabled.addEventListener('change', (e) => surfSend('surfSetOption', 'enabled', !!e.target.checked));
  const autoTalk = el('surf-autotalk');
  if (autoTalk) autoTalk.addEventListener('change', (e) => surfSend('surfSetOption', 'autoTalk', !!e.target.checked));
  const interval = el('surf-interval');
  if (interval) interval.addEventListener('change', (e) => surfSend('surfSetOption', 'intervalMin', Number(e.target.value)));
  const autoStart = el('surf-autostart');
  if (autoStart) autoStart.addEventListener('change', (e) => surfSend('setAutoStart', !!e.target.checked));

  // 首次切到 AI 页时再拉 token，避免启动时多一次 IPC
  const aiTab = document.querySelector('[data-tab="ai"]');
  if (aiTab) {
    aiTab.addEventListener('click', () => {
      ensureSurfToken();
      renderSurf();
      renderSurfToken();
    });
  }
  renderSurfChat();
}

// ---------------------------------------------------------------------------
// settings
// ---------------------------------------------------------------------------
function renderMemorySlots() {
  const box = el('memory-slots');
  if (!box) return;
  box.innerHTML = '';
  const points = state && Array.isArray(state.memoryPoints) ? state.memoryPoints : [null, null, null];
  for (let i = 0; i < 3; i++) {
    const p = points[i];
    const row = document.createElement('div');
    row.className = 'memory-row';
    const label = document.createElement('div');
    label.className = 'memory-label';
    const title = document.createElement('span');
    title.textContent = '记忆点 ' + (i + 1);
    const small = document.createElement('small');
    small.textContent = p ? p.width + ' × ' + p.height + ' @ ' + p.x + ', ' + p.y : '未保存';
    label.appendChild(title);
    label.appendChild(small);
    const saveBtn = document.createElement('button');
    saveBtn.className = 'ghost';
    saveBtn.textContent = '存当前位置';
    saveBtn.addEventListener('click', () => api.setOption('memory-save', i));
    const goBtn = document.createElement('button');
    goBtn.className = 'ghost';
    goBtn.textContent = '跳过去';
    goBtn.disabled = !p;
    goBtn.addEventListener('click', () => api.setOption('memory-goto', i));
    row.appendChild(label);
    row.appendChild(saveBtn);
    row.appendChild(goBtn);
    box.appendChild(row);
  }
}

function syncSettings() {
  if (!state) return;
  el('opt-pinned').checked = !!state.pinned;
  el('opt-locked').checked = !!state.locked;
  el('opt-drag-transparent').checked = state.dragOnTransparent !== false;
  el('opt-dblclick-lower').checked = state.dblclickLower !== false;
  el('opt-ontop').checked = !!state.alwaysOnTop;
  el('opt-follow').checked = !!state.followMouse;
  el('opt-armsway').checked = state.armSway !== false;
  el('opt-bubble').checked = state.bubbleEnabled !== false;
  el('btn-bubble-adjust').textContent = state.bubbleAdjusting ? '完成调整' : '调整气泡位置';
  el('btn-bubble-adjust').classList.toggle('active', !!state.bubbleAdjusting);
  const strength = Number(state.strength) || 0;
  el('opt-strength').value = String(strength);
  el('val-strength').textContent = Math.round(strength * 100) + '%';
  const opacity = Number(state.opacity) || 1;
  el('opt-opacity').value = String(opacity);
  el('val-opacity').textContent = Math.round(opacity * 100) + '%';
  const h = Number(state.height) || 820;
  el('opt-size').value = String(h);
  el('val-size').textContent = `${Math.round(h * 0.583)} × ${h}`;
  renderMemorySlots();
  if (overrides !== state.overrides) {
    overrides = state.overrides || {};
    for (const entry of renderedRows.values()) applyOverrideStyle(entry);
  }
  if (state && Object.prototype.hasOwnProperty.call(state, 'surf')) {
    surf = state.surf && typeof state.surf === 'object' ? Object.assign({}, state.surf) : null;
  }
  if (state && Object.prototype.hasOwnProperty.call(state, 'autoStart')) surfAutoStart = !!state.autoStart;
  renderModels();
  renderSurf();
  renderSurfToken();
}

function setupSettings() {
  el('opt-pinned').addEventListener('change', (e) => api.setOption('pinned', e.target.checked));
  el('opt-locked').addEventListener('change', (e) => api.setOption('locked', e.target.checked));
  el('opt-drag-transparent').addEventListener('change', (e) => api.setOption('dragOnTransparent', e.target.checked));
  el('opt-dblclick-lower').addEventListener('change', (e) => api.setOption('dblclickLower', e.target.checked));
  el('opt-ontop').addEventListener('change', (e) => api.setOption('alwaysOnTop', e.target.checked));
  el('opt-follow').addEventListener('change', (e) => api.setOption('followMouse', e.target.checked));
  el('opt-armsway').addEventListener('change', (e) => api.setOption('armSway', e.target.checked));
  el('opt-bubble').addEventListener('change', (e) => api.setOption('bubbleEnabled', e.target.checked));
  el('btn-bubble-adjust').addEventListener('click', () => api.setOption('bubble-adjust', !(state && state.bubbleAdjusting)));
  el('btn-bubble-reset').addEventListener('click', () => api.setOption('bubble-reset', true));
  el('opt-strength').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    el('val-strength').textContent = Math.round(v * 100) + '%';
    api.setOption('strength', v);
  });
  el('opt-opacity').addEventListener('input', (e) => {
    const v = Number(e.target.value);
    el('val-opacity').textContent = Math.round(v * 100) + '%';
    api.setOption('opacity', v);
  });
  el('opt-size').addEventListener('input', (e) => {
    const h = Number(e.target.value);
    const w = Math.round(h * 0.583);
    el('val-size').textContent = `${w} × ${h}`;
    api.setOption('size', { width: w, height: h });
  });
  for (const btn of document.querySelectorAll('.size-presets [data-size]')) {
    btn.addEventListener('click', () => {
      const [w, h] = btn.dataset.size.split(',').map(Number);
      api.setOption('size', { width: w, height: h });
    });
  }
  el('btn-recenter').addEventListener('click', () => api.setOption('recenter', true));
  el('btn-quit').addEventListener('click', () => api.quit());
  el('btn-minimize').addEventListener('click', () => api.minimize());
  el('btn-close').addEventListener('click', () => api.close());
  el('btn-reset-all').addEventListener('click', () => {
    overrides = {};
    for (const entry of renderedRows.values()) applyOverrideStyle(entry);
    api.resetAll();
  });
  el('btn-view-reset').addEventListener('click', () => api.resetView());
  el('btn-reset-expression').addEventListener('click', () => {
    activeExpression = -1;
    for (const b of el('expression-list').children) b.classList.remove('active');
    api.setExpression(-1);
  });
  el('search').addEventListener('input', (e) => {
    searchQuery = e.target.value.trim();
    renderParamList();
    syncValues();
  });
  const backIdleBtn = el('btn-back-idle');
  if (backIdleBtn) backIdleBtn.addEventListener('click', () => { if (api.backToIdle) api.backToIdle(); });

  for (const btn of document.querySelectorAll('#tabs button')) {
    btn.addEventListener('click', () => {
      activeTab = btn.dataset.tab;
      for (const b of document.querySelectorAll('#tabs button')) b.classList.toggle('active', b === btn);
      for (const t of document.querySelectorAll('.tab')) t.classList.toggle('active', t.id === 'tab-' + activeTab);
    });
  }
}

function renderAbout() {
  if (!info) return;
  el('about').textContent =
    `模型：${info.modelName}\n` +
    `参数：${info.params.length} 个 / ${info.groups.length} 组 · 表情 ${info.expressions.length} 个 · 动作 ${info.motions.length} 个\n` +
    `Cubism Core：${info.coreVersion ? (info.coreVersion >>> 24) + '.' + ((info.coreVersion >> 16) & 255) + '.' + ((info.coreVersion >> 8) & 255) : '—'}\n` +
    `提示：拖动桌宠移动 · 双击打开/关闭面板 · 右键更多菜单 · Ctrl+Alt+P 固定/取消固定`;
}

// ---------------------------------------------------------------------------
// interaction editor (bubble texts / custom touch zones / expressions)
// ---------------------------------------------------------------------------
const IX_REGIONS = [
  ['head', '头'], ['face', '脸'], ['arm', '手 / 袖子'],
  ['body', '身体'], ['leg', '腿'], ['tail', '尾巴'],
];
let interaction = null;
let interactionLoaded = false;
let ixSelectedZone = -1;
let ixPickActive = false;

function ixExprOptions(select, value) {
  if (!select) return;
  select.innerHTML = '';
  const opts = [['', '无'], ['auto', '自动匹配']];
  const list = info && Array.isArray(info.expressions) ? info.expressions : [];
  for (const e of list) opts.push([e.name, e.name]);
  for (const [v, label] of opts) {
    const o = document.createElement('option');
    o.value = v;
    o.textContent = label;
    select.appendChild(o);
  }
  const wanted = String(value || '');
  select.value = opts.some(([v]) => v === wanted) ? wanted : 'auto';
}

function renderInteraction() {
  if (!interaction) return;
  const textBox = el('ix-region-texts');
  const exprBox = el('ix-region-expressions');
  if (textBox) {
    textBox.innerHTML = '';
    for (const [region, label] of IX_REGIONS) {
      const row = document.createElement('div');
      row.className = 'ix-row';
      const name = document.createElement('div');
      name.className = 'ix-label';
      name.textContent = label;
      const ta = document.createElement('textarea');
      ta.id = 'ix-text-' + region;
      ta.rows = 2;
      ta.placeholder = '留空 = 使用默认台词；每行一条';
      ta.value = ((interaction.bubbleTexts && interaction.bubbleTexts[region]) || []).join(String.fromCharCode(10));
      row.appendChild(name);
      row.appendChild(ta);
      textBox.appendChild(row);
    }
  }
  if (exprBox) {
    exprBox.innerHTML = '';
    for (const [region, label] of IX_REGIONS) {
      const row = document.createElement('div');
      row.className = 'ix-row ix-row-inline';
      const name = document.createElement('div');
      name.className = 'ix-label';
      name.textContent = label;
      const sel = document.createElement('select');
      sel.id = 'ix-expr-' + region;
      ixExprOptions(sel, interaction.regionExpressions && interaction.regionExpressions[region]);
      row.appendChild(name);
      row.appendChild(sel);
      exprBox.appendChild(row);
    }
  }
  const zonesBox = el('ix-zones');
  if (zonesBox) {
    zonesBox.innerHTML = '';
    const zones = Array.isArray(interaction.zones) ? interaction.zones : [];
    zones.forEach((z, index) => addZoneRow(z, index, zonesBox));
    if (ixSelectedZone >= 0 && ixSelectedZone < zones.length) ixSelectZone(zonesBox, ixSelectedZone);
  }
  const apiSwitch = el('ix-touch-api');
  if (apiSwitch) apiSwitch.checked = interaction.touchUseApi === true;
  const resetInput = el('ix-expr-reset');
  if (resetInput) resetInput.value = String(interaction.expressionResetSec != null ? interaction.expressionResetSec : 60);
}

function addZoneRow(zone, index, box) {
  const root = document.createElement('div');
  root.className = 'ix-zone';
  root.dataset.index = String(index);
  const head = document.createElement('div');
  head.className = 'ix-zone-head';
  const name = document.createElement('input');
  name.className = 'z-name';
  name.placeholder = '触碰点名称';
  name.value = zone.name || ('触碰点 ' + (index + 1));
  const del = document.createElement('button');
  del.className = 'ghost z-del';
  del.textContent = '删除';
  del.addEventListener('click', () => { root.remove(); });
  head.appendChild(name);
  head.appendChild(del);
  const grid = document.createElement('div');
  grid.className = 'ix-zone-grid';
  const fields = [
    ['z-x', 'X %', zone.x, 0, 100, 1],
    ['z-y', 'Y %', zone.y, 0, 100, 1],
    ['z-r', '半径 %', zone.r, 1, 50, 1],
  ];
  for (const [cls, label, value, min, max, step] of fields) {
    const wrap = document.createElement('label');
    wrap.className = 'ix-field';
    const span = document.createElement('span');
    span.textContent = label;
    const input = document.createElement('input');
    input.type = 'number';
    input.className = cls;
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(Number(value) || 0);
    wrap.appendChild(span);
    wrap.appendChild(input);
    grid.appendChild(wrap);
  }
  const exprWrap = document.createElement('label');
  exprWrap.className = 'ix-field';
  const exprSpan = document.createElement('span');
  exprSpan.textContent = '触碰表情';
  const exprSel = document.createElement('select');
  exprSel.className = 'z-expr';
  ixExprOptions(exprSel, zone.expression);
  exprWrap.appendChild(exprSpan);
  exprWrap.appendChild(exprSel);
  grid.appendChild(exprWrap);
  const apiWrap = document.createElement('label');
  apiWrap.className = 'ix-field ix-check';
  const apiCb = document.createElement('input');
  apiCb.type = 'checkbox';
  apiCb.className = 'z-api';
  apiCb.checked = zone.useApi === true;
  const apiSpan = document.createElement('span');
  apiSpan.textContent = '触碰用 AI';
  apiWrap.appendChild(apiCb);
  apiWrap.appendChild(apiSpan);
  grid.appendChild(apiWrap);
  const ta = document.createElement('textarea');
  ta.className = 'z-text';
  ta.rows = 2;
  ta.placeholder = '每行一条台词；留空则用区域台词';
  ta.value = zone.text || '';
  root.appendChild(head);
  root.appendChild(grid);
  root.appendChild(ta);
  root.addEventListener('click', () => { if (ixPickActive) return; ixSelectZone(box, index); });
  box.appendChild(root);
}

function ixSelectZone(box, index) {
  ixSelectedZone = index;
  const rows = box.querySelectorAll('.ix-zone');
  rows.forEach((row, i) => row.classList.toggle('selected', i === index));
}

function ixPickCoords() {
  const status = el('ix-status');
  const btn = el('ix-pick-coords');
  if (ixPickActive) {
    ixPickActive = false;
    if (btn) btn.textContent = '点击角色抓取坐标';
    if (api.cancelInteractionPick) api.cancelInteractionPick().catch(() => {});
    if (status) status.textContent = '已取消抓取';
    return;
  }
  if (!api.startInteractionPick) {
    if (status) status.textContent = '当前版本不支持抓取坐标';
    return;
  }
  const box = el('ix-zones');
  if (!box) return;
  let rows = box.querySelectorAll('.ix-zone');
  if (!rows.length || ixSelectedZone < 0 || ixSelectedZone >= rows.length) {
    addZoneRow({ x: 50, y: 50, r: 12, expression: 'auto', useApi: false }, rows.length, box);
    rows = box.querySelectorAll('.ix-zone');
    ixSelectedZone = rows.length - 1;
    ixSelectZone(box, ixSelectedZone);
  }
  ixPickActive = true;
  if (btn) btn.textContent = '等待点击角色…（再点取消）';
  if (status) status.textContent = '请点击桌宠角色上的目标位置（30 秒内有效）';
  api.startInteractionPick().then((r) => {
    if (!r || !r.ok) {
      ixPickActive = false;
      if (btn) btn.textContent = '点击角色抓取坐标';
      if (status) status.textContent = '抓取启动失败';
    }
  }).catch(() => {});
}

function fillPickedCoords(x, y) {
  const box = el('ix-zones');
  if (!box) return;
  const rows = box.querySelectorAll('.ix-zone');
  const idx = ixSelectedZone >= 0 && ixSelectedZone < rows.length ? ixSelectedZone : rows.length - 1;
  const row = rows[idx];
  if (!row) return;
  const xEl = row.querySelector('.z-x');
  const yEl = row.querySelector('.z-y');
  if (xEl) xEl.value = String(x);
  if (yEl) yEl.value = String(y);
  ixSelectZone(box, idx);
  const status = el('ix-status');
  if (status) status.textContent = '已抓取坐标 X=' + x + '% Y=' + y + '%，记得点「保存互动设置」';
  const btn = el('ix-pick-coords');
  if (btn) btn.textContent = '点击角色抓取坐标';
  ixPickActive = false;
}

function collectInteraction() {
  const bubbleTexts = {};
  const regionExpressions = {};
  for (const [region] of IX_REGIONS) {
    const ta = el('ix-text-' + region);
    const lines = ta ? ta.value.split(String.fromCharCode(10)).map((s) => s.trim()).filter(Boolean) : [];
    bubbleTexts[region] = lines;
    const sel = el('ix-expr-' + region);
    regionExpressions[region] = sel ? sel.value : 'auto';
  }
  const zones = [];
  const box = el('ix-zones');
  if (box) {
    for (const root of box.querySelectorAll('.ix-zone')) {
      const nameEl = root.querySelector('.z-name');
      const textEl = root.querySelector('.z-text');
      const exprEl = root.querySelector('.z-expr');
      const apiEl = root.querySelector('.z-api');
      const xEl = root.querySelector('.z-x');
      const yEl = root.querySelector('.z-y');
      const rEl = root.querySelector('.z-r');
      zones.push({
        id: 'z' + (zones.length + 1),
        name: nameEl ? nameEl.value.trim() : '',
        x: xEl ? Number(xEl.value) : 50,
        y: yEl ? Number(yEl.value) : 30,
        r: rEl ? Number(rEl.value) : 12,
        text: textEl ? textEl.value : '',
        expression: exprEl ? exprEl.value : '',
        useApi: !!(apiEl && apiEl.checked),
      });
    }
  }
  return {
    bubbleTexts,
    regionExpressions,
    zones,
    touchUseApi: !!(el('ix-touch-api') && el('ix-touch-api').checked),
    expressionResetSec: Math.max(0, Math.min(3600, Number((el('ix-expr-reset') || {}).value) || 0)),
  };
}

function loadInteraction(force) {
  if (interactionLoaded && !force) return;
  if (!api.getInteraction) {
    if (el('ix-status')) el('ix-status').textContent = '当前版本不支持互动设置';
    return;
  }
  api.getInteraction().then((r) => {
    if (!r || !r.ok) return;
    interaction = r.interaction;
    interactionLoaded = true;
    renderInteraction();
  }).catch(() => {});
}

function setupInteraction() {
  const add = el('ix-add-zone');
  if (add) add.addEventListener('click', () => {
    const box = el('ix-zones');
    if (!box) return;
    addZoneRow({ x: 50, y: 30, r: 12, expression: 'auto', useApi: false }, box.children.length, box);
  });
  const pick = el('ix-pick-coords');
  if (pick) pick.addEventListener('click', ixPickCoords);
  if (api.onInteractionCapture) {
    api.onInteractionCapture((data) => {
      if (!data) return;
      if (data.cancelled) {
        ixPickActive = false;
        const btn = el('ix-pick-coords');
        if (btn) btn.textContent = '点击角色抓取坐标';
        const status = el('ix-status');
        if (status) status.textContent = '抓取超时，请重新点按钮';
        return;
      }
      if (Number.isFinite(Number(data.x)) && Number.isFinite(Number(data.y))) {
        fillPickedCoords(Number(data.x), Number(data.y));
      }
    });
  }

  const save = el('ix-save');
  if (save) save.addEventListener('click', () => {
    if (!api.saveInteraction) return;
    const status = el('ix-status');
    if (status) status.textContent = '保存中…';
    api.saveInteraction(collectInteraction()).then((r) => {
      if (r && r.ok) {
        interaction = r.interaction;
        if (status) status.textContent = '已保存';
        renderInteraction();
      } else if (status) {
        status.textContent = '保存失败';
      }
    }).catch(() => { if (status) status.textContent = '保存失败'; });
  });
  for (const btn of document.querySelectorAll('#tabs button')) {
    btn.addEventListener('click', () => {
      if (btn.dataset.tab === 'interaction') loadInteraction();
    });
  }
}

function build() {
  buildGroups();
  renderParamList();
  renderExpressions();
  renderMotions();
  renderAbout();
  syncSettings();
  syncValues();
  if (interaction) renderInteraction();
}

// ---------------------------------------------------------------------------
// ipc
// ---------------------------------------------------------------------------
api.onInit((data) => {
  if (!data) return;
  if (data.state) {
    state = data.state;
    overrides = state.overrides || {};
    syncSettings();
  }
  if (data.modelInfo) {
    info = data.modelInfo;
    build();
  }
});

api.onModelInfo((mi) => {
  info = mi;
  build();
});

api.onState((s) => {
  if (!s) return;
  state = s;
  if (s.overrides) overrides = s.overrides;
  syncSettings();
  for (const entry of renderedRows.values()) applyOverrideStyle(entry);
});

api.onValues((v) => {
  values = v;
  syncValues();
});

if (api && typeof api.onSurfState === 'function') {
  api.onSurfState((payload) => {
    if (!payload || typeof payload !== 'object') return;
    if (payload.surf && typeof payload.surf === 'object') {
      surf = Object.assign({}, surf || {}, payload.surf);
    } else if ('enabled' in payload || 'connected' in payload || 'roleName' in payload) {
      surf = Object.assign({}, surf || {}, payload);
    }
    if (typeof payload.autoStart === 'boolean') surfAutoStart = payload.autoStart;
    renderSurf();
    renderSurfToken();
  });
}

setupSettings();
setupModels();
setupSurf();
setupInteraction();
loadInteraction();
api.requestInit();
