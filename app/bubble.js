'use strict';

const api = window.bubbleAPI;
const bubble = document.getElementById('bubble');
let lastSize = '';

function reportSize() {
  const w = Math.max(60, Math.ceil(bubble.offsetWidth) + 8);
  const h = Math.max(30, Math.ceil(bubble.offsetHeight) + 16);
  const key = w + 'x' + h;
  if (key === lastSize) return;
  lastSize = key;
  if (api) api.sendSize(w, h);
}

function scheduleMeasure() {
  requestAnimationFrame(() => requestAnimationFrame(reportSize));
}

if (api) {
  api.onShow((payload) => {
    if (!payload) return;
    const adjustable = !!payload.adjustable;
    document.body.classList.toggle('adjustable', adjustable);
    bubble.textContent = String(payload.text || '');
    lastSize = '';
    scheduleMeasure();
  });

  api.onTail((payload) => {
    if (!payload) return;
    bubble.dataset.tail = payload.tail || 'bottom';
  });

  api.onHide(() => {
    document.body.classList.remove('adjustable');
  });
}

window.addEventListener('resize', () => {
  lastSize = '';
  scheduleMeasure();
});

window.addEventListener('dblclick', () => { if (window.bubbleAPI && window.bubbleAPI.dblclick) window.bubbleAPI.dblclick(); });
