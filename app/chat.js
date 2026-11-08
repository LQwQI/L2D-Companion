'use strict';

// Chat window opened by double-clicking the speech bubble.
// Every message is sent to SurfCore (persona + memory), and the exchange is
// mirrored to the owner's QQ private chat through SnowLuma.

const api = window.chatAPI;
const msgsEl = document.getElementById('msgs');
const inputEl = document.getElementById('input');
const sendEl = document.getElementById('send');
const titleEl = document.getElementById('title');
const qqEl = document.getElementById('qq');
const closeEl = document.getElementById('close');

let roleName = '角色';
let sending = false;

function scrollBottom() {
  msgsEl.scrollTop = msgsEl.scrollHeight;
}

function addMessage(role, text) {
  const content = String(text || '').trim();
  if (!content) return;
  const row = document.createElement('div');
  row.className = 'msg ' + (role === 'user' ? 'user' : role === 'sys' ? 'sys' : 'role');
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = content;
  row.appendChild(bubble);
  msgsEl.appendChild(row);
  scrollBottom();
}

function setQqStatus(result) {
  if (result && result.ok) {
    qqEl.textContent = '已同步到 QQ 私信';
    qqEl.style.color = '#4d9a68';
  } else {
    qqEl.textContent = 'QQ 同步失败';
    qqEl.style.color = '#c26a6a';
    qqEl.title = (result && (result.error || (result.data && result.data.message))) || '请检查 SnowLuma / SurfCore';
  }
}

function setRole(name) {
  if (name) roleName = name;
  titleEl.textContent = '和 ' + roleName + ' 聊天';
  qqEl.textContent = 'QQ 私信同步中…';
  qqEl.style.color = '#8b96ad';
}

async function send() {
  if (sending) return;
  const text = inputEl.value.trim();
  if (!text) return;
  sending = true;
  sendEl.disabled = true;
  inputEl.value = '';
  addMessage('user', text);
  try {
    const result = await api.send(text);
    if (result && result.ok) {
      if (result.roleName) setRole(result.roleName);
      addMessage('role', result.reply);
      setQqStatus(result.qq);
    } else {
      addMessage('sys', '发送失败：' + ((result && result.error) || 'SurfCore 未响应'));
    }
  } catch (error) {
    addMessage('sys', '发送失败：' + (error && error.message ? error.message : error));
  } finally {
    sending = false;
    sendEl.disabled = false;
    inputEl.style.height = '38px';
    inputEl.focus();
    scrollBottom();
  }
}

if (api) {
  api.onInit((data) => {
    const payload = data || {};
    setRole(payload.roleName);
    msgsEl.innerHTML = '';
    const history = Array.isArray(payload.history) ? payload.history : [];
    for (const item of history.slice(-40)) addMessage(item.role, item.text);
    if (!history.length) addMessage('sys', '双击气泡打开的聊天窗口，消息会同步到 QQ 私信。');
    scrollBottom();
    inputEl.focus();
  });
}

sendEl.addEventListener('click', send);
closeEl.addEventListener('click', () => { if (api) api.close(); });
inputEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    send();
  }
});
inputEl.addEventListener('input', () => {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(90, inputEl.scrollHeight) + 'px';
});
