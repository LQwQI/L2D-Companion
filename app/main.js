'use strict';

const {
  app, BrowserWindow, ipcMain, screen, Tray, Menu, nativeImage,
  globalShortcut, protocol, net, dialog, shell,
} = require('electron');
const path = require('path');

// Keep the profile directory stable across product renames, so the model
// library and settings survive a name change.
try {
  app.setPath('userData', path.join(app.getPath('appData'), 'deepseek-live2d-pet'));
} catch (_) {}
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { pathToFileURL } = require('url');

// ---------------------------------------------------------------------------
// command line flags (smoke tests)
// ---------------------------------------------------------------------------
const argv = process.argv;
const isSmoke = argv.includes('--smoke');
const isSmokeLook = argv.includes('--smoke-look');
const smokePanel = argv.includes('--smoke-panel');
function argValue(name, fallback) {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
}
const smokeOut = argValue('--smoke-out', '');
const smokeImportDir = argValue('--smoke-import', '');

// ---------------------------------------------------------------------------
// paths
// ---------------------------------------------------------------------------
const APP_ROOT = path.join(__dirname, '..');
const RES_ROOT = app.isPackaged ? process.resourcesPath : APP_ROOT;
const CORE_ROOT = app.isPackaged ? path.join(process.resourcesPath, 'core') : path.join(__dirname, 'core');
let modelScanner = null;
try { modelScanner = require('./model-scan'); } catch (e) { console.error('[model-scan] load failed', e); }
let surfcoreLib = null;
try { surfcoreLib = require('./surfcore'); } catch (e) { console.error('[surfcore] load failed', e); }

// ---------------------------------------------------------------------------
// persistent config
// ---------------------------------------------------------------------------
const DEFAULT_BUBBLE_OFFSET = { x: -70, y: 42 };

const DEFAULT_CONFIG = {
  x: null,
  y: null,
  width: 480,
  height: 820,
  pinned: false,
  followMouse: true,
  strength: 1,
  opacity: 1,
  alwaysOnTop: true,
  overrides: {},
  panelOpen: false,
  armSway: true,
  memoryPoints: [null, null, null],
  bubbleEnabled: true,
  dragOnTransparent: true,
  dblclickLower: true,
  bubbleOffset: { ...DEFAULT_BUBBLE_OFFSET },
  models: [],
  currentModelId: null,
  autoStart: false,
  qqLink: true,
  // 外部联动的可执行路径；留空时按常见安装位置自动探测，探测不到就跳过
  qqLinkPaths: { script: '', node: '', pidFile: '' },
  // SurfCore 配置里带 SnowLuma 的 token 和 ownerQQ，用来给主人发 QQ；留空用默认位置
  surfcoreConfig: '',
  locked: false,
  interaction: {
    bubbleTexts: { head: [], face: [], arm: [], body: [], leg: [], tail: [] },
    regionExpressions: { head: 'auto', face: 'auto', arm: 'auto', body: 'auto', leg: 'auto', tail: 'auto' },
    zones: [],
    touchUseApi: false,
    expressionResetSec: 60,
  },
  surf: {
    enabled: true,
    autoTalk: true,
    intervalMin: 30,
    apiPort: 3199,
    apiToken: '',
  },
};

let config = { ...DEFAULT_CONFIG };
let panelWin = null;
let petWin = null;
let tray = null;
let modelInfo = null;
let quitting = false;
let bubbleWin = null;
let bubbleVisible = false;
let bubbleAdjusting = false;
let bubblePendingShow = false;
let bubbleWanted = false;
let bubbleSize = { width: 220, height: 60 };
let bubbleHideTimer = null;
let bubbleMoveGuard = 0;
let petMetrics = null;
let chatWin = null;
let surf = null;
let bubblePendingDuration = 4600;
// 触碰时「AI 优先」：勾了「触碰调用 AI」后不再同时弹默认互动文本。
// 先显示「…」，等 AI 回复（AI 气泡会走 showBubble 把这个等待清掉）；
// 若一定时间内没有回复，才回退到默认文本，避免两条气泡打架。
let touchFallbackTimer = null;
const TOUCH_AI_WAIT_MS = 6000;
function clearTouchFallback() {
  if (touchFallbackTimer) { clearTimeout(touchFallbackTimer); touchFallbackTimer = null; }
}
function armTouchFallback(text) {
  clearTouchFallback();
  touchFallbackTimer = setTimeout(() => {
    touchFallbackTimer = null;
    showBubble(text);
  }, TOUCH_AI_WAIT_MS);
}
let petLowered = false;

// ---------------------------------------------------------------------------
// 把桌宠窗口下沉一层 / 提回最上层（双击透明区触发）
// ---------------------------------------------------------------------------
function windowBottomHelperPath() {
  return path.join(app.getPath('userData'), 'set-window-bottom.ps1');
}
function ensureWindowBottomHelper() {
  const file = windowBottomHelperPath();
  try {
    if (fs.existsSync(file)) return file;
    const src = [
      'param([string]$hwnd)',
      "Add-Type -Name W -Namespace PetZ -MemberDefinition '[DllImport(\"user32.dll\")] public static extern bool SetWindowPos(IntPtr h, IntPtr a, int x, int y, int cx, int cy, uint f);'",
      '$h = [IntPtr][long]$hwnd',
      '[PetZ.W]::SetWindowPos($h, [IntPtr]1, 0, 0, 0, 0, [uint32](0x0001 -bor 0x0002 -bor 0x0004)) | Out-Null',
    ].join('\n');
    fs.writeFileSync(file, src, 'utf8');
    return file;
  } catch (_) { return ''; }
}
function setWindowBottom(hwnd) {
  const helper = ensureWindowBottomHelper();
  if (!helper || !hwnd) return;
  try {
    const { spawn } = require('child_process');
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', helper, String(hwnd)], {
      windowsHide: true, stdio: 'ignore', detached: true,
    });
    child.unref();
  } catch (_) {}
}
function lowerPetOneLevel() {
  if (!petWin || petWin.isDestroyed()) return;
  petLowered = true;
  try { petWin.setAlwaysOnTop(false); } catch (_) {}
  // Keep the window focusable: if it is lowered but not covered, clicking
  // the model should still trigger interaction / let the user drag it back.
  try { petWin.setFocusable(true); } catch (_) {}
  try {
    const buf = petWin.getNativeWindowHandle();
    const hwnd = buf.length >= 8 ? Number(buf.readBigUInt64LE(0)) : buf.readUInt32LE(0);
    setWindowBottom(hwnd);
  } catch (e) {
    console.error('[lower] failed', e);
  }
  try { showBubble('桌宠已下沉一层，按 Ctrl+Alt+T 或托盘菜单提回', { durationMs: 4200 }); } catch (_) {}
  try {
    if (tray && tray.displayBalloon) tray.displayBalloon({ title: 'L2D Companion', content: '桌宠已下沉到下层，按 Ctrl+Alt+T 或托盘菜单可提回' });
  } catch (_) {}
  broadcastState();
}
function bringPetToTop() {
  if (!petWin || petWin.isDestroyed()) return;
  petLowered = false;
  try { petWin.setFocusable(true); } catch (_) {}
  applyWindowOptions();
  try { petWin.setAlwaysOnTop(config.alwaysOnTop === true); } catch (_) {}
  try { petWin.moveTop(); } catch (_) {}
  try { petWin.showInactive(); } catch (_) {}
  broadcastState();
}

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}
function loadConfig() {
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    const parsed = JSON.parse(raw);
    config = { ...DEFAULT_CONFIG, ...parsed, overrides: parsed.overrides || {} };
    if (!Array.isArray(config.models)) config.models = [];
    if (config.currentModelId == null) config.currentModelId = null;
    if (!config.surf || typeof config.surf !== 'object') config.surf = { ...DEFAULT_CONFIG.surf };
    config.surf = { ...DEFAULT_CONFIG.surf, ...config.surf };
    config.autoStart = config.autoStart === true;
    config.qqLink = config.qqLink !== false;
    config.qqLinkPaths = sanitizeQqLinkPaths(config.qqLinkPaths);
    config.surfcoreConfig = typeof config.surfcoreConfig === 'string' ? config.surfcoreConfig.trim() : '';
    config.dragOnTransparent = config.dragOnTransparent !== false;
    config.dblclickLower = config.dblclickLower !== false;
    config.locked = config.locked === true;
    if (!config.bubbleOffset || typeof config.bubbleOffset !== 'object') {
      config.bubbleOffset = { ...DEFAULT_BUBBLE_OFFSET };
    } else {
      const bx = Number(config.bubbleOffset.x) || 0;
      const by = Number(config.bubbleOffset.y) || 0;
      const oldDefault = bx === 0 && by === 0 || bx === -40 && by === 0;
      config.bubbleOffset = oldDefault ? { ...DEFAULT_BUBBLE_OFFSET } : { x: bx, y: by };
    }
    config.interaction = sanitizeInteraction(config.interaction);
  } catch (_) {
    config = { ...DEFAULT_CONFIG, overrides: {} };
    config.qqLinkPaths = sanitizeQqLinkPaths(config.qqLinkPaths);
  }
}
let saveTimer = null;
function saveConfig() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(path.dirname(configPath()), { recursive: true });
      fs.writeFileSync(configPath(), JSON.stringify(config, null, 2), 'utf8');
    } catch (e) {
      console.error('[config] save failed', e);
    }
  }, 400);
}

// ---------------------------------------------------------------------------
// interaction config (bubble texts / custom touch zones / expressions)
// ---------------------------------------------------------------------------
const INTERACTION_REGIONS = ['head', 'face', 'arm', 'body', 'leg', 'tail'];
const INTERACTION_REGION_LABELS = { head: '头', face: '脸', arm: '手/袖子', body: '身体', leg: '腿', tail: '尾巴' };

function sanitizeExpressionName(value) {
  const s = String(value || '').trim();
  if (!s) return '';
  if (s === 'auto' || s === 'none') return s;
  return s.slice(0, 80);
}

function sanitizeInteraction(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const bubbleTexts = {};
  for (const region of INTERACTION_REGIONS) {
    const list = src.bubbleTexts && Array.isArray(src.bubbleTexts[region]) ? src.bubbleTexts[region] : [];
    bubbleTexts[region] = list
      .map((v) => String(v || '').trim())
      .filter(Boolean)
      .slice(0, 30)
      .map((v) => v.slice(0, 200));
  }
  const regionExpressions = {};
  for (const region of INTERACTION_REGIONS) {
    regionExpressions[region] = sanitizeExpressionName(src.regionExpressions && src.regionExpressions[region]) || 'auto';
  }
  const zones = (Array.isArray(src.zones) ? src.zones : []).slice(0, 60).map((z, i) => ({
    id: String(z && z.id || 'z' + (i + 1)).slice(0, 60),
    name: String(z && z.name || ('触碰点 ' + (i + 1))).slice(0, 40),
    x: Math.max(0, Math.min(100, Number(z && z.x) || 50)),
    y: Math.max(0, Math.min(100, Number(z && z.y) || 30)),
    r: Math.max(1, Math.min(50, Number(z && z.r) || 12)),
    text: String(z && z.text || '').slice(0, 2000),
    expression: sanitizeExpressionName(z && z.expression),
    useApi: !!(z && z.useApi),
  }));
  return {
    bubbleTexts,
    regionExpressions,
    zones,
    touchUseApi: src.touchUseApi === true,
    expressionResetSec: Math.max(0, Math.min(3600, Math.round(Number(src.expressionResetSec) || 0))),
  };
}

function interactionConfig() {
  config.interaction = sanitizeInteraction(config.interaction);
  return config.interaction;
}

function expressionEntries() {
  return modelInfo && Array.isArray(modelInfo.expressions) ? modelInfo.expressions : [];
}

function applyExpressionIndex(index) {
  if (!petWin || petWin.isDestroyed()) return;
  petWin.webContents.send('expression:set', { index: Number(index) });
}

let expressionResetTimer = null;
function clearExpressionResetTimer() {
  if (expressionResetTimer) {
    clearTimeout(expressionResetTimer);
    expressionResetTimer = null;
  }
}

function scheduleExpressionReset() {
  clearExpressionResetTimer();
  let sec = 0;
  try { sec = Number(interactionConfig().expressionResetSec) || 0; } catch (_) { sec = 0; }
  if (!(sec > 0)) return;
  expressionResetTimer = setTimeout(() => {
    expressionResetTimer = null;
    applyExpressionIndex(-1);
  }, Math.min(3600, sec) * 1000);
}

function findExpressionByName(name) {
  const wanted = String(name || '').trim().toLowerCase();
  if (!wanted) return null;
  const list = expressionEntries();
  return list.find((e) => String(e.name || '').toLowerCase() === wanted)
    || list.find((e) => String(e.name || '').toLowerCase().includes(wanted))
    || null;
}

const EXPRESSION_KEYWORDS = [
  [/害羞|脸红|羞|不好意思|傲娇/i, /害羞|脸红|羞|傲娇|脸红/i],
  [/开心|高[兴兴]|笑|哈哈|嘿嘿|喜欢|爱你|好耶|棒/i, /开心|笑|高[兴兴]|喜欢|爱心|星|happy|smile/i],
  [/生气|怒|哼|讨厌|烦|气死/i, /生气|怒|哼|angry|黑脸/i],
  [/难过|伤心|哭|泪|委屈|呜呜/i, /难过|哭|泪|悲伤|sad|cry/i],
  [/惊讶|震惊|诶|欸|居然|什么|！|!|惊/i, /惊讶|惊|呆|shock|surprise/i],
  [/爱心|心动|花痴|色/i, /爱心|心|heart|love/i],
  [/无语|汗|……|...|服了|离谱/i, /无语|汗|呆|白眼/i],
];

function autoExpressionName(text) {
  const t = String(text || '');
  const list = expressionEntries();
  for (const [textRe, exprRe] of EXPRESSION_KEYWORDS) {
    if (!textRe.test(t)) continue;
    const hit = list.find((e) => exprRe.test(String(e.name || '')));
    if (hit) return hit.name;
  }
  return '';
}

function applyTouchExpression(value, text) {
  const wanted = String(value || '').trim();
  if (!wanted || wanted === 'none') return;
  const name = wanted === 'auto' ? autoExpressionName(text) : wanted;
  if (!name) return;
  const expr = findExpressionByName(name);
  if (!expr) return;
  applyExpressionIndex(expr.index);
  scheduleExpressionReset();
}

function pickInteractionLine(text) {
  const list = String(text || '').split(/\r?\n/).map((v) => v.trim()).filter(Boolean);
  if (!list.length) return '';
  return list[Math.floor(Math.random() * list.length)];
}

function findTouchZone(x, y) {
  if (!petWin || petWin.isDestroyed() || !Number.isFinite(x) || !Number.isFinite(y)) return null;
  const cfg = interactionConfig();
  const b = petWin.getBounds();
  let best = null;
  let bestDist = Infinity;
  for (const z of cfg.zones) {
    const zx = (z.x / 100) * b.width;
    const zy = (z.y / 100) * b.height;
    const radius = (z.r / 100) * Math.min(b.width, b.height);
    const dist = Math.hypot(x - zx, y - zy);
    if (dist <= radius && dist < bestDist) {
      best = z;
      bestDist = dist;
    }
  }
  return best;
}

function surfChatReady() {
  try {
    const st = surf && surf.publicState();
    return !!(st && st.enabled && st.connected && st.chatEnabled);
  } catch (_) {
    return false;
  }
}

const TOUCH_ACTIONS = {
  head: ['轻轻摸了摸你的头', '揉了揉你的头发', '拍了拍你的脑袋', '用指尖戳了戳你的额头'],
  face: ['捏了捏你的脸', '戳了戳你的脸颊', '碰了碰你的鼻尖', '捧住你的脸看了看'],
  arm: ['拉了拉你的手臂', '碰了碰你的手背', '挽了一下你的胳膊', '捏了捏你的手腕'],
  body: ['从背后戳了戳你的腰', '轻轻碰了碰你的肩膀', '抱了你一下', '碰了碰你的后背'],
  leg: ['碰了碰你的腿', '戳了戳你的膝盖', '拉了拉你的裙角', '碰了碰你的脚踝'],
  tail: ['摸了摸你的尾巴', '轻轻拽了拽你的尾巴尖', '捏了捏你的尾巴', '从尾巴根顺了一下'],
};
const TOUCH_TONES = ['带点撒娇', '嘴硬但其实是关心', '假装不耐烦', '小声嘟囔', '温柔一点', '有点害羞', '困困的', '有点小得意', '忍不住吐槽'];
const TOUCH_MOODS = ['刚睡醒，还有点迷糊', '心情不错', '有点犯困', '正在发呆', '刚回过神来', '有点害羞', '心里偷偷开心', '有点小别扭'];
const TOUCH_LENGTHS = ['20~40', '25~50', '30~60', '15~35'];
const TOUCH_OPENINGS = ['开头不要用「唔」「哼」「喂」', '不要用叹气或省略号开头', '直接说你的反应，别先叫「爸爸」', '开头先带一个小动作，再说话', '用一个和上次不一样的短句开头'];
const recentReplyLines = [];

function rememberReply(text) {
  const line = String(text || '').trim();
  if (!line) return;
  recentReplyLines.push(line);
  while (recentReplyLines.length > 3) recentReplyLines.shift();
}

let lastTouchApiAt = 0;
let lastTouchRegion = '';
let lastTouchAction = '';
let touchStreak = 0;
let lastTouchAt = 0;

function pickTouch(list, exclude) {
  const pool = exclude && list.length > 1 ? list.filter((x) => x !== exclude) : list;
  return pool[Math.floor(Math.random() * pool.length)];
}

function touchTimeWord() {
  const h = new Date().getHours();
  if (h < 5) return '深夜';
  if (h < 9) return '清晨';
  if (h < 12) return '上午';
  if (h < 14) return '中午';
  if (h < 18) return '下午';
  if (h < 23) return '晚上';
  return '深夜';
}

function maybeTouchApiReaction(zone, region, text) {
  const cfg = interactionConfig();
  const useApi = zone ? zone.useApi === true : cfg.touchUseApi === true;
  if (!useApi || !surfChatReady()) return;
  const now = Date.now();
  if (now - lastTouchApiAt < 2500) return;
  lastTouchApiAt = now;

  // 连续触碰同一边会升级成「已经被戳了好几次」；换区域则重新计数。
  if (now - lastTouchAt < 9000 && region === lastTouchRegion) touchStreak += 1;
  else touchStreak = 1;
  lastTouchAt = now;
  lastTouchRegion = region;

  const label = zone && zone.name ? zone.name : (INTERACTION_REGION_LABELS[region] || region);
  const pool = TOUCH_ACTIONS[region] || TOUCH_ACTIONS.body;
  let action = pickTouch(pool);
  if (action === lastTouchAction) action = pickTouch(pool, action);
  lastTouchAction = action;
  if (zone && String(zone.name || '').trim()) action = '碰了碰你的' + String(zone.name).trim().slice(0, 20);

  const streakText = touchStreak > 1 ? '对方已经连续碰了你 ' + touchStreak + ' 次。' : '';
  const timeWord = touchTimeWord();
  const tone = pickTouch(TOUCH_TONES);
  const mood = pickTouch(TOUCH_MOODS);
  const len = pickTouch(TOUCH_LENGTHS);
  const allowQuestion = Math.random() < 0.25;
  const openingRule = pickTouch(TOUCH_OPENINGS);
  const avoidRepeat = recentReplyLines.length
    ? '你最近说过「' + recentReplyLines.slice(-2).map((x) => x.slice(0, 40)).join('」「') + '」，这次不要重复它们的开头和句式。'
    : '';

  const templates = [
    '（' + timeWord + '，' + action + '。' + streakText + '请用你的人设，给出一个' + tone + '的反应，' + len + '字；' + avoidRepeat + openingRule + '；可以带一点小动作或心理活动，不要解释。）',
    '（' + action + '。' + streakText + '用你的人设回一句话，' + len + '字，' + tone + '；' + avoidRepeat + openingRule + '；不要提问太多。）',
    '（' + timeWord + '，' + action + '。' + streakText + '你现在' + mood + '，用你的人设自然回应，' + len + '字；' + avoidRepeat + openingRule + '；' + (allowQuestion ? '可以轻轻反问一句，但别审问' : '不要提问') + '，不要说教。）',
    '（' + action + '。' + streakText + '请用你的人设回应，' + len + '字，' + tone + '；' + avoidRepeat + openingRule + '；重点写你被碰到时的第一反应，不要复述对方的话，不要每次都顺从。）',
  ];
  const prompt = pickTouch(templates);
  try { surf.chat(prompt).catch(() => {}); } catch (_) {}
}

// ---------------------------------------------------------------------------
// start at login
// ---------------------------------------------------------------------------
function autoStartTarget() {
  const portable = String(process.env.PORTABLE_EXECUTABLE_FILE || '').trim();
  return portable || process.execPath;
}
function applyAutoStart() {
  if (!app.isPackaged) return; // never touch the dev electron.exe login item
  try {
    app.setLoginItemSettings({
      openAtLogin: config.autoStart === true,
      path: autoStartTarget(),
      args: [],
    });
  } catch (e) {
    console.error('[autostart] failed', e);
  }
}
function setAutoStart(on) {
  config.autoStart = !!on;
  saveConfig();
  applyAutoStart();
  broadcastState();
}

// ---------------------------------------------------------------------------
// QQ link daemon: start it only after a model is loaded, and keep it resident.
// The daemon is intentionally NOT in Windows startup anymore; the pet process
// starts it once after pet:ready, and it stays alive when the pet is closed.
//
// 路径不再写死：先看 config.qqLinkPaths / 环境变量，再按常见安装位置探测，
// 都找不到就静默跳过 —— 外部联动是可选功能，缺了不影响桌宠本身。
// ---------------------------------------------------------------------------
let qqDaemonStarted = false;

function sanitizeQqLinkPaths(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const out = {};
  for (const key of ['script', 'node', 'pidFile']) {
    out[key] = typeof src[key] === 'string' ? src[key].trim() : '';
  }
  return out;
}

function qqLinkSetting(key) {
  const paths = config.qqLinkPaths || {};
  return typeof paths[key] === 'string' ? paths[key].trim() : '';
}

function unquotePath(value) {
  return String(value || '').replace(/^"+|"+$/g, '').trim();
}

function firstExistingPath(candidates) {
  for (const item of candidates) {
    const p = unquotePath(item);
    if (!p) continue; // 空值 / 非字符串都跳过，避免脏配置炸掉启动流程
    try { if (fs.existsSync(p)) return p; } catch (_) {}
  }
  return '';
}

function qqDaemonScriptPath() {
  const candidates = [process.env.L2D_QQ_LINK_DAEMON, qqLinkSetting('script')];
  const dirs = [];
  try { dirs.push(path.dirname(app.getPath('exe'))); } catch (_) {}
  try { dirs.push(path.join(path.dirname(app.getPath('exe')), 'qq-link')); } catch (_) {}
  try { dirs.push(app.getPath('userData')); } catch (_) {}
  try { dirs.push(path.join(app.getPath('userData'), 'qq-link')); } catch (_) {}
  for (const dir of dirs) {
    if (!dir) continue;
    candidates.push(path.join(dir, 'qq-link-daemon.mjs'));
  }
  return firstExistingPath(candidates);
}

function qqDaemonPidPath(script) {
  const custom = qqLinkSetting('pidFile');
  return custom || path.join(path.dirname(script), 'daemon.pid');
}

function nodeExecutable() {
  const exeName = process.platform === 'win32' ? 'node.exe' : 'node';
  const candidates = [process.env.L2D_NODE_EXE, qqLinkSetting('node')];
  const pathVar = process.env.PATH || process.env.Path || '';
  for (const dir of pathVar.split(path.delimiter)) {
    if (!dir) continue;
    candidates.push(path.join(unquotePath(dir), exeName));
  }
  const roots = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA];
  for (const root of roots) {
    if (!root) continue;
    candidates.push(path.join(root, 'nodejs', exeName));
    candidates.push(path.join(root, 'Programs', 'nodejs', exeName));
  }
  return firstExistingPath(candidates);
}

function qqDaemonAlive(pidFile) {
  try {
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    if (!pid) return false;
    process.kill(pid, 0);
    return true;
  } catch (_) {
    return false;
  }
}

function ensureQqLinkDaemon() {
  if (qqDaemonStarted) return;
  qqDaemonStarted = true;
  try {
    const script = qqDaemonScriptPath();
    if (!script) {
      console.log('[qq-link] daemon script not found, skipped');
      return;
    }
    const pidFile = qqDaemonPidPath(script);
    if (qqDaemonAlive(pidFile)) {
      console.log('[qq-link] daemon already running');
      return;
    }
    const node = nodeExecutable();
    if (!node) {
      console.log('[qq-link] node not found, skipped');
      return;
    }
    const child = spawn(node, [script], {
      cwd: path.dirname(script),
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
    console.log('[qq-link] daemon started after model ready');
  } catch (e) {
    console.error('[qq-link] daemon start failed', e);
  }
}

// ---------------------------------------------------------------------------
// model registry
// ---------------------------------------------------------------------------
const scans = new Map(); // model id -> scan result (from model-scan)
let lastModelStats = null;

function modelIdForDir(dir) {
  return 'm' + crypto.createHash('sha1').update(String(dir).toLowerCase()).digest('hex').slice(0, 12);
}
function modelEntries() {
  return Array.isArray(config.models) ? config.models : [];
}
function currentEntry() {
  return modelEntries().find((m) => m.id === config.currentModelId) || null;
}
function currentScan() {
  const entry = currentEntry();
  if (!entry) return null;
  return scans.get(entry.id) || null;
}
function currentModelOptions() {
  const entry = currentEntry();
  if (!entry) return { flipX: false, fitScale: 1, offsetY: 0 };
  return {
    flipX: entry.flipX === true,
    fitScale: Number(entry.fitScale) || 1,
    offsetY: Number(entry.offsetY) || 0,
  };
}
const VIRTUAL_MANIFEST_FILE = '__pet_manifest.model3.json';
function modelUrlFor(entry, scan) {
  if (!entry || !scan || !scan.ok) return '';
  // When the manifest was generated/patched, serve it from the model root so
  // its references (relative to the root) resolve correctly.
  const rel = scan.virtual ? VIRTUAL_MANIFEST_FILE : scan.modelFile;
  const encoded = rel.split('/').map((p) => encodeURIComponent(p)).join('/');
  return 'pet://model/' + encodeURIComponent(entry.id) + '/' + encoded;
}
function summarizeModels() {
  return modelEntries().map((entry) => {
    const scan = scans.get(entry.id);
    const ok = !!(scan && scan.ok);
    return {
      id: entry.id,
      name: entry.name || entry.id,
      dir: entry.dir,
      modelFile: entry.modelFile || (scan && scan.modelFile) || '',
      current: entry.id === config.currentModelId,
      flipX: entry.flipX === true,
      fitScale: Number(entry.fitScale) || 1,
      offsetY: Number(entry.offsetY) || 0,
      error: ok ? null : (scan && scan.error) || '未扫描',
      warnings: ok ? scan.warnings || [] : [],
      info: ok ? (() => {
        const counts = (scan.info && scan.info.counts) || {};
        return {
          paramCount: entry.id === config.currentModelId && lastModelStats ? lastModelStats.paramCount : null,
          groupCount: entry.id === config.currentModelId && lastModelStats ? lastModelStats.groupCount : null,
          textureCount: counts.textures || 0,
          expressionCount: counts.expressions || 0,
          motionCount: counts.motions || 0,
          mocFile: scan.info && scan.info.moc ? scan.info.moc.file : '',
          modelFile: scan.modelFile,
          source: scan.source || 'model3',
          virtual: !!scan.virtual,
        };
      })() : null,
    };
  });
}
function currentModelUrl() {
  const entry = currentEntry();
  return entry ? modelUrlFor(entry, scans.get(entry.id)) : '';
}
function scanEntryModel(entry) {
  if (!modelScanner) {
    scans.set(entry.id, { ok: false, dir: entry.dir, error: '模型扫描模块缺失' });
    return;
  }
  let scan;
  try {
    scan = modelScanner.scanModelDir(entry.dir);
  } catch (e) {
    scan = { ok: false, dir: entry.dir, error: e.message };
  }
  scans.set(entry.id, scan);
  if (scan && scan.ok) {
    entry.modelFile = scan.modelFile;
    entry.virtual = !!scan.virtual;
    entry.name = entry.name || path.basename(entry.dir);
  }
}
function rescanAllEntries() {
  const list = modelEntries();
  for (const entry of list) {
    if (!entry.dir || !fs.existsSync(entry.dir)) {
      scans.set(entry.id, { ok: false, dir: entry.dir, error: '模型文件夹不存在' });
      continue;
    }
    scanEntryModel(entry);
  }
  // pick a usable current model
  const current = currentEntry();
  const currentOk = current && scans.get(current.id) && scans.get(current.id).ok;
  if (!currentOk) {
    const fallback = list.find((m) => {
      const s = scans.get(m.id);
      return s && s.ok;
    });
    config.currentModelId = fallback ? fallback.id : null;
  }
}
function addModelFromScan(scan, options) {
  if (!scan || !scan.ok) return null;
  const id = modelIdForDir(scan.dir);
  let entry = modelEntries().find((m) => m.id === id);
  if (!entry) {
    entry = { id, name: path.basename(scan.dir), dir: scan.dir, modelFile: scan.modelFile, virtual: !!scan.virtual };
    config.models.push(entry);
  }
  entry.dir = scan.dir;
  entry.modelFile = scan.modelFile;
  entry.virtual = !!scan.virtual;
  entry.name = entry.name || path.basename(scan.dir);
  if (typeof entry.flipX !== 'boolean') entry.flipX = false;
  if (!Number.isFinite(Number(entry.fitScale))) entry.fitScale = 1;
  if (!Number.isFinite(Number(entry.offsetY))) entry.offsetY = 0;
  scans.set(id, scan);
  if (!options || options.makeCurrent !== false) config.currentModelId = id;
  if (options && options.clearOverrides) config.overrides = {};
  saveConfig();
  return entry;
}
function autoImportDevModels() {
  if (app.isPackaged) return;
  const dir = path.join(APP_ROOT, 'models');
  if (!fs.existsSync(dir)) return;
  try {
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!item.isDirectory()) continue;
      const full = path.join(dir, item.name);
      const scan = modelScanner ? modelScanner.scanModelDir(full) : null;
      if (scan && scan.ok) addModelFromScan(scan, { makeCurrent: false });
    }
  } catch (e) {
    console.error('[model] dev auto import failed', e);
  }
}

// ---------------------------------------------------------------------------
// custom protocol: pet://model/<name>/<file>, pet://core/<file>, pet://app/<file>
// ---------------------------------------------------------------------------
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'pet',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
]);

function resolveStaticPetFile(urlString) {
  const u = new URL(urlString);
  let base;
  if (u.hostname === 'core') base = CORE_ROOT;
  else if (u.hostname === 'app') base = __dirname;
  else return null;
  const rel = decodeURIComponent(u.pathname).replace(/^\/+/, '');
  const file = path.join(base, rel);
  if (!file.startsWith(base)) return null;
  return file;
}

async function handlePetRequest(request) {
  const u = new URL(request.url);
  try {
    if (u.hostname === 'core' || u.hostname === 'app') {
      const file = resolveStaticPetFile(request.url);
      if (!file) return new Response('not found', { status: 404 });
      return await net.fetch(pathToFileURL(file).toString());
    }
    if (u.hostname !== 'model') return new Response('not found', { status: 404 });
    const segments = u.pathname.split('/').filter(Boolean).map((s) => decodeURIComponent(s));
    const id = segments.shift();
    const rel = segments.join('/');
    const entry = modelEntries().find((m) => m.id === id);
    const scan = entry ? scans.get(entry.id) : null;
    if (!entry || !scan || !scan.ok) return new Response('model not loaded', { status: 404 });
    if ((rel === scan.modelFile || rel === VIRTUAL_MANIFEST_FILE) && scan.manifest) {
      return new Response(JSON.stringify(scan.manifest), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      });
    }
    const base = path.resolve(entry.dir);
    const file = path.resolve(base, rel);
    if (file !== base && !file.startsWith(base + path.sep)) return new Response('forbidden', { status: 403 });
    if (!fs.existsSync(file)) return new Response('not found', { status: 404 });
    // Live2D expression files from many models have no FadeIn/FadeOut, so the
    // first expression change snaps (looks like a twitch). Inject a short fade
    // so touch-triggered expressions blend smoothly.
    if (/\.exp3\.json$/i.test(file)) {
      try {
        const raw = fs.readFileSync(file, 'utf8');
        const j = JSON.parse(raw);
        if (!(Number(j.FadeInTime) > 0)) j.FadeInTime = 0.35;
        if (!(Number(j.FadeOutTime) > 0)) j.FadeOutTime = 0.35;
        return new Response(JSON.stringify(j), {
          status: 200,
          headers: { 'content-type': 'application/json; charset=utf-8' },
        });
      } catch (_) {}
    }
    return await net.fetch(pathToFileURL(file).toString());
  } catch (e) {
    return new Response('error: ' + e.message, { status: 500 });
  }
}

// ---------------------------------------------------------------------------
// window state broadcast
// ---------------------------------------------------------------------------
function publicState() {
  return {
    pinned: config.pinned,
    followMouse: config.followMouse,
    strength: config.strength,
    opacity: config.opacity,
    alwaysOnTop: config.alwaysOnTop,
    width: config.width,
    height: config.height,
    overrides: config.overrides,
    panelOpen: !!panelWin,
    armSway: config.armSway,
    memoryPoints: config.memoryPoints,
    bubbleEnabled: config.bubbleEnabled !== false,
    bubbleOffset: config.bubbleOffset,
    dragOnTransparent: config.dragOnTransparent !== false,
    dblclickLower: config.dblclickLower !== false,
    lowered: petLowered,
    bubbleAdjusting,
    autoStart: config.autoStart === true,
    locked: config.locked === true,
    surf: surf ? surf.publicState() : { enabled: config.surf.enabled !== false, autoTalk: config.surf.autoTalk !== false, intervalMin: config.surf.intervalMin || 30, connected: false, roleName: '', apiRunning: false, apiUrl: '', lastError: 'SurfCore 未初始化' },
    models: summarizeModels(),
    currentModelId: config.currentModelId,
    modelOptions: currentModelOptions(),
    currentModelStats: lastModelStats,
    modelInfo,
  };
}
function broadcastState() {
  const s = publicState();
  if (petWin && !petWin.isDestroyed()) petWin.webContents.send('state', s);
  if (panelWin && !panelWin.isDestroyed()) panelWin.webContents.send('state', s);
}

// ---------------------------------------------------------------------------
// pet window helpers
// ---------------------------------------------------------------------------
function clampRect(x, y, w, h) {
  const display = screen.getDisplayNearestPoint({ x: x + Math.round(w / 2), y: y + Math.round(h / 2) });
  const wa = display.workArea;
  let nx = x;
  let ny = y;
  if (w <= wa.width) nx = Math.min(Math.max(x, wa.x), wa.x + wa.width - w);
  else nx = Math.max(x, wa.x);
  if (h <= wa.height) ny = Math.min(Math.max(y, wa.y), wa.y + wa.height - h);
  else ny = Math.max(y, wa.y);
  return { x: Math.round(nx), y: Math.round(ny), width: Math.round(w), height: Math.round(h) };
}

function fitSizeToScreen(w, h) {
  const wa = screen.getPrimaryDisplay().workArea;
  return {
    width: Math.max(280, Math.min(1800, Math.round(Math.min(w, wa.width - 8)))),
    height: Math.max(360, Math.min(2400, Math.round(Math.min(h, wa.height - 8)))),
  };
}

function defaultPosition(w, h) {
  const wa = screen.getPrimaryDisplay().workArea;
  return { x: wa.x + wa.width - w - 48, y: wa.y + wa.height - h - 24 };
}

function applyWindowOptions() {
  if (!petWin || petWin.isDestroyed()) return;
  petWin.setOpacity(Math.max(0.2, Math.min(1, config.opacity)));
  if (config.alwaysOnTop !== false && !petLowered) {
    petWin.setAlwaysOnTop(true, 'screen-saver', 1);
  } else {
    petWin.setAlwaysOnTop(false);
  }
  if (config.pinned) {
    petWin.setIgnoreMouseEvents(true, { forward: true });
    petWin.setFocusable(false);
  } else {
    petWin.setIgnoreMouseEvents(false);
    petWin.setFocusable(true);
  }
}

function setPinned(pinned) {
  config.pinned = !!pinned;
  if (config.pinned) config.locked = false;
  applyWindowOptions();
  saveConfig();
  broadcastState();
  if (petWin && !petWin.isDestroyed()) {
    petWin.webContents.send('option', { key: 'pinned', value: config.pinned });
    petWin.webContents.send('option', { key: 'locked', value: config.locked === true });
  }
  updateTrayMenu();
}

function setLocked(locked) {
  config.locked = !!locked;
  if (config.locked) config.pinned = false;
  applyWindowOptions();
  saveConfig();
  broadcastState();
  if (petWin && !petWin.isDestroyed()) {
    petWin.webContents.send('option', { key: 'locked', value: config.locked === true });
    petWin.webContents.send('option', { key: 'pinned', value: config.pinned === true });
  }
  updateTrayMenu();
}

function setFollowMouse(on) {
  config.followMouse = !!on;
  saveConfig();
  broadcastState();
  if (petWin && !petWin.isDestroyed()) petWin.webContents.send('option', { key: 'followMouse', value: config.followMouse });
  updateTrayMenu();
}

function setArmSway(on) {
  config.armSway = !!on;
  saveConfig();
  broadcastState();
  if (petWin && !petWin.isDestroyed()) petWin.webContents.send('option', { key: 'armSway', value: config.armSway });
  updateTrayMenu();
}
function resizeWindow(w, h) {
  if (!petWin || petWin.isDestroyed()) return;
  const size = fitSizeToScreen(w, h);
  const b = petWin.getBounds();
  // Anchor the pet's bottom centre: growing/shrinking keeps the character in
  // the same place on screen instead of drifting out of view.
  const nx = b.x + (b.width - size.width) / 2;
  const ny = b.y + (b.height - size.height);
  const rect = clampRect(nx, ny, size.width, size.height);
  petWin.setBounds(rect);
  config.width = rect.width;
  config.height = rect.height;
  config.x = rect.x;
  config.y = rect.y;
  saveConfig();
  broadcastState();
}

function moveToBottomRight() {
  if (!petWin || petWin.isDestroyed()) return;
  const b = petWin.getBounds();
  const size = fitSizeToScreen(b.width, b.height);
  const p = defaultPosition(size.width, size.height);
  const rect = clampRect(p.x, p.y, size.width, size.height);
  petWin.setBounds(rect);
  config.x = rect.x;
  config.y = rect.y;
  config.width = rect.width;
  config.height = rect.height;
  saveConfig();
}

// ---------------------------------------------------------------------------
// topmost guard (another window maximizing can drop the pet out of the
// topmost z-order on Windows; re-assert it periodically and on focus loss)
// ---------------------------------------------------------------------------
let topmostTimer = null;

function reassertPetTopmost() {
  if (petLowered) return;
  if (!petWin || petWin.isDestroyed() || config.alwaysOnTop === false) return;
  try { petWin.setAlwaysOnTop(true, 'screen-saver', 1); } catch (_) {}
}

function startTopmostGuard() {
  if (topmostTimer) clearInterval(topmostTimer);
  topmostTimer = setInterval(reassertPetTopmost, 2500);
  if (!petWin || petWin.isDestroyed()) return;
  petWin.on('blur', () => setTimeout(reassertPetTopmost, 120));
  petWin.on('show', () => setTimeout(reassertPetTopmost, 80));
  petWin.on('restore', () => setTimeout(reassertPetTopmost, 80));
  try {
    screen.on('display-metrics-changed', () => setTimeout(reassertPetTopmost, 120));
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// panel window
// ---------------------------------------------------------------------------
function windowSnapshot() {
  if (!petWin || petWin.isDestroyed()) return null;
  const b = petWin.getBounds();
  return { x: b.x, y: b.y, width: b.width, height: b.height };
}

function saveMemoryPoint(index) {
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i > 2 || !petWin || petWin.isDestroyed()) return;
  if (!Array.isArray(config.memoryPoints)) config.memoryPoints = [null, null, null];
  config.memoryPoints[i] = windowSnapshot();
  saveConfig();
  broadcastState();
  updateTrayMenu();
}

function gotoMemoryPoint(index) {
  const i = Number(index);
  if (!Number.isInteger(i) || i < 0 || i > 2 || !petWin || petWin.isDestroyed()) return;
  const point = config.memoryPoints && config.memoryPoints[i];
  if (!point) return;
  const size = fitSizeToScreen(point.width || config.width, point.height || config.height);
  const rect = clampRect(point.x, point.y, size.width, size.height);
  petWin.setBounds(rect);
  config.x = rect.x;
  config.y = rect.y;
  config.width = rect.width;
  config.height = rect.height;
  saveConfig();
  broadcastState();
}
function hasUsableModel() {
  return !!(currentEntry() && scans.get(config.currentModelId) && scans.get(config.currentModelId).ok);
}

function backToIdle() {
  if (petWin && !petWin.isDestroyed()) petWin.webContents.send('motion:idle');
}

function selectPanelTab(tab) {
  if (!panelWin || panelWin.isDestroyed()) return;
  const js = `(() => { const b = document.querySelector('#tabs button[data-tab="${tab}"]'); if (b) b.click(); })()`;
  panelWin.webContents.executeJavaScript(js).catch(() => {});
}

function togglePanel(force) {
  if (panelWin && !panelWin.isDestroyed()) {
    if (force === true) {
      panelWin.show();
      panelWin.focus();
      return;
    }
    panelWin.close();
    return;
  }
  createPanel();
}

function createPanel() {
  panelWin = new BrowserWindow({
    width: 540,
    height: 860,
    minWidth: 420,
    minHeight: 520,
    frame: false,
    transparent: false,
    backgroundColor: '#15161c',
    show: false,
    resizable: true,
    maximizable: false,
    skipTaskbar: false,
    title: 'L2D Companion · 参数面板',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      additionalArguments: ['--panel-window'],
    },
  });
  panelWin.setAlwaysOnTop(true, 'screen-saver', 2);
  panelWin.loadFile(path.join(__dirname, 'panel.html'));
  panelWin.once('ready-to-show', () => {
    panelWin.show();
    panelWin.focus();
    panelWin.webContents.send('panel:init', { state: publicState(), modelInfo });
    if (!hasUsableModel()) setTimeout(() => selectPanelTab('models'), 600);
  });
  panelWin.on('closed', () => {
    panelWin = null;
    config.panelOpen = false;
    saveConfig();
    if (petWin && !petWin.isDestroyed()) petWin.webContents.send('panel:state', false);
    broadcastState();
  });
  config.panelOpen = true;
  saveConfig();
  if (petWin && !petWin.isDestroyed()) petWin.webContents.send('panel:state', true);
}

// ---------------------------------------------------------------------------
// chat bubble window
// ---------------------------------------------------------------------------
function ensureBubbleWindow() {
  if (bubbleWin && !bubbleWin.isDestroyed()) return bubbleWin;
  bubbleWin = new BrowserWindow({
    width: 360,
    height: 240,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    skipTaskbar: true,
    focusable: false,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#00000000',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      additionalArguments: ['--bubble-window'],
    },
  });
  bubbleWin.setAlwaysOnTop(true, 'screen-saver', 3);
  bubbleWin.setIgnoreMouseEvents(true, { forward: true });
  bubbleWin.loadFile(path.join(__dirname, 'bubble.html'));
  bubbleWin.on('move', onBubbleMoved);
  bubbleWin.on('closed', () => { bubbleWin = null; bubbleVisible = false; });
  bubbleWin.webContents.on('console-message', (_e, _l, msg) => console.log('[bubble]', msg));
  return bubbleWin;
}

function bubbleAnchor() {
  const b = petWin && !petWin.isDestroyed() ? petWin.getBounds() : { x: 0, y: 0, width: 420, height: 720 };
  const m = petMetrics || { top: 10, bottom: b.height, left: 0, right: b.width, centerX: b.width / 2 };
  const off = config.bubbleOffset || DEFAULT_BUBBLE_OFFSET;
  return { ax: b.x + m.centerX + off.x, ay: b.y + m.top + off.y, b, m };
}

function clampNum(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function positionBubble() {
  if (!bubbleWin || bubbleWin.isDestroyed()) return;
  const { ax, ay, b, m } = bubbleAnchor();
  const w = Math.max(80, Math.round(bubbleSize.width));
  const h = Math.max(36, Math.round(bubbleSize.height));
  const display = screen.getDisplayMatching(b);
  const wa = display.workArea;
  const gap = 8;
  const fits = (r) => r.x >= wa.x + 2 && r.y >= wa.y + 2 && r.x + w <= wa.x + wa.width - 2 && r.y + h <= wa.y + wa.height - 2;
  let rect = { x: Math.round(ax - w / 2), y: Math.round(ay - gap - h), tail: 'bottom' };
  if (bubbleAdjusting) {
    rect = { x: Math.round(ax - w / 2), y: Math.round(ay - gap - h), tail: 'bottom' };
  } else if (!fits(rect)) {
    const right = { x: Math.round(b.x + (m.right != null ? m.right : b.width) + gap), y: Math.round(ay - h / 2), tail: 'left' };
    const left = { x: Math.round(b.x + (m.left != null ? m.left : 0) - gap - w), y: Math.round(ay - h / 2), tail: 'right' };
    if (fits(right)) rect = right;
    else if (fits(left)) rect = left;
    else {
      rect = {
        x: Math.round(clampNum(ax - w / 2, wa.x + 2, wa.x + wa.width - w - 2)),
        y: Math.round(Math.max(wa.y + 2, ay - gap - h)),
        tail: 'bottom',
      };
    }
  }
  bubbleMoveGuard = Date.now() + 200;
  bubbleWin.setBounds({ x: rect.x, y: rect.y, width: w, height: h });
  bubbleWin.webContents.send('bubble:tail', { tail: rect.tail });
  bubbleVisible = true;
}

function scheduleBubbleHide(ms) {
  if (bubbleHideTimer) clearTimeout(bubbleHideTimer);
  if (bubbleAdjusting) return;
  bubbleHideTimer = setTimeout(() => {
    if (!bubbleAdjusting) hideBubble();
  }, ms || 4600);
}

function hideBubble() {
  if (bubbleHideTimer) { clearTimeout(bubbleHideTimer); bubbleHideTimer = null; }
  bubbleVisible = false;
  bubbleWanted = false;
  bubblePendingShow = false;
  if (bubbleWin && !bubbleWin.isDestroyed()) {
    bubbleWin.webContents.send('bubble:hide');
    bubbleWin.hide();
    bubbleWin.setIgnoreMouseEvents(true, { forward: true });
    bubbleWin.setFocusable(false);
  }
}

function showBubble(text, options) {
  if (!(options && options.keepTouchFallback)) clearTouchFallback();
  if (config.bubbleEnabled === false || !text) return;
  bubblePendingDuration = (options && Number(options.durationMs)) || Math.max(4200, Math.min(14000, 4200 + String(text).length * 75));
  const win = ensureBubbleWindow();
  bubblePendingShow = true;
  bubbleWanted = true;
  // Give the page a large enough canvas to measure the wrapped text first.
  bubbleMoveGuard = Date.now() + 200;
  win.setBounds({ x: win.getBounds().x, y: win.getBounds().y, width: 360, height: 240 });
  win.showInactive();
  win.setIgnoreMouseEvents(false);
  win.setFocusable(true);
  win.webContents.send('bubble:show', { text, adjustable: !!(options && options.adjustable) });
}

function setBubbleEnabled(on) {
  config.bubbleEnabled = !!on;
  if (!config.bubbleEnabled) hideBubble();
  saveConfig();
  broadcastState();
  updateTrayMenu();
}

function setBubbleAdjusting(on) {
  bubbleAdjusting = !!on;
  if (bubbleAdjusting) {
    const win = ensureBubbleWindow();
    if (bubbleHideTimer) { clearTimeout(bubbleHideTimer); bubbleHideTimer = null; }
    win.setIgnoreMouseEvents(false);
    win.setFocusable(true);
    bubbleMoveGuard = Date.now() + 200;
    win.setBounds({ x: win.getBounds().x, y: win.getBounds().y, width: 360, height: 240 });
    win.showInactive();
    bubblePendingShow = true;
    bubbleWanted = true;
    win.webContents.send('bubble:show', { text: '拖动气泡，放到你喜欢的头顶位置', adjustable: true });
  } else {
    if (bubbleWin && !bubbleWin.isDestroyed()) {
      bubbleWin.setIgnoreMouseEvents(true, { forward: true });
      bubbleWin.setFocusable(false);
      bubbleWin.webContents.send('bubble:adjust', { adjusting: false });
    }
    setTimeout(() => { if (!bubbleAdjusting) hideBubble(); }, 500);
  }
  broadcastState();
}

function resetBubbleOffset() {
  config.bubbleOffset = { ...DEFAULT_BUBBLE_OFFSET };
  saveConfig();
  if (bubbleVisible) positionBubble();
  broadcastState();
}

function onBubbleMoved() {
  if (!bubbleAdjusting || !bubbleWin || bubbleWin.isDestroyed() || !petWin || petWin.isDestroyed()) return;
  if (Date.now() < bubbleMoveGuard) return;
  const rect = bubbleWin.getBounds();
  const b = petWin.getBounds();
  const m = petMetrics || { top: 10, centerX: b.width / 2 };
  const gap = 8;
  const anchorX = rect.x + rect.width / 2;
  const anchorY = rect.y + rect.height + gap;
  config.bubbleOffset = {
    x: Math.round(anchorX - (b.x + m.centerX)),
    y: Math.round(anchorY - (b.y + m.top)),
  };
  saveConfig();
  broadcastState();
}

function repositionBubbleIfVisible() {
  if (bubbleVisible && bubbleWin && !bubbleWin.isDestroyed() && !bubbleAdjusting) positionBubble();
}

// ---------------------------------------------------------------------------
// chat window (opened by double-clicking the speech bubble)
// ---------------------------------------------------------------------------
function ensureChatWindow() {
  if (chatWin && !chatWin.isDestroyed()) return chatWin;
  chatWin = new BrowserWindow({
    width: 344,
    height: 470,
    minWidth: 300,
    minHeight: 360,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: true,
    maximizable: false,
    minimizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#00000000',
    title: 'L2D Companion · 聊天',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      additionalArguments: ['--chat-window'],
    },
  });
  chatWin.setAlwaysOnTop(true, 'screen-saver', 3);
  chatWin.loadFile(path.join(__dirname, 'chat.html'));
  chatWin.on('closed', () => { chatWin = null; });
  return chatWin;
}

function positionChatWindow(anchor) {
  const win = chatWin;
  if (!win || win.isDestroyed()) return;
  const petBounds = petWin && !petWin.isDestroyed() ? petWin.getBounds() : { x: 0, y: 0, width: 480, height: 820 };
  const base = anchor || (bubbleVisible && bubbleWin && !bubbleWin.isDestroyed() ? bubbleWin.getBounds() : null) || petBounds;
  const display = screen.getDisplayMatching(base);
  const wa = display.workArea;
  const w = win.getBounds().width || 344;
  const h = win.getBounds().height || 470;
  let x = base.x + base.width + 10;
  let y = base.y;
  if (x + w > wa.x + wa.width - 4) x = base.x - w - 10;
  if (x < wa.x + 4) x = wa.x + 4;
  if (x + w > wa.x + wa.width - 4) x = wa.x + wa.width - w - 4;
  if (y < wa.y + 4) y = wa.y + 4;
  if (y + h > wa.y + wa.height - 4) y = wa.y + wa.height - h - 4;
  if (y < wa.y + 4) y = wa.y + 4;
  win.setBounds({ x: Math.round(x), y: Math.round(y), width: w, height: h });
}

async function chatInitPayload() {
  let roleName = '';
  let history = [];
  try {
    if (surf) {
      roleName = surf.publicState().roleName || '';
      if (typeof surf.history === 'function') {
        const h = await surf.history(40);
        if (h && h.ok) {
          history = (h.messages || []).filter((m) => !/^（(桌宠待机中|有人碰了你的|桌宠测试)/.test(String(m.text || '')));
        }
      }
    }
  } catch (_) {}
  return { roleName, history };
}

async function openChatWindow() {
  const win = ensureChatWindow();
  const anchor = bubbleVisible && bubbleWin && !bubbleWin.isDestroyed() ? bubbleWin.getBounds() : null;
  positionChatWindow(anchor);
  hideBubble();
  win.show();
  win.focus();
  const send = async () => {
    try {
      const payload = await chatInitPayload();
      if (win && !win.isDestroyed()) win.webContents.send('chat:init', payload);
    } catch (_) {}
  };
  if (win.webContents.isLoading()) win.webContents.once('did-finish-load', send);
  else send();
}

function qqSyncTarget() {
  const candidates = [
    process.env.L2D_SURFCORE_CONFIG,
    config.surfcoreConfig,
    path.join(app.getPath('home'), '.dsh', 'surfcore', 'config.json'),
  ];
  for (const file of candidates) {
    const target = unquotePath(file);
    if (!target) continue;
    try {
      const j = JSON.parse(fs.readFileSync(target, 'utf8'));
      const snow = j && j.snowluma ? j.snowluma : {};
      const owner = Number(j && j.ownerQQ);
      if (snow.accessToken && Number.isFinite(owner) && owner > 0) {
        return {
          url: String(snow.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, ''),
          token: String(snow.accessToken),
          owner,
        };
      }
    } catch (_) {}
  }
  return null;
}

async function sendOwnerQQ(text) {
  const target = qqSyncTarget();
  if (!target) return { ok: false, error: '没有找到 SurfCore 的 SnowLuma 配置' };
  try {
    const res = await fetch(target.url + '/send_private_msg', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + target.token,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        user_id: target.owner,
        message: [{ type: 'text', data: { text: String(text || '').slice(0, 1200) } }],
      }),
    });
    const data = await res.json().catch(() => null);
    return { ok: res.ok && data && data.retcode === 0, status: res.status, data };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
}

// ---------------------------------------------------------------------------
// menus
// ---------------------------------------------------------------------------
function sizeSubmenu() {
  return [
    { label: '小（360 × 620）', click: () => resizeWindow(360, 620) },
    { label: '中（480 × 820）', click: () => resizeWindow(480, 820) },
    { label: '大（600 × 1030）', click: () => resizeWindow(600, 1030) },
    { label: '超大（760 × 1300）', click: () => resizeWindow(760, 1300) },
  ];
}

function memorySubmenu() {
  const points = Array.isArray(config.memoryPoints) ? config.memoryPoints : [null, null, null];
  const items = [0, 1, 2].map((i) => ({
    label: `保存当前位置到记忆点 ${i + 1}`,
    click: () => saveMemoryPoint(i),
  }));
  items.push({ type: 'separator' });
  for (const i of [0, 1, 2]) {
    const p = points[i];
    items.push({
      label: p ? `跳到记忆点 ${i + 1}（${p.width}×${p.height}）` : `记忆点 ${i + 1}（未保存）`,
      enabled: !!p,
      click: () => gotoMemoryPoint(i),
    });
  }
  return items;
}
function buildContextMenu() {
  return Menu.buildFromTemplate([
    { label: '参数面板', accelerator: 'CmdOrCtrl+Alt+M', click: () => togglePanel(true) },
    { label: '回到待机', accelerator: 'CmdOrCtrl+Alt+I', click: () => backToIdle() },
    { label: '让她说一句（SurfCore）', click: () => { if (surf) surf.testSay().catch(() => {}); } },
    { label: 'QQ 联动（来桌面陪我 / 去休息）', type: 'checkbox', checked: config.qqLink !== false, click: (item) => setQqLink(item.checked) },
    { label: '导入模型…', click: () => importModelFolder().catch((e) => console.error(e)) },
    { type: 'separator' },
    { label: '固定模型（锁定位置 + 鼠标穿透）', type: 'checkbox', checked: config.pinned, click: (item) => setPinned(item.checked) },
    { label: '固定位置（鼠标不穿透，可交互）', type: 'checkbox', checked: config.locked === true, click: (item) => setLocked(item.checked) },
    { label: '跟随鼠标', type: 'checkbox', checked: config.followMouse, click: (item) => setFollowMouse(item.checked) },
    { label: '手臂轻摆', type: 'checkbox', checked: config.armSway !== false, click: (item) => setArmSway(item.checked) },
    { label: '聊天气泡', type: 'checkbox', checked: config.bubbleEnabled !== false, click: (item) => setBubbleEnabled(item.checked) },
    {
      label: '始终置顶',
      type: 'checkbox',
      checked: config.alwaysOnTop,
      click: (item) => {
        config.alwaysOnTop = item.checked;
        applyWindowOptions();
        saveConfig();
        broadcastState();
        updateTrayMenu();
      },
    },
    { type: 'separator' },
    { label: '大小', submenu: sizeSubmenu() },
    { label: '位置记忆点', submenu: memorySubmenu() },
    { label: '回到屏幕右下角', click: moveToBottomRight },
    { type: 'separator' },
    { label: '隐藏桌宠（Ctrl+Alt+H）', click: () => hidePet() },
    { label: '把桌宠提到最上层（Ctrl+Alt+T）', click: () => bringPetToTop() },
    { label: '退出', click: () => quitApp() },
  ]);
}

function updateTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '显示 / 隐藏桌宠', click: () => togglePetVisible() },
    { label: '参数面板', click: () => togglePanel(true) },
    { label: '回到待机', accelerator: 'CmdOrCtrl+Alt+I', click: () => backToIdle() },
    { label: '让她说一句（SurfCore）', click: () => { if (surf) surf.testSay().catch(() => {}); } },
    { label: 'QQ 联动（来桌面陪我 / 去休息）', type: 'checkbox', checked: config.qqLink !== false, click: (item) => setQqLink(item.checked) },
    { label: '导入模型…', click: () => importModelFolder().catch((e) => console.error(e)) },
    { type: 'separator' },
    { label: '固定模型（鼠标穿透）', type: 'checkbox', checked: config.pinned, click: (item) => setPinned(item.checked) },
    { label: '固定位置（鼠标不穿透，可交互）', type: 'checkbox', checked: config.locked === true, click: (item) => setLocked(item.checked) },
    { label: '跟随鼠标', type: 'checkbox', checked: config.followMouse, click: (item) => setFollowMouse(item.checked) },
    { label: '手臂轻摆', type: 'checkbox', checked: config.armSway !== false, click: (item) => setArmSway(item.checked) },
    { label: '聊天气泡', type: 'checkbox', checked: config.bubbleEnabled !== false, click: (item) => setBubbleEnabled(item.checked) },
    {
      label: '始终置顶',
      type: 'checkbox',
      checked: config.alwaysOnTop,
      click: (item) => {
        config.alwaysOnTop = item.checked;
        applyWindowOptions();
        saveConfig();
        broadcastState();
        updateTrayMenu();
      },
    },
    { type: 'separator' },
    { label: '大小', submenu: sizeSubmenu() },
    { label: '位置记忆点', submenu: memorySubmenu() },
    { label: '回到屏幕右下角', click: moveToBottomRight },
    { type: 'separator' },
    { label: '把桌宠提到最上层（Ctrl+Alt+T）', click: () => bringPetToTop() },
    { label: '退出', click: () => quitApp() },
  ]));
  tray.setToolTip('L2D Companion');
}

function hidePet() {
  hideBubble();
  if (petWin && !petWin.isDestroyed()) petWin.hide();
}
function showPet() {
  if (petWin && !petWin.isDestroyed()) petWin.show();
}
function togglePetVisible() {
  if (!petWin || petWin.isDestroyed()) return;
  if (petWin.isVisible()) hidePet(); else showPet();
}
function setQqLink(enabled) {
  config.qqLink = !!enabled;
  saveConfig();
  updateTrayMenu();
  try {
    showBubble(enabled ? 'QQ 联动已开启：说「来桌面陪我」我就来，说「去休息」我就下班' : 'QQ 联动已关闭', { durationMs: 3000 });
  } catch (_) {}
}
function quitApp() {
  quitting = true;
  try { if (surf) surf.stop(); } catch (_) {}
  app.quit();
}

function updateTrayTooltip() {
  if (!tray) return;
  let role = '';
  try { role = surf ? surf.publicState().roleName : ''; } catch (_) {}
  tray.setToolTip(role ? 'L2D Companion · ' + role : 'L2D Companion');
}

function createTray() {
  const iconCandidates = [
    path.join(__dirname, 'tray.png'),
    path.join(__dirname, 'icon.png'),
    path.join(RES_ROOT, 'build', 'icon.png'),
  ];
  let image = nativeImage.createEmpty();
  for (const p of iconCandidates) {
    if (fs.existsSync(p)) {
      image = nativeImage.createFromPath(p);
      if (!image.isEmpty()) break;
    }
  }
  try {
    tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image.resize({ width: 20, height: 20 }));
  } catch (e) {
    console.error('[tray] failed', e);
    return;
  }
  tray.setToolTip('L2D Companion');
  tray.on('click', () => togglePanel(true));
  updateTrayMenu();
}

// ---------------------------------------------------------------------------
// pet window creation
// ---------------------------------------------------------------------------
function loadPetPage() {
  if (!petWin || petWin.isDestroyed()) return;
  const entry = currentEntry();
  const scan = entry ? scans.get(entry.id) : null;
  const url = entry && scan && scan.ok ? modelUrlFor(entry, scan) : '';
  modelInfo = null;
  lastModelStats = null;
  petMetrics = null;
  hideBubble();
  petWin.loadFile(path.join(__dirname, 'pet.html'), {
    query: { modelUrl: url, modelId: entry ? entry.id : '' },
  });
  broadcastState();
}

function selectModel(id) {
  const entry = modelEntries().find((m) => m.id === id);
  if (!entry) return;
  const scan = scans.get(id);
  if (!scan || !scan.ok) {
    dialog.showErrorBox('无法使用这个模型', (scan && scan.error) || '模型不可用');
    return;
  }
  config.currentModelId = id;
  saveConfig();
  loadPetPage();
  broadcastState();
}

function removeModel(id) {
  const list = modelEntries();
  const index = list.findIndex((m) => m.id === id);
  if (index < 0) return;
  list.splice(index, 1);
  scans.delete(id);
  if (config.currentModelId === id) {
    const fallback = list.find((m) => {
      const s = scans.get(m.id);
      return s && s.ok;
    });
    config.currentModelId = fallback ? fallback.id : null;
  }
  saveConfig();
  loadPetPage();
  broadcastState();
}

async function importModelDir(dir) {
  if (!modelScanner) throw new Error('模型扫描模块缺失');
  let scan;
  try {
    scan = modelScanner.scanModelDir(dir);
  } catch (e) {
    scan = { ok: false, dir, error: e.message };
  }
  if (!scan || !scan.ok) {
    const res = await dialog.showMessageBox(panelWin && !panelWin.isDestroyed() ? panelWin : (petWin && !petWin.isDestroyed() ? petWin : null), {
      type: 'warning',
      title: '没有自动识别到模型',
      message: '这个文件夹里没有自动识别到可用的 Live2D 模型。',
      detail: (scan && scan.error) || '可以手动选择 model3.json 或 moc3 文件。',
      buttons: ['手动选择 model3.json', '手动选择 moc3', '取消'],
      defaultId: 0,
      cancelId: 2,
    });
    if (res.response === 0) await pickAndImportModelFile('model3');
    else if (res.response === 1) await pickAndImportModelFile('moc3');
    return;
  }
  addModelFromScan(scan, { makeCurrent: true, clearOverrides: true });
  loadPetPage();
  broadcastState();
}

async function importModelFolder() {
  const r = await dialog.showOpenDialog(panelWin && !panelWin.isDestroyed() ? panelWin : petWin, {
    title: '选择 Live2D 模型文件夹',
    properties: ['openDirectory'],
  });
  if (r.canceled || !r.filePaths[0]) return;
  await importModelDir(r.filePaths[0]);
}

async function importModelFile() {
  await pickAndImportModelFile('any');
}

async function pickAndImportModelFile(mode) {
  if (!modelScanner) {
    dialog.showErrorBox('导入失败', '模型扫描模块缺失');
    return;
  }
  const filters = mode === 'moc3'
    ? [{ name: 'moc3 模型', extensions: ['moc3'] }]
    : [{ name: 'Live2D 模型', extensions: ['model3.json', 'json', 'moc3'] }];
  const r = await dialog.showOpenDialog(panelWin && !panelWin.isDestroyed() ? panelWin : petWin, {
    title: mode === 'moc3' ? '选择 moc3 模型文件' : '选择模型文件（model3.json / moc3）',
    properties: ['openFile'],
    filters,
  });
  if (r.canceled || !r.filePaths[0]) return;
  let scan;
  try {
    scan = modelScanner.scanModelFile(r.filePaths[0]);
  } catch (e) {
    scan = { ok: false, error: e.message };
  }
  if (!scan || !scan.ok) {
    dialog.showErrorBox('导入失败', (scan && scan.error) || '无法识别这个文件');
    broadcastState();
    return;
  }
  addModelFromScan(scan, { makeCurrent: true, clearOverrides: true });
  loadPetPage();
  broadcastState();
}

async function rescanModels() {
  rescanAllEntries();
  saveConfig();
  if (currentEntry()) loadPetPage();
  broadcastState();
}

function openModelFolder(id) {
  const entry = modelEntries().find((m) => m.id === id);
  if (!entry) return;
  shell.openPath(entry.dir);
}

function setModelOption(key, value) {
  const entry = currentEntry();
  if (!entry) return;
  if (key === 'flipX') entry.flipX = !!value;
  else if (key === 'fitScale') {
    const oldScale = Number(entry.fitScale) || 1;
    const nextScale = Math.max(0.5, Math.min(1.8, Number(value) || 1));
    entry.fitScale = nextScale;
    // Window follows the model scale: keep the same relative padding, grow the
    // window with the art (bottom-center anchored so the feet stay put).
    if (Math.abs(nextScale - oldScale) > 0.001 && petWin && !petWin.isDestroyed()) {
      const b = petWin.getBounds();
      const ratio = nextScale / oldScale;
      const size = fitSizeToScreen(Math.round(b.width * ratio), Math.round(b.height * ratio));
      const nx = b.x + (b.width - size.width) / 2;
      const ny = b.y + (b.height - size.height);
      const rect = clampRect(nx, ny, size.width, size.height);
      petWin.setBounds(rect);
      config.width = rect.width;
      config.height = rect.height;
      config.x = rect.x;
      config.y = rect.y;
    }
  }
  else if (key === 'offsetY') entry.offsetY = Math.max(-0.4, Math.min(0.4, Number(value) || 0));
  else return;
  saveConfig();
  broadcastState();
  if (petWin && !petWin.isDestroyed()) {
    petWin.webContents.send('option', { key: 'modelOptions', value: currentModelOptions() });
  }
}

function createPetWindow() {
  const size = fitSizeToScreen(config.width || 420, config.height || 720);
  const w = size.width;
  const h = size.height;
  let x = config.x;
  let y = config.y;
  if (x == null || y == null) {
    const p = defaultPosition(w, h);
    x = p.x; y = p.y;
  }
  const b = clampRect(x, y, w, h);

  petWin = new BrowserWindow({
    x: b.x,
    y: b.y,
    width: b.width,
    height: b.height,
    transparent: true,
    frame: false,
    hasShadow: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#00000000',
    title: 'L2D Companion',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
      additionalArguments: ['--pet-window'],
    },
  });
  petWin.setMenu(null);
  petWin.setAlwaysOnTop(true, 'screen-saver', 1);

  loadPetPage();

  petWin.webContents.on('console-message', (_event, _level, message) => {
    console.log('[renderer]', message);
  });
  petWin.webContents.on('render-process-gone', (_event, details) => {
    console.error('[renderer] gone', JSON.stringify(details));
  });
  petWin.webContents.on('did-fail-load', (_event, code, desc) => {
    console.error('[renderer] did-fail-load', code, desc);
  });

  petWin.once('ready-to-show', () => {
    petWin.showInactive();
    applyWindowOptions();
  });

  petWin.on('move', () => {
    if (!petWin || petWin.isDestroyed()) return;
    const bb = petWin.getBounds();
    config.x = bb.x;
    config.y = bb.y;
    saveConfig();
    repositionBubbleIfVisible();
  });
  petWin.on('resize', () => {
    if (!petWin || petWin.isDestroyed()) return;
    const bb = petWin.getBounds();
    config.width = bb.width;
    config.height = bb.height;
    saveConfig();
    repositionBubbleIfVisible();
  });

  config.width = b.width;
  config.height = b.height;
  config.x = b.x;
  config.y = b.y;
  saveConfig();

  petWin.on('closed', () => {
    petWin = null;
    if (!quitting) app.quit();
  });
}

// ---------------------------------------------------------------------------
// drag / resize driven by the global cursor position
// ---------------------------------------------------------------------------
let dragSession = null;
let resizeSession = null;

ipcMain.on('win:drag-start', () => {
  if (!petWin || petWin.isDestroyed() || config.pinned || config.locked) return;
  dragSession = { cursor: screen.getCursorScreenPoint(), bounds: petWin.getBounds() };
  resizeSession = null;
});
ipcMain.on('win:drag-end', () => {
  if (!dragSession) return;
  dragSession = null;
  if (petWin && !petWin.isDestroyed()) {
    const bb = petWin.getBounds();
    config.x = bb.x;
    config.y = bb.y;
    saveConfig();
  }
});
ipcMain.on('win:resize-start', () => {
  if (!petWin || petWin.isDestroyed() || config.pinned || config.locked) return;
  resizeSession = { cursor: screen.getCursorScreenPoint(), bounds: petWin.getBounds() };
  dragSession = null;
});
ipcMain.on('win:resize-end', () => {
  if (!resizeSession) return;
  resizeSession = null;
  if (petWin && !petWin.isDestroyed()) {
    const bb = petWin.getBounds();
    config.width = bb.width;
    config.height = bb.height;
    saveConfig();
    broadcastState();
  }
});
ipcMain.on('win:resize-by', (_event, delta) => {
  if (!petWin || petWin.isDestroyed() || !delta) return;
  const b = petWin.getBounds();
  const size = fitSizeToScreen(
    b.width + (Number(delta.dw) || 0),
    b.height + (Number(delta.dh) || 0),
  );
  const nx = b.x + (b.width - size.width) / 2;
  const ny = b.y + (b.height - size.height);
  const rect = clampRect(nx, ny, size.width, size.height);
  petWin.setBounds(rect);
  config.width = rect.width;
  config.height = rect.height;
  config.x = rect.x;
  config.y = rect.y;
  saveConfig();
});

function processWindowSessions() {
  if (!petWin || petWin.isDestroyed()) return;
  const pt = screen.getCursorScreenPoint();
  if (dragSession) {
    const dx = pt.x - dragSession.cursor.x;
    const dy = pt.y - dragSession.cursor.y;
    petWin.setPosition(Math.round(dragSession.bounds.x + dx), Math.round(dragSession.bounds.y + dy));
  } else if (resizeSession) {
    const dx = pt.x - resizeSession.cursor.x;
    const dy = pt.y - resizeSession.cursor.y;
    const b = resizeSession.bounds;
    const wa = screen.getDisplayMatching(b).workArea;
    const maxW = Math.max(280, wa.x + wa.width - b.x);
    const maxH = Math.max(360, wa.y + wa.height - b.y);
    const w = Math.max(280, Math.min(1800, maxW, Math.round(b.width + dx)));
    const h = Math.max(360, Math.min(2400, maxH, Math.round(b.height + dy)));
    petWin.setBounds({ x: b.x, y: b.y, width: w, height: h });
  }
}

// ---------------------------------------------------------------------------
// cursor tracking (for global mouse follow even when window ignores mouse)
// ---------------------------------------------------------------------------
let cursorTimer = null;
function startCursorTracking() {
  if (cursorTimer) return;
  cursorTimer = setInterval(() => {
    if (!petWin || petWin.isDestroyed() || !petWin.isVisible()) return;
    const pt = screen.getCursorScreenPoint();
    processWindowSessions();
    const display = screen.getDisplayNearestPoint(pt);
    petWin.webContents.send('cursor', {
      x: pt.x,
      y: pt.y,
      workWidth: display.workArea.width,
      workHeight: display.workArea.height,
    });
  }, 33);
}

// ---------------------------------------------------------------------------
// IPC from pet renderer
// ---------------------------------------------------------------------------
ipcMain.on('pet:ready', (_event, info) => {
  modelInfo = info;
  ensureQqLinkDaemon();
  lastModelStats = info ? {
    paramCount: Array.isArray(info.params) ? info.params.length : 0,
    groupCount: Array.isArray(info.groups) ? info.groups.length : 0,
    expressionCount: Array.isArray(info.expressions) ? info.expressions.length : 0,
    motionCount: Array.isArray(info.motions) ? info.motions.length : 0,
  } : null;
  broadcastState();
  if (panelWin && !panelWin.isDestroyed()) panelWin.webContents.send('model-info', info);
  if (petWin && !petWin.isDestroyed()) {
    petWin.webContents.send('state', publicState());
    petWin.webContents.send('option', { key: 'modelOptions', value: currentModelOptions() });
  }
  if (isSmoke) scheduleSmokeCapture();
  if (isSmokeLook) scheduleLookTest();
  if (smokeImportDir) {
    setTimeout(async () => {
      try {
        const out = path.join(APP_ROOT, 'dist', 'smoke-imported.png');
        const image = await petWin.webContents.capturePage();
        fs.writeFileSync(out, image.toPNG());
        console.log('[smoke-import] captured ' + out + ' models=' + config.models.length + ' current=' + config.currentModelId);
      } catch (e) {
        console.error('[smoke-import] failed', e);
      }
      app.quit();
    }, 4000);
  }
});

ipcMain.on('pet:error', (_event, message) => {
  console.error('[pet:error]', message);
});

ipcMain.on('pet:values', (_event, values) => {
  if (panelWin && !panelWin.isDestroyed()) panelWin.webContents.send('values', values);
});

ipcMain.on('pet:ignore-mouse', (_event, ignore) => {
  if (!petWin || petWin.isDestroyed()) return;
  if (config.pinned) return;
  if (config.locked) { petWin.setIgnoreMouseEvents(false); return; }
  petWin.setIgnoreMouseEvents(!!ignore, { forward: true });
});

let coordPickUntil = 0;
let lastPetBubbleAt = 0;
let coordPickTimer = null;

ipcMain.handle('interaction:pick-start', () => {
  coordPickUntil = Date.now() + 30000;
  if (coordPickTimer) clearTimeout(coordPickTimer);
  coordPickTimer = setTimeout(() => {
    if (Date.now() < coordPickUntil) return;
    coordPickUntil = 0;
    if (panelWin && !panelWin.isDestroyed()) {
      try { panelWin.show(); panelWin.focus(); panelWin.webContents.send('interaction:capture-result', { cancelled: true }); } catch (_) {}
    }
  }, 30000);
  if (panelWin && !panelWin.isDestroyed()) { try { panelWin.hide(); } catch (_) {} }
  return { ok: true, expiresAt: coordPickUntil };
});
ipcMain.handle('interaction:pick-cancel', () => {
  coordPickUntil = 0;
  if (coordPickTimer) { clearTimeout(coordPickTimer); coordPickTimer = null; }
  if (panelWin && !panelWin.isDestroyed()) { try { panelWin.show(); panelWin.focus(); } catch (_) {} }
  return { ok: true };
});

function handlePetBubble(payload) {
  const nowTouch = Date.now();
  if (nowTouch - lastPetBubbleAt < 120) return;
  lastPetBubbleAt = nowTouch;
  if (coordPickUntil && Date.now() <= coordPickUntil) {
    coordPickUntil = 0;
    if (coordPickTimer) { clearTimeout(coordPickTimer); coordPickTimer = null; }
    if (petWin && !petWin.isDestroyed()) {
      const b = petWin.getBounds();
      const x = Math.max(0, Math.min(100, Number(payload.x) / b.width * 100));
      const y = Math.max(0, Math.min(100, Number(payload.y) / b.height * 100));
      if (panelWin && !panelWin.isDestroyed()) {
        try { panelWin.show(); panelWin.focus(); panelWin.webContents.send('interaction:capture-result', { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 }); } catch (_) {}
      }
    }
    return;
  }
  if (!payload) return;
  const region = INTERACTION_REGIONS.includes(payload.region) ? payload.region : 'body';
  const cfg = interactionConfig();
  let text = String(payload.text || '');
  const zone = findTouchZone(Number(payload.x), Number(payload.y));
  if (zone) {
    const custom = pickInteractionLine(zone.text);
    if (custom) text = custom;
  } else {
    const list = cfg.bubbleTexts[region];
    if (Array.isArray(list) && list.length) text = list[Math.floor(Math.random() * list.length)];
  }
  if (!text) return;
  const expression = zone && zone.expression ? zone.expression : cfg.regionExpressions[region];
  applyTouchExpression(expression, text);
  const useApi = (zone && zone.useApi === true) || (cfg.touchUseApi === true);
  if (useApi && surfChatReady()) {
    // AI 优先：只显示「…」等 AI 回复，不再同时弹默认互动文本；超时才回退。
    armTouchFallback(text);
    showBubble('…', { keepTouchFallback: true, durationMs: TOUCH_AI_WAIT_MS });
  } else {
    showBubble(text);
  }
  maybeTouchApiReaction(zone, region, text);
}

ipcMain.on('pet:bubble', (_event, payload) => {
  handlePetBubble(payload);
});

ipcMain.on('bubble:dblclick', () => {
  openChatWindow().catch((e) => console.error('[chat] open failed', e));
});

ipcMain.handle('interaction:get', () => ({ ok: true, interaction: interactionConfig() }));
ipcMain.handle('interaction:save', (_event, data) => {
  config.interaction = sanitizeInteraction(data);
  clearExpressionResetTimer();
  saveConfig();
  broadcastState();
  return { ok: true, interaction: config.interaction };
});
ipcMain.handle('interaction:test-zone', (_event, index) => {
  const cfg = interactionConfig();
  const zone = cfg.zones[Number(index)];
  if (!zone || !petWin || petWin.isDestroyed()) return { ok: false, error: '触碰点不存在' };
  const b = petWin.getBounds();
  handlePetBubble({
    region: 'body',
    text: '',
    x: (zone.x / 100) * b.width,
    y: (zone.y / 100) * b.height,
  });
  return { ok: true };
});

ipcMain.on('pet:artbox', (_event, metrics) => {
  if (!metrics) return;
  petMetrics = metrics;
  repositionBubbleIfVisible();
});
ipcMain.on('win:lower', () => lowerPetOneLevel());
ipcMain.on('win:bring-top', () => bringPetToTop());

ipcMain.on('bubble:size', (_event, size) => {
  if (!size || !Number.isFinite(size.width) || !Number.isFinite(size.height)) return;
  bubbleSize = {
    width: Math.max(80, Math.min(340, Math.round(size.width))),
    height: Math.max(36, Math.min(260, Math.round(size.height))),
  };
  if (bubbleWanted && bubbleWin && !bubbleWin.isDestroyed()) {
    bubblePendingShow = false;
    positionBubble();
    bubbleWin.showInactive();
    bubbleWin.moveTop();
    scheduleBubbleHide(bubblePendingDuration);
  } else if (bubbleVisible) {
    positionBubble();
  }
});

ipcMain.on('win:context-menu', () => {
  if (!petWin || petWin.isDestroyed()) return;
  buildContextMenu().popup({ window: petWin });
});

ipcMain.on('panel:toggle', () => togglePanel());

ipcMain.on('pet:panel-state', (_event, open) => {
  if (panelWin && !panelWin.isDestroyed()) panelWin.webContents.send('panel:state', !!open);
});

ipcMain.on('pet:dblclick', () => togglePanel(true));

// ---------------------------------------------------------------------------
// IPC from panel renderer
// ---------------------------------------------------------------------------
ipcMain.on('panel:init-request', () => {
  if (!panelWin || panelWin.isDestroyed()) return;
  panelWin.webContents.send('panel:init', { state: publicState(), modelInfo });
});

ipcMain.on('panel:param-set', (_event, payload) => {
  if (!payload || typeof payload.id !== 'string') return;
  const value = Number(payload.value);
  if (!Number.isFinite(value)) return;
  config.overrides[payload.id] = value;
  saveConfig();
  if (petWin && !petWin.isDestroyed()) petWin.webContents.send('param:set', { id: payload.id, value });
});

ipcMain.on('panel:param-reset', (_event, payload) => {
  if (!payload || typeof payload.id !== 'string') return;
  delete config.overrides[payload.id];
  saveConfig();
  if (petWin && !petWin.isDestroyed()) petWin.webContents.send('param:reset', { id: payload.id });
});

ipcMain.on('panel:reset-all', () => {
  config.overrides = {};
  saveConfig();
  if (petWin && !petWin.isDestroyed()) petWin.webContents.send('param:reset-all');
  broadcastState();
});

ipcMain.on('panel:expression', (_event, payload) => {
  clearExpressionResetTimer();
  if (petWin && !petWin.isDestroyed()) petWin.webContents.send('expression:set', payload);
});
ipcMain.on('panel:motion', (_event, payload) => {
  if (petWin && !petWin.isDestroyed()) petWin.webContents.send('motion:play', payload);
});
ipcMain.on('panel:view-reset', () => {
  if (petWin && !petWin.isDestroyed()) petWin.webContents.send('view:reset');
});

ipcMain.on('panel:option', (_event, payload) => {
  if (!payload) return;
  const { key, value } = payload;
  if (key === 'pinned') setPinned(!!value);
  else if (key === 'locked') setLocked(!!value);
  else if (key === 'dragOnTransparent') {
    config.dragOnTransparent = !!value;
    saveConfig();
    broadcastState();
    updateTrayMenu();
    if (petWin && !petWin.isDestroyed()) petWin.webContents.send('option', { key: 'dragOnTransparent', value: config.dragOnTransparent });
  } else if (key === 'dblclickLower') {
    config.dblclickLower = !!value;
    saveConfig();
    broadcastState();
    updateTrayMenu();
  }
  else if (key === 'followMouse') setFollowMouse(!!value);
  else if (key === 'strength') {
    config.strength = Math.max(0, Math.min(1.5, Number(value) || 0));
    saveConfig();
    broadcastState();
    if (petWin && !petWin.isDestroyed()) petWin.webContents.send('option', { key: 'strength', value: config.strength });
  } else if (key === 'opacity') {
    config.opacity = Math.max(0.2, Math.min(1, Number(value) || 1));
    saveConfig();
    broadcastState();
    applyWindowOptions();
  } else if (key === 'alwaysOnTop') {
    config.alwaysOnTop = !!value;
    saveConfig();
    if (config.alwaysOnTop) bringPetToTop();
    else { petLowered = false; applyWindowOptions(); }
    broadcastState();
    updateTrayMenu();
  } else if (key === 'size') {
    resizeWindow(Number(value.width), Number(value.height));
  } else if (key === 'recenter') {
    moveToBottomRight();
  } else if (key === 'armSway') {
    setArmSway(!!value);
  } else if (key === 'memory-save') {
    saveMemoryPoint(Number(value));
  } else if (key === 'memory-goto') {
    gotoMemoryPoint(Number(value));
  } else if (key === 'bubbleEnabled') {
    setBubbleEnabled(!!value);
  } else if (key === 'bubble-adjust') {
    setBubbleAdjusting(!!value);
  } else if (key === 'bubble-reset') {
    resetBubbleOffset();
  }
});

// ---------------------------------------------------------------------------
// model library IPC from panel
// ---------------------------------------------------------------------------
ipcMain.on('panel:idle', () => { backToIdle(); });

ipcMain.on('panel:model-import-folder', () => { importModelFolder().catch((e) => dialog.showErrorBox('导入失败', e.message)); });
ipcMain.on('panel:model-import-file', () => { importModelFile().catch((e) => dialog.showErrorBox('导入失败', e.message)); });
ipcMain.on('panel:model-select', (_event, id) => selectModel(String(id || '')));
ipcMain.on('panel:model-remove', (_event, id) => removeModel(String(id || '')));
ipcMain.on('panel:model-rescan', () => { rescanModels().catch((e) => console.error('[model] rescan failed', e)); });
ipcMain.on('panel:model-open', (_event, id) => openModelFolder(String(id || '')));
ipcMain.on('panel:model-option', (_event, payload) => {
  if (!payload) return;
  setModelOption(payload.key, payload.value);
});

ipcMain.on('panel:minimize', () => { if (panelWin && !panelWin.isDestroyed()) panelWin.minimize(); });
ipcMain.on('panel:close', () => { if (panelWin && !panelWin.isDestroyed()) panelWin.close(); });
ipcMain.on('app:quit', () => quitApp());

// chat window IPC
ipcMain.handle('chat:send', async (_event, payload) => {
  const text = String(payload && payload.text || '').trim();
  if (!text) return { ok: false, error: '说点什么吧' };
  if (!surf) return { ok: false, error: 'SurfCore 未就绪' };
  const result = await surf.chat(text, 'text');
  if (!result || !result.ok) return { ok: false, error: (result && result.error) || '发送失败' };
  const roleName = (() => { try { return surf.publicState().roleName || '角色'; } catch (_) { return '角色'; } })();
  const replyText = result.reply && result.reply.text ? result.reply.text : '';
  const qq = await sendOwnerQQ('【桌宠对话】\n你：' + text + '\n' + roleName + '：' + replyText);
  return { ok: true, roleName, user: text, reply: replyText, qq };
});
ipcMain.on('chat:close', () => {
  if (chatWin && !chatWin.isDestroyed()) chatWin.close();
});

// ---------------------------------------------------------------------------
// SurfCore / autostart IPC
// ---------------------------------------------------------------------------
ipcMain.handle('surf:status', async () => {
  if (!surf) return { ok: false, error: 'SurfCore 集成未初始化' };
  try {
    return { ok: true, ...surf.statusPayload(), autoStart: config.autoStart === true };
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) };
  }
});
ipcMain.handle('surf:refresh', async () => {
  if (!surf) return { ok: false, error: 'SurfCore 集成未初始化' };
  const r = await surf.refresh();
  return { ...r, ...surf.statusPayload(), autoStart: config.autoStart === true };
});
ipcMain.handle('surf:chat', async (_event, payload) => {
  if (!surf) return { ok: false, error: 'SurfCore 集成未初始化' };
  return await surf.chat(payload && payload.text, payload && payload.modality);
});
ipcMain.handle('surf:test', async () => {
  if (!surf) return { ok: false, error: 'SurfCore 集成未初始化' };
  const r = await surf.testSay();
  if (r && r.ok) surf.refresh().catch(() => {});
  return r;
});
ipcMain.handle('surf:token', async (_event, payload) => {
  if (!surf) return { ok: false, error: 'SurfCore 集成未初始化' };
  if (payload && payload.action === 'regenerate') return surf.regenerateToken();
  return surf.tokenPayload();
});
ipcMain.on('surf:set-option', (_event, payload) => {
  if (!payload) return;
  if (payload.key === 'enabled') config.surf.enabled = payload.value !== false;
  else if (payload.key === 'autoTalk') config.surf.autoTalk = payload.value !== false;
  else if (payload.key === 'intervalMin') config.surf.intervalMin = Math.max(5, Math.min(240, Number(payload.value) || 30));
  else return;
  saveConfig();
  if (surf) surf.applySettings();
  broadcastState();
});
ipcMain.on('panel:autostart', (_event, on) => setAutoStart(on === true));
ipcMain.on('surf:open-settings', () => {
  let url = 'http://127.0.0.1:6238';
  try {
    const h = surf && surf.getHost();
    if (h && h.baseUrl) url = h.baseUrl;
  } catch (_) {}
  shell.openExternal(url).catch(() => {});
});

// ---------------------------------------------------------------------------
// smoke test support
// ---------------------------------------------------------------------------
let smokeDone = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function capturePet(name, dir) {
  const image = await petWin.webContents.capturePage();
  const file = path.join(dir, name);
  fs.writeFileSync(file, image.toPNG());
  console.log('[smoke] captured ' + file);
  return image;
}

function bitmapStats(image) {
  const bmp = image.toBitmap();
  let transparent = 0;
  let opaque = 0;
  let min = 255;
  for (let i = 3; i < bmp.length; i += 4) {
    const a = bmp[i];
    if (a < min) min = a;
    if (a < 10) transparent += 1;
    else if (a > 240) opaque += 1;
  }
  return { transparent, opaque, total: Math.floor(bmp.length / 4), minAlpha: min };
}

function bitmapDiff(a, b) {
  const x = a.toBitmap();
  const y = b.toBitmap();
  if (x.length !== y.length) return -1;
  let diff = 0;
  for (let i = 0; i < x.length; i += 4) {
    if (Math.abs(x[i] - y[i]) > 6 || Math.abs(x[i + 1] - y[i + 1]) > 6 || Math.abs(x[i + 2] - y[i + 2]) > 6) diff += 1;
  }
  return diff;
}

async function runSmokeSequence() {
  const out = smokeOut || path.join(APP_ROOT, 'dist', 'smoke-pet.png');
  const dir = path.dirname(out);
  fs.mkdirSync(dir, { recursive: true });
  try {
    const base = await capturePet('smoke-pet.png', dir);
    console.log('[smoke] alpha ' + JSON.stringify(bitmapStats(base)));
    try {
      const hit = await petWin.webContents.executeJavaScript(
        "(() => { const d = window.__petDebug; if (!d) return 'no-debug'; const w = innerWidth, h = innerHeight; const b = d.measure(); return JSON.stringify({ bbox: b, center: d.hitTest(w / 2, h * 0.5), feet: d.hitTest(w / 2, h * 0.9), left: d.hitTest(4, h * 0.5), corner: d.hitTest(4, 4), params: d.paramCount() }); })()"
      );
      console.log('[smoke] hit ' + hit);
    } catch (e) {
      console.error('[smoke] hit test failed', e);
    }
    await sleep(800);
    const idle2 = await petWin.webContents.capturePage();
    console.log('[smoke] idle diff(px) ' + bitmapDiff(base, idle2));

    petWin.webContents.send('param:set', { id: 'ParamAngleX', value: 25 });
    petWin.webContents.send('param:set', { id: 'ParamEyeBallX', value: 0.8 });
    await sleep(1000);
    await capturePet('smoke-param.png', dir);
    petWin.webContents.send('param:reset-all');
    await sleep(500);

    // chat bubble region test
    try {
      const measureJson = await petWin.webContents.executeJavaScript('JSON.stringify(window.__petDebug.measure())');
      const box = JSON.parse(measureJson);
      const regions = ['head', 'face', 'arm', 'body', 'leg', 'tail'];
      for (const name of regions) {
        const pt = await petWin.webContents.executeJavaScript('JSON.stringify(window.__petDebug.findRegionPoint(' + JSON.stringify(name) + '))');
        const p = JSON.parse(pt);
        if (!p) { console.log('[smoke] no point for region ' + name); continue; }
        const x = p.x, y = p.y;
        const probe = await petWin.webContents.executeJavaScript('JSON.stringify(window.__petDebug.probeAt(' + x.toFixed(1) + ', ' + y.toFixed(1) + '))');
        const region = await petWin.webContents.executeJavaScript('window.__petDebug.triggerAt(' + x.toFixed(1) + ', ' + y.toFixed(1) + ')');
        console.log('[smoke] probe ' + name + ' ' + probe);
        await sleep(700);
        if (bubbleWin && !bubbleWin.isDestroyed() && bubbleWin.isVisible()) {
          const img = await bubbleWin.webContents.capturePage();
          fs.writeFileSync(path.join(dir, 'smoke-bubble-' + name + '.png'), img.toPNG());
          const bb = bubbleWin.getBounds();
          console.log('[smoke] bubble ' + name + ' region=' + region + ' bubbleBottom=' + (bb.y + bb.height) + ' artTop=' + Math.round(petWin.getBounds().y + box.y0));
        } else {
          console.log('[smoke] bubble ' + name + ' region=' + region + ' (no bubble)');
        }
      }
      hideBubble();
      await sleep(300);

      // real click path (synthetic mouse events through Chromium)
      const cx = Math.round(box.cx);
      const cy = Math.round(box.y0 + box.h * 0.2);
      await petWin.webContents.executeJavaScript('window.__petDebug.setAutoIgnore(false)');
      petWin.setIgnoreMouseEvents(false);
      await sleep(120);
      petWin.webContents.sendInputEvent({ type: 'mouseDown', x: cx, y: cy, button: 'left', clickCount: 1 });
      await sleep(60);
      petWin.webContents.sendInputEvent({ type: 'mouseUp', x: cx, y: cy, button: 'left', clickCount: 1 });
      await sleep(900);
      const stats = await petWin.webContents.executeJavaScript('JSON.stringify(window.__petDebug.inputStats())');
      console.log('[smoke] click stats ' + stats);
      if (bubbleWin && !bubbleWin.isDestroyed() && bubbleWin.isVisible()) {
        const img = await bubbleWin.webContents.capturePage();
        fs.writeFileSync(path.join(dir, 'smoke-bubble-click.png'), img.toPNG());
        console.log('[smoke] real click bubble ok bounds=' + JSON.stringify(bubbleWin.getBounds()));
      } else {
        console.log('[smoke] real click did not open bubble');
      }
      hideBubble();
      await petWin.webContents.executeJavaScript('window.__petDebug.setAutoIgnore(true)');
      await sleep(300);

      // adjust mode preview
      setBubbleAdjusting(true);
      await sleep(900);
      if (bubbleWin && !bubbleWin.isDestroyed()) {
        const img = await bubbleWin.webContents.capturePage();
        fs.writeFileSync(path.join(dir, 'smoke-bubble-adjust.png'), img.toPNG());
        console.log('[smoke] adjust bubble bounds=' + JSON.stringify(bubbleWin.getBounds()));
      }
      // simulate dragging the bubble in adjust mode
      const bb = bubbleWin && !bubbleWin.isDestroyed() ? bubbleWin.getBounds() : null;
      if (bb) {
        bubbleMoveGuard = 0;
        bubbleWin.setBounds({ x: bb.x + 40, y: bb.y + 24, width: bb.width, height: bb.height });
        await sleep(400);
        console.log('[smoke] bubble offset ' + JSON.stringify(config.bubbleOffset));
        resetBubbleOffset();
        await sleep(200);
      }
      setBubbleAdjusting(false);
      await sleep(700);
      hideBubble();
    } catch (e) {
      console.error('[smoke] bubble failed', e);
    }

    // idle: breathing + eye drift + blink
    try {
      await petWin.webContents.executeJavaScript('window.__petDebug.setLook(0, 0)');
      await sleep(700);
      const idle1 = await petWin.webContents.executeJavaScript('JSON.stringify(window.__petDebug.idleSample())');
      await sleep(1000);
      const idle2 = await petWin.webContents.executeJavaScript('JSON.stringify(window.__petDebug.idleSample())');
      console.log('[smoke] idle ' + idle1 + ' -> ' + idle2);
      await petWin.webContents.executeJavaScript('window.__petDebug.forceBlink()');
      await sleep(75);
      await capturePet('smoke-blink.png', dir);
      const blink = await petWin.webContents.executeJavaScript('JSON.stringify(window.__petDebug.idleSample())');
      console.log('[smoke] blink ' + blink);
      await sleep(400);
    } catch (e) {
      console.error('[smoke] idle failed', e);
    }

    // generic model import / switch test
    try {
      if (modelScanner) {
        const qdir = 'Q:\\美化\\DeepSeek免费公皮\\DeepSeek';
        const scan = modelScanner.scanModelDir(qdir);
        console.log('[smoke] scan-q ' + JSON.stringify({ ok: scan.ok, virtual: scan.virtual, counts: scan.info && scan.info.counts }));
        if (scan.ok) {
          addModelFromScan(scan, { makeCurrent: true, clearOverrides: true });
          loadPetPage();
          await sleep(7000);
          console.log('[smoke] model-switched models=' + config.models.length + ' current=' + config.currentModelId + ' url=' + currentModelUrl());
          await capturePet('smoke-switch.png', dir);
        }
      }
    } catch (e) {
      console.error('[smoke] model switch failed', e);
    }

    if (modelInfo && modelInfo.expressions && modelInfo.expressions.length) {
      let index = modelInfo.expressions.findIndex((e) => /爱心眼/.test(e.name));
      if (index < 0) index = 0;
      petWin.webContents.send('expression:set', { index });
      await sleep(900);
      await capturePet('smoke-expression.png', dir);
      petWin.webContents.send('expression:set', { index: -1 });
      await sleep(400);
    }

    if (modelInfo && modelInfo.motions && modelInfo.motions.length) {
      let motion = modelInfo.motions.find((m) => /竖食指/.test(m.label));
      if (!motion) motion = modelInfo.motions.find((m) => m.group !== 'Idle');
      if (motion) {
        petWin.webContents.send('motion:play', { group: motion.group, index: motion.index });
        await sleep(700);
        await capturePet('smoke-motion.png', dir);
        await sleep(6000);
        const after = await petWin.webContents.executeJavaScript('JSON.stringify(window.__petDebug.motionState())');
        console.log('[smoke] motion-after ' + after);
        await capturePet('smoke-motion-after.png', dir);
        petWin.webContents.send('motion:idle');
        await sleep(1200);
        const forced = await petWin.webContents.executeJavaScript('JSON.stringify(window.__petDebug.motionState())');
        console.log('[smoke] idle-forced ' + forced);
        await capturePet('smoke-idle-forced.png', dir);
      }
    }

    resizeWindow(560, 960);
    await sleep(1400);
    await capturePet('smoke-resize.png', dir);

    // resize anchor + instant fit test
    const beforeResize = petWin.getBounds();
    resizeWindow(320, 520);
    await sleep(90);
    const shrinkFit = await petWin.webContents.executeJavaScript('JSON.stringify({ bbox: window.__petDebug.measure(), w: innerWidth, h: innerHeight })');
    await sleep(500);
    await capturePet('smoke-shrink.png', dir);
    const afterResize = petWin.getBounds();
    console.log('[smoke] resize ' + JSON.stringify({ beforeResize, afterResize, shrinkFit }));

    // memory point test
    saveMemoryPoint(0);
    const memSaved = windowSnapshot();
    moveToBottomRight();
    await sleep(400);
    gotoMemoryPoint(0);
    await sleep(400);
    const memBack = windowSnapshot();
    console.log('[smoke] memory ' + JSON.stringify({ saved: memSaved, back: memBack }));

    setPinned(true);
    await sleep(700);
    await capturePet('smoke-pinned.png', dir);
    setPinned(false);
    await sleep(400);

    togglePanel(true);
    await sleep(1600);
    if (panelWin && !panelWin.isDestroyed()) {
      try {
        const title = await panelWin.webContents.executeJavaScript(
          "(() => { const groups = document.querySelectorAll('#param-list .group'); const g = groups[3]; if (g) { g.querySelector('.group-head').click(); return g.querySelector('.gname').textContent; } return 'none'; })()"
        );
        console.log('[smoke] panel expanded group: ' + title);
      } catch (e) {
        console.error('[smoke] panel script failed', e);
      }
      await sleep(900);
      let img = await panelWin.webContents.capturePage();
      fs.writeFileSync(path.join(dir, 'smoke-panel.png'), img.toPNG());
      console.log('[smoke] captured panel');
      await sleep(400);
      img = await panelWin.webContents.capturePage();
      fs.writeFileSync(path.join(dir, 'smoke-panel2.png'), img.toPNG());

      await panelWin.webContents.executeJavaScript("document.querySelector('#tabs button[data-tab=\"settings\"]').click(); document.querySelector('#tab-settings').scrollTop = 320;");
      await sleep(600);
      img = await panelWin.webContents.capturePage();
      fs.writeFileSync(path.join(dir, 'smoke-panel-settings.png'), img.toPNG());
      console.log('[smoke] captured panel settings');
      await panelWin.webContents.executeJavaScript("document.querySelector('#tabs button[data-tab=\"models\"]').click();");
      await sleep(700);
      img = await panelWin.webContents.capturePage();
      fs.writeFileSync(path.join(dir, 'smoke-panel-models.png'), img.toPNG());
      console.log('[smoke] captured panel models');
    }
  } catch (e) {
    console.error('[smoke] failed', e);
  }
  try {
    const summary = {
      window: petWin && !petWin.isDestroyed() ? petWin.getBounds() : null,
      pinned: config.pinned,
      model: modelInfo
        ? {
            modelName: modelInfo.modelName,
            params: modelInfo.params.length,
            groups: modelInfo.groups.length,
            expressions: modelInfo.expressions.length,
            motions: modelInfo.motions.length,
            coreVersion: modelInfo.coreVersion,
          }
        : null,
      configPath: configPath(),
    };
    fs.writeFileSync(path.join(dir, 'smoke.json'), JSON.stringify(summary, null, 2), 'utf8');
  } catch (_) {}
  app.quit();
}

function scheduleSmokeCapture() {
  if (smokeDone) return;
  smokeDone = true;
  setTimeout(() => {
    runSmokeSequence();
  }, 2600);
}

// ---------------------------------------------------------------------------
// look direction test (development)
// ---------------------------------------------------------------------------
let lookTestDone = false;
async function runLookTest() {
  const dir = path.join(APP_ROOT, 'dist');
  fs.mkdirSync(dir, { recursive: true });
  const shots = [
    ['center', 0, 0],
    ['right', 1, 0],
    ['left', -1, 0],
    ['up', 0, 1],
    ['down', 0, -1],
    ['up_right', 0.7, 0.6],
    ['down_left', -0.7, -0.6],
  ];
  try {
    await sleep(600);
    for (const [name, x, y] of shots) {
      await petWin.webContents.executeJavaScript(`window.__petDebug.setLook(${x}, ${y})`);
      await sleep(1300);
      const image = await petWin.webContents.capturePage();
      fs.writeFileSync(path.join(dir, `look-${name}.png`), image.toPNG());
      const angles = await petWin.webContents.executeJavaScript('JSON.stringify({ a: window.__petDebug.lookAngles(), d: window.__petDebug.debugInfo() })');
      console.log('[look] ' + name + ' ' + angles);
    }
    fs.writeFileSync(path.join(dir, 'look.json'), JSON.stringify({ window: petWin.getBounds() }, null, 2), 'utf8');
  } catch (e) {
    console.error('[look] failed', e);
  }
  app.quit();
}

function scheduleLookTest() {
  if (lookTestDone) return;
  lookTestDone = true;
  setTimeout(() => { runLookTest(); }, 2200);
}

// ---------------------------------------------------------------------------
// app lifecycle
// ---------------------------------------------------------------------------
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (petWin && !petWin.isDestroyed()) {
      if (!petWin.isVisible()) petWin.show();
      petWin.focus();
    }
  });

  app.whenReady().then(() => {
    protocol.handle('pet', handlePetRequest);

    loadConfig();
    if (!app.isPackaged && modelEntries().length === 0) autoImportDevModels();
    rescanAllEntries();
    const hasModel = !!(currentEntry() && scans.get(config.currentModelId) && scans.get(config.currentModelId).ok);
    createPetWindow();
    ensureBubbleWindow();
    createTray();
    startTopmostGuard();
    startCursorTracking();
    applyAutoStart();
    if (surfcoreLib) {
      surf = surfcoreLib.createSurfCore({
        getSettings: () => config.surf,
        save: () => saveConfig(),
        onMessage: (text, options) => {
          showBubble(text, options);
          try { if (options && options.source === 'chat') rememberReply(text); } catch (_) {}
          try {
            if (options && options.source === 'chat') {
              const name = autoExpressionName(text);
              if (name) {
                const expr = findExpressionByName(name);
                if (expr) { applyExpressionIndex(expr.index); scheduleExpressionReset(); }
              }
            }
          } catch (_) {}
        },
        onState: () => {
          broadcastState();
          updateTrayTooltip();
          if (panelWin && !panelWin.isDestroyed() && surf) {
            try { panelWin.webContents.send('surf:state', surf.publicState()); } catch (_) {}
          }
        },
        log: (...args) => console.log('[surfcore]', ...args),
      });
      try { surf.start(); } catch (e) { console.error('[surfcore] start failed', e); }
    }

    globalShortcut.register('CommandOrControl+Alt+P', () => setPinned(!config.pinned));
    globalShortcut.register('CommandOrControl+Alt+L', () => setLocked(!config.locked));
    globalShortcut.register('CommandOrControl+Alt+H', () => togglePetVisible());
    globalShortcut.register('CommandOrControl+Alt+M', () => togglePanel(true));
    globalShortcut.register('CommandOrControl+Alt+I', () => backToIdle());
    globalShortcut.register('CommandOrControl+Alt+T', () => bringPetToTop());

    if (!hasModel) {
      setTimeout(() => { try { togglePanel(true); } catch (_) {} }, 1500);
    }

    if (smokeImportDir) {
      setTimeout(() => {
        importModelDir(smokeImportDir).catch((e) => console.error('[smoke-import] import failed', e));
      }, 1500);
    }

    if (isSmoke) {
      setTimeout(() => {
        if (!smokeDone) {
          smokeDone = true;
          console.error('[smoke] timeout waiting for pet ready');
          app.quit();
        }
      }, 60000);
    }
    if (isSmokeLook) {
      setTimeout(() => {
        if (!lookTestDone) {
          lookTestDone = true;
          console.error('[look] timeout waiting for pet ready');
          app.quit();
        }
      }, 60000);
    }
  });

  app.on('window-all-closed', () => {
    if (!tray) app.quit();
  });

  app.on('before-quit', () => {
    quitting = true;
    if (saveTimer) {
      clearTimeout(saveTimer);
      try { fs.writeFileSync(configPath(), JSON.stringify(config, null, 2), 'utf8'); } catch (_) {}
    }
    globalShortcut.unregisterAll();
  });
}

