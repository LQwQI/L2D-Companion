'use strict';

/**
 * SurfCore 集成：
 *  - 从 ~/.dsh/surfcore/pet/host.json 发现 SurfCore 的 pet-api（本机回环 + 一次性令牌）
 *  - 长轮询 /events，把主动搭话 / 测试回复推给桌宠气泡
 *  - POST /chat，让角色用 SurfCore 的人格、记忆和模型说话
 *  - 自带一个 127.0.0.1 的本地控制 API（/api/speak、/api/chat），令牌 + 防爆破 + 限速
 *
 * 所有 SurfCore 请求只允许发往 127.0.0.1 / localhost / ::1，绝不把 host token 写进日志。
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_API_PORT = 3199;
const MAX_BODY = 64 * 1024;
const RATE_WINDOW_MS = 60 * 1000;
const RATE_MAX = 60;
const FAIL_WINDOW_MS = 60 * 1000;
const FAIL_MAX = 6;
const LOCK_MS = 5 * 60 * 1000;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isLoopbackHost = (hostname) => {
  const h = String(hostname || '').toLowerCase();
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]';
};

function dshHome() {
  const env = String(process.env.DSH_HOME || '').trim();
  return env || path.join(os.homedir(), '.dsh');
}

function loadHostFile() {
  const file = path.join(dshHome(), 'surfcore', 'pet', 'host.json');
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
  const baseUrl = String(raw && raw.baseUrl || '').replace(/\/+$/, '');
  const token = String(raw && raw.token || '');
  let u;
  try {
    u = new URL(baseUrl);
  } catch (_) {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!isLoopbackHost(u.hostname)) return null;
  if (token.length < 16) return null;
  const api = String(raw && raw.api || '/dsh-surfcore/pet-api').replace(/\/+$/, '');
  return {
    file,
    baseUrl,
    token,
    api,
    pluginVersion: String(raw && raw.pluginVersion || ''),
    updatedAt: String(raw && raw.updatedAt || ''),
  };
}

function requestJson(urlString, options) {
  const opts = options || {};
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(urlString);
    } catch (e) {
      reject(new Error('SurfCore 地址无效'));
      return;
    }
    if (!isLoopbackHost(u.hostname)) {
      reject(new Error('只允许访问本机 SurfCore'));
      return;
    }
    const mod = u.protocol === 'https:' ? https : http;
    const body = opts.body == null ? null : Buffer.from(JSON.stringify(opts.body), 'utf8');
    const headers = Object.assign({ accept: 'application/json' }, opts.headers || {});
    if (body) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = String(body.length);
    }
    const req = mod.request(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: opts.method || 'GET',
        headers,
        timeout: opts.timeoutMs || 15000,
      },
      (res) => {
        const chunks = [];
        let size = 0;
        res.on('data', (chunk) => {
          size += chunk.length;
          if (size > 1024 * 1024) {
            req.destroy(new Error('SurfCore 响应过大'));
            return;
          }
          chunks.push(chunk);
        });
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let data = null;
          try {
            data = text ? JSON.parse(text) : null;
          } catch (_) {}
          if (res.statusCode >= 400) {
            const err = new Error((data && data.error) || 'SurfCore 请求失败（HTTP ' + res.statusCode + '）');
            err.status = res.statusCode;
            err.data = data;
            reject(err);
            return;
          }
          resolve(data);
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('SurfCore 请求超时')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  if (ba.length !== bb.length) return false;
  try {
    return crypto.timingSafeEqual(ba, bb);
  } catch (_) {
    return false;
  }
}

function clipText(text, max) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function bubbleDuration(text) {
  return clamp(4200 + String(text || '').length * 75, 5000, 14000);
}

function createSurfCore(options) {
  const opts = options || {};
  const getSettings = opts.getSettings || (() => ({}));
  const save = opts.save || (() => {});
  const onMessage = opts.onMessage || (() => {});
  const onState = opts.onState || (() => {});
  const log = opts.log || ((...args) => console.log('[surfcore]', ...args));

  let settings = getSettings() || {};
  let running = false;
  let pollTimer = null;
  let pollBusy = false;
  let autoTimer = null;
  let host = null;
  let cursor = null;
  let bootId = '';
  let lastStatus = null;
  let lastError = '';
  let connectedAt = 0;
  let lastProactiveAt = 0;
  let lastChatAt = 0;
  let localServer = null;
  let localPort = 0;
  let localError = '';

  const failures = new Map();
  const hits = new Map();

  function ensureToken() {
    if (!settings.apiToken || String(settings.apiToken).length < 24) {
      settings.apiToken = crypto.randomBytes(24).toString('base64url');
      save();
    }
    return settings.apiToken;
  }

  function publicState() {
    const st = lastStatus || {};
    const role = st.role || {};
    const llm = st.llm || {};
    const chat = st.chat || {};
    const proactive = st.proactive || {};
    return {
      enabled: settings.enabled !== false,
      connected: !!host && Date.now() - connectedAt < 90 * 1000,
      roleName: String(role.name || ''),
      personaChars: Number(role.personaChars) || 0,
      model: String(llm.model || ''),
      provider: String(llm.provider || ''),
      chatEnabled: chat.enabled !== false,
      proactiveCarrier: String(proactive.carrier || (st.purpose && st.purpose.carrier) || ''),
      presenceOnline: Boolean((st.presence && st.presence.online) || (proactive && proactive.online)),
      autoTalk: settings.autoTalk !== false,
      intervalMin: clamp(Number(settings.intervalMin) || 30, 5, 240),
      lastError,
      apiPort: localPort || Number(settings.apiPort) || DEFAULT_API_PORT,
      apiRunning: !!localServer,
      apiUrl: localServer ? 'http://127.0.0.1:' + localPort + '/api/speak' : '',
      lastProactiveAt,
      lastChatAt,
    };
  }

  async function fetchStatus() {
    if (!host) throw new Error('还没有发现 SurfCore 的 pet host.json');
    const headers = { 'x-pet-token': host.token };
    const status = await requestJson(host.baseUrl + host.api + '/status', { headers });
    lastStatus = status;
    lastError = '';
    connectedAt = Date.now();
    return status;
  }

  async function fetchConfig() {
    if (!host) return null;
    const headers = { 'x-pet-token': host.token };
    try {
      const cfg = await requestJson(host.baseUrl + host.api + '/config', { headers });
      if (cfg && cfg.role) {
        lastStatus = Object.assign({}, lastStatus || {}, { role: Object.assign({}, (lastStatus || {}).role || {}, cfg.role) });
      }
      return cfg;
    } catch (_) {
      return null;
    }
  }

  async function chat(text, modality) {
    const say = String(text || '').trim();
    if (!say) return { ok: false, error: '说点什么吧' };
    if (!settings.enabled) return { ok: false, error: 'SurfCore 集成已关闭' };
    if (!host) return { ok: false, error: '还没有发现 SurfCore（请先启动 DSH + SurfCore 插件）' };
    try {
      const data = await requestJson(host.baseUrl + host.api + '/chat', {
        method: 'POST',
        headers: { 'x-pet-token': host.token },
        body: { text: say, modality: modality === 'voice' ? 'voice' : 'text' },
        timeoutMs: 90000,
      });
      if (!data || !data.ok) {
        const msg = (data && data.error) || '角色没有回复';
        lastError = msg;
        return { ok: false, error: msg };
      }
      const reply = (data.reply && data.reply.text) || '';
      lastChatAt = Date.now();
      lastError = '';
      if (reply) {
        onMessage(clipText(reply, 500), { source: 'chat', durationMs: bubbleDuration(reply) });
      }
      onState();
      return { ok: true, reply: { text: reply, modality: (data.reply && data.reply.modality) || 'text', audioKey: (data.reply && data.reply.audio && data.reply.audio.key) || '' } };
    } catch (e) {
      lastError = String(e && e.message || e);
      onState();
      return { ok: false, error: lastError };
    }
  }

  async function proactiveSelfTalk() {
    if (!settings.enabled || settings.autoTalk === false) return { ok: false, error: '自动说话已关闭' };
    const st = lastStatus || {};
    if (st.focus && st.focus.enabled) return { ok: false, error: 'SurfCore 专注模式开着，先不主动打扰' };
    if (st.chat && st.chat.enabled === false) return { ok: false, error: 'SurfCore 的桌宠对话已关闭' };
    const prompt = '（桌宠待机中，主动对主人说一句自然、简短的话，20~60字；不要提问，不要重复最近说过的话。）';
    return chat(prompt, 'text');
  }

  async function testSay(text) {
    const say = String(text || '').trim() || '（桌宠测试：用你的人设说一句欢迎的话）';
    return chat(say, 'text');
  }

  function noteEvent(ev) {
    if (!ev || !ev.text) return;
    if (ev.type === 'focus') return;
    const text = clipText(ev.text, 500);
    lastProactiveAt = Date.now();
    onMessage(text, { source: 'surf-' + (ev.type || 'event'), durationMs: bubbleDuration(text) });
    onState();
  }

  async function pollOnce() {
    if (pollBusy || !running || settings.enabled === false) return;
    pollBusy = true;
    try {
      const nextHost = loadHostFile();
      if (nextHost) host = nextHost;
      if (!host) {
        lastError = '未发现 SurfCore pet host.json（启动 DSH + SurfCore 后自动重连）';
        await sleep(4000);
        return;
      }
      const since = cursor == null ? '' : String(cursor);
      const url = host.baseUrl + host.api + '/events?since=' + encodeURIComponent(since) +
        '&wait=25000&client=laidpet';
      const data = await requestJson(url, {
        headers: { 'x-pet-token': host.token },
        timeoutMs: 35000,
      });
      if (!data || !data.ok) throw new Error((data && data.error) || 'events 请求失败');
      connectedAt = Date.now();
      lastError = '';
      const isFirst = cursor == null || (data.bootId && bootId && data.bootId !== bootId);
      bootId = String(data.bootId || bootId || '');
      if (data.config) {
        if (!lastStatus) lastStatus = {};
        if (data.config.role) lastStatus.role = Object.assign({}, lastStatus.role || {}, data.config.role);
        lastStatus.chat = Object.assign({}, lastStatus.chat || {}, data.config.chat || {});
        lastStatus.proactive = Object.assign({}, lastStatus.proactive || {}, data.config.proactive || {});
      }
      if (!isFirst && Array.isArray(data.events) && data.events.length) {
        for (const ev of data.events) noteEvent(ev);
      }
      cursor = Number.isFinite(Number(data.cursor)) ? Number(data.cursor) : cursor;
      onState();
    } catch (e) {
      lastError = String(e && e.message || e);
      onState();
      await sleep(3000);
    } finally {
      pollBusy = false;
    }
  }

  async function pollLoop() {
    while (running) {
      await pollOnce();
    }
  }

  function scheduleAutoTalk() {
    if (autoTimer) {
      clearTimeout(autoTimer);
      autoTimer = null;
    }
    if (!running || settings.enabled === false || settings.autoTalk === false) return;
    const base = clamp(Number(settings.intervalMin) || 30, 5, 240) * 60 * 1000;
    const wait = Math.round(base * (0.8 + Math.random() * 0.4));
    autoTimer = setTimeout(async () => {
      autoTimer = null;
      try {
        await proactiveSelfTalk();
      } catch (e) {
        log('auto talk failed:', String(e && e.message || e));
      }
      scheduleAutoTalk();
    }, wait);
  }

  // ---------------------------------------------------------------- local API
  function clientIp(req) {
    const raw = String(req.socket && req.socket.remoteAddress || '');
    return raw.replace(/^::ffff:/, '');
  }

  function noteHit(ip) {
    const now = Date.now();
    const list = (hits.get(ip) || []).filter((t) => now - t < RATE_WINDOW_MS);
    list.push(now);
    hits.set(ip, list);
    return list.length <= RATE_MAX;
  }

  function lockedUntil(ip) {
    const f = failures.get(ip);
    return f && f.lockUntil > Date.now() ? f.lockUntil : 0;
  }

  function noteFailure(ip) {
    const now = Date.now();
    const f = failures.get(ip) || { count: 0, firstAt: now, lockUntil: 0 };
    if (now - f.firstAt > FAIL_WINDOW_MS) {
      f.count = 0;
      f.firstAt = now;
    }
    f.count += 1;
    if (f.count >= FAIL_MAX) {
      f.lockUntil = now + LOCK_MS;
      log('local api locked for ' + Math.round(LOCK_MS / 1000) + 's after repeated bad token (' + ip + ')');
    }
    failures.set(ip, f);
  }

  function readBody(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      let size = 0;
      req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) {
          reject(new Error('body too large'));
          req.destroy();
          return;
        }
        chunks.push(c);
      });
      req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      req.on('error', reject);
    });
  }

  function sendJson(res, code, data) {
    const body = Buffer.from(JSON.stringify(data), 'utf8');
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(body.length),
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(body);
  }

  function tokenFromRequest(req) {
    const head = String(req.headers['x-pet-token'] || '');
    if (head) return head;
    const auth = String(req.headers.authorization || '');
    return /^Bearer\s+(.+)$/i.exec(auth) ? auth.replace(/^Bearer\s+/i, '').trim() : '';
  }

  function startLocalServer() {
    if (localServer) return;
    const token = ensureToken();
    const startPort = clamp(Number(settings.apiPort) || DEFAULT_API_PORT, 1024, 65000);
    let attempts = 0;
    const tryListen = (port) => {
      if (attempts++ > 10) {
        localError = '本地 API 端口被占用（3199–3209 都不可用）';
        onState();
        return;
      }
      const server = http.createServer(async (req, res) => {
        const ip = clientIp(req);
        if (!noteHit(ip)) {
          sendJson(res, 429, { ok: false, error: '请求太频繁，稍后再试' });
          return;
        }
        let u;
        try {
          u = new URL(req.url, 'http://127.0.0.1');
        } catch (_) {
          sendJson(res, 400, { ok: false, error: 'bad url' });
          return;
        }
        const got = tokenFromRequest(req);
        if (!safeEqual(got, settings.apiToken)) {
          if (lockedUntil(ip)) {
            sendJson(res, 429, { ok: false, error: '连续令牌错误，已临时锁定，请稍后再试', lockedUntil: lockedUntil(ip) });
            return;
          }
          noteFailure(ip);
          sendJson(res, 401, { ok: false, error: '令牌无效', failures: (failures.get(ip) || {}).count || 0 });
          return;
        }
        failures.delete(ip);
        try {
          if (req.method === 'GET' && u.pathname === '/api/status') {
            sendJson(res, 200, { ok: true, pet: 'L2D Companion', surf: publicState(), serverTime: Date.now() });
            return;
          }
          if (req.method === 'POST' && (u.pathname === '/api/speak' || u.pathname === '/api/chat')) {
            if (!String(req.headers['content-type'] || '').toLowerCase().includes('application/json')) {
              sendJson(res, 415, { ok: false, error: '需要 application/json' });
              return;
            }
            let body = {};
            try {
              body = JSON.parse((await readBody(req)) || '{}');
            } catch (_) {
              sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' });
              return;
            }
            if (u.pathname === '/api/speak') {
              const text = clipText(body.text, 500);
              if (!text) {
                sendJson(res, 400, { ok: false, error: 'text 不能为空' });
                return;
              }
              onMessage(text, { source: 'api', durationMs: clamp(Number(body.durationMs) || bubbleDuration(text), 2000, 20000) });
              sendJson(res, 200, { ok: true, spoken: text });
              return;
            }
            const result = await chat(body.text, body.modality === 'voice' ? 'voice' : 'text');
            sendJson(res, result.ok ? 200 : 400, result);
            return;
          }
          sendJson(res, 404, { ok: false, error: 'unknown api' });
        } catch (e) {
          sendJson(res, 500, { ok: false, error: String(e && e.message || e) });
        }
      });
      server.on('error', (e) => {
        if (e && e.code === 'EADDRINUSE') {
          tryListen(port + 1);
          return;
        }
        localError = String(e && e.message || e);
        onState();
      });
      server.listen(port, '127.0.0.1', () => {
        localServer = server;
        localPort = port;
        localError = '';
        settings.apiPort = port;
        save();
        log('local api on http://127.0.0.1:' + port + '/api/speak');
        onState();
      });
    };
    tryListen(startPort);
  }

  function stopLocalServer() {
    if (localServer) {
      try { localServer.close(); } catch (_) {}
      localServer = null;
      localPort = 0;
    }
  }

  function start() {
    if (running) return;
    running = true;
    ensureToken();
    startLocalServer();
    pollLoop().catch((e) => log('poll loop stopped:', e));
    scheduleAutoTalk();
    setTimeout(() => { fetchConfig().catch(() => {}); }, 1200);
    setTimeout(() => { fetchStatus().catch(() => {}); }, 2500);
  }

  function stop() {
    running = false;
    if (autoTimer) clearTimeout(autoTimer);
    autoTimer = null;
    stopLocalServer();
  }

  function applySettings() {
    settings = getSettings() || settings;
    ensureToken();
    if (running) scheduleAutoTalk();
    onState();
  }

  async function refresh() {
    try {
      host = loadHostFile() || host;
      if (!host) throw new Error('未发现 SurfCore pet host.json');
      await fetchStatus();
      await fetchConfig();
      onState();
      return { ok: true };
    } catch (e) {
      lastError = String(e && e.message || e);
      onState();
      return { ok: false, error: lastError };
    }
  }

  function statusPayload() {
    return {
      ok: true,
      surf: publicState(),
      hostFile: host ? host.file : '',
      pluginVersion: host ? host.pluginVersion : '',
      personaPreview: lastStatus && lastStatus.role && lastStatus.role.personaFile ? readPersonaPreview(lastStatus.role.personaFile) : '',
    };
  }

  function readPersonaPreview(file) {
    try {
      const raw = fs.readFileSync(file, 'utf8');
      const text = raw.replace(/^#{1,4}\s*/gm, '').replace(/\s+/g, ' ').trim();
      return text.slice(0, 400);
    } catch (_) {
      return '';
    }
  }

  function tokenPayload() {
    return {
      ok: true,
      token: settings.apiToken || '',
      port: localPort || Number(settings.apiPort) || DEFAULT_API_PORT,
      url: (localServer ? 'http://127.0.0.1:' + localPort : 'http://127.0.0.1:' + (Number(settings.apiPort) || DEFAULT_API_PORT)) + '/api/speak',
      running: !!localServer,
      apiError: localError,
      locked: [...failures.entries()].filter(([, f]) => f.lockUntil > Date.now()).map(([ip, f]) => ({ ip, lockedUntil: f.lockUntil })),
    };
  }

  function regenerateToken() {
    settings.apiToken = crypto.randomBytes(24).toString('base64url');
    save();
    onState();
    return tokenPayload();
  }

  async function history(limit = 40) {
    if (!host) return { ok: false, error: '还没有连接 SurfCore', messages: [] };
    try {
      const n = Math.max(1, Math.min(100, Number(limit) || 40));
      const data = await requestJson(host.baseUrl + host.api + '/history?limit=' + n, {
        headers: { 'x-pet-token': host.token },
        timeoutMs: 15000,
      });
      const list = data && Array.isArray(data.messages) ? data.messages : [];
      return {
        ok: true,
        role: data && data.role ? data.role : {},
        messages: list.map((m) => ({
          role: m && m.role === 'user' ? 'user' : 'assistant',
          text: String(m && m.text || ''),
          at: Number(m && m.at) || 0,
          modality: m && m.modality ? m.modality : 'text',
        })).filter((m) => m.text),
      };
    } catch (e) {
      return { ok: false, error: String(e && e.message || e), messages: [] };
    }
  }

  return {
    start,
    stop,
    refresh,
    history,
    chat,
    proactiveSelfTalk,
    testSay,
    applySettings,
    statusPayload,
    publicState,
    tokenPayload,
    regenerateToken,
    getHost: () => host,
  };
}

module.exports = { createSurfCore, loadHostFile };
