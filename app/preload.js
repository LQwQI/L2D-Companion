'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const isPanel = process.argv.includes('--panel-window');
const isBubble = process.argv.includes('--bubble-window');
const isChat = process.argv.includes('--chat-window');

function listen(channel) {
  return (cb) => {
    const handler = (_event, payload) => cb(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  };
}

const petAPI = {
  ready: (info) => ipcRenderer.send('pet:ready', info),
  error: (message) => ipcRenderer.send('pet:error', message),
  values: (values) => ipcRenderer.send('pet:values', values),
  dragStart: () => ipcRenderer.send('win:drag-start'),
  dragEnd: () => ipcRenderer.send('win:drag-end'),
  resizeStart: () => ipcRenderer.send('win:resize-start'),
  resizeEnd: () => ipcRenderer.send('win:resize-end'),
  resizeBy: (delta) => ipcRenderer.send('win:resize-by', delta),
  contextMenu: () => ipcRenderer.send('win:context-menu'),
  lowerWindow: () => ipcRenderer.send('win:lower'),
  bringToTop: () => ipcRenderer.send('win:bring-top'),
  togglePanel: () => ipcRenderer.send('panel:toggle'),
  panelState: (open) => ipcRenderer.send('pet:panel-state', open),
  setIgnoreMouse: (ignore) => ipcRenderer.send('pet:ignore-mouse', !!ignore),
  showBubble: (payload) => ipcRenderer.send('pet:bubble', payload),
  artMetrics: (metrics) => ipcRenderer.send('pet:artbox', metrics),
  onCursor: listen('cursor'),
  onState: listen('state'),
  onOption: listen('option'),
  onPanelState: listen('panel:state'),
  onParamSet: listen('param:set'),
  onParamReset: listen('param:reset'),
  onParamResetAll: listen('param:reset-all'),
  onExpressionSet: listen('expression:set'),
  onMotionPlay: listen('motion:play'),
  onBackToIdle: listen('motion:idle'),
  onViewReset: listen('view:reset'),
};

const panelAPI = {
  requestInit: () => ipcRenderer.send('panel:init-request'),
  setParam: (id, value) => ipcRenderer.send('panel:param-set', { id, value }),
  resetParam: (id) => ipcRenderer.send('panel:param-reset', { id }),
  resetAll: () => ipcRenderer.send('panel:reset-all'),
  setExpression: (index) => ipcRenderer.send('panel:expression', { index }),
  playMotion: (group, index) => ipcRenderer.send('panel:motion', { group, index }),
  backToIdle: () => ipcRenderer.send('panel:idle'),
  resetView: () => ipcRenderer.send('panel:view-reset'),
  setOption: (key, value) => ipcRenderer.send('panel:option', { key, value }),
  minimize: () => ipcRenderer.send('panel:minimize'),
  close: () => ipcRenderer.send('panel:close'),
  quit: () => ipcRenderer.send('app:quit'),
  importModelFolder: () => ipcRenderer.send('panel:model-import-folder'),
  importModelFile: () => ipcRenderer.send('panel:model-import-file'),
  selectModel: (id) => ipcRenderer.send('panel:model-select', id),
  removeModel: (id) => ipcRenderer.send('panel:model-remove', id),
  rescanModels: () => ipcRenderer.send('panel:model-rescan'),
  openModelFolder: (id) => ipcRenderer.send('panel:model-open', id),
  setModelOption: (key, value) => ipcRenderer.send('panel:model-option', { key, value }),
  surfStatus: () => ipcRenderer.invoke('surf:status'),
  surfRefresh: () => ipcRenderer.invoke('surf:refresh'),
  surfChat: (text) => ipcRenderer.invoke('surf:chat', { text }),
  surfTest: () => ipcRenderer.invoke('surf:test'),
  getApiToken: (action) => ipcRenderer.invoke('surf:token', { action }),
  surfSetOption: (key, value) => ipcRenderer.send('surf:set-option', { key, value }),
  setAutoStart: (on) => ipcRenderer.send('panel:autostart', on),
  surfOpenSettings: () => ipcRenderer.send('surf:open-settings'),
  onSurfState: listen('surf:state'),
  getInteraction: () => ipcRenderer.invoke('interaction:get'),
  saveInteraction: (data) => ipcRenderer.invoke('interaction:save', data),
  testInteractionZone: (index) => ipcRenderer.invoke('interaction:test-zone', index),
  startInteractionPick: () => ipcRenderer.invoke('interaction:pick-start'),
  cancelInteractionPick: () => ipcRenderer.invoke('interaction:pick-cancel'),
  onInteractionCapture: listen('interaction:capture-result'),
  onInit: listen('panel:init'),
  onModelInfo: listen('model-info'),
  onState: listen('state'),
  onValues: listen('values'),
  onPanelState: listen('panel:state'),
};

const bubbleAPI = {
  onShow: listen('bubble:show'),
  onTail: listen('bubble:tail'),
  onHide: listen('bubble:hide'),
  onAdjust: listen('bubble:adjust'),
  sendSize: (width, height) => ipcRenderer.send('bubble:size', { width, height }),
  dblclick: () => ipcRenderer.send('bubble:dblclick'),
};

const chatAPI = {
  onInit: listen('chat:init'),
  send: (text) => ipcRenderer.invoke('chat:send', { text }),
  close: () => ipcRenderer.send('chat:close'),
};

if (isChat) {
  contextBridge.exposeInMainWorld('chatAPI', chatAPI);
}

if (isBubble) {
  contextBridge.exposeInMainWorld('bubbleAPI', bubbleAPI);
} else if (!isPanel) {
  contextBridge.exposeInMainWorld('petAPI', petAPI);
} else {
  contextBridge.exposeInMainWorld('panelAPI', panelAPI);
}
// expose both defensively (harmless; each page only uses one)
try {
  if (!isPanel) contextBridge.exposeInMainWorld('panelAPI', panelAPI);
  if (isPanel) contextBridge.exposeInMainWorld('petAPI', petAPI);
} catch (_) {}
