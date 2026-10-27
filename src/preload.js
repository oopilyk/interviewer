const { contextBridge, ipcRenderer } = require("electron");

const listen = (channel) => (cb) => {
  const handler = (_e, payload) => cb(payload);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
};

contextBridge.exposeInMainWorld("overlay", {
  ask: (text, withScreenshot, pdf) => ipcRenderer.invoke("chat:ask", { text, withScreenshot, pdf }),
  solve: (text, pdf) => ipcRenderer.invoke("chat:ask", { text, solve: true, pdf }),
  stop: () => ipcRenderer.invoke("chat:stop"),
  reset: () => ipcRenderer.invoke("chat:reset"),
  getSettings: () => ipcRenderer.invoke("settings:get"),
  setSettings: (patch) => ipcRenderer.invoke("settings:set", patch),
  defaultSystemPrompt: () => ipcRenderer.invoke("settings:default-prompt"),
  getHotkeys: () => ipcRenderer.invoke("hotkeys:get"),
  hide: () => ipcRenderer.invoke("window:hide"),
  quit: () => ipcRenderer.invoke("window:quit"),
  setClickThrough: (on) => ipcRenderer.invoke("window:click-through", on),
  setPointerOnControl: (on) => ipcRenderer.send("window:pointer-on-control", on),
  dragStart: () => ipcRenderer.send("window:drag-start"),
  dragMove: (dx, dy) => ipcRenderer.send("window:drag-move", { dx, dy }),
  dragEnd: () => ipcRenderer.send("window:drag-end"),
  openExternal: (url) => ipcRenderer.invoke("window:open-external", url),

  onStart: listen("chat:start"),
  onScreenshot: listen("chat:screenshot"),
  onDelta: listen("chat:delta"),
  onDone: listen("chat:done"),
  onError: listen("chat:error"),
  onReset: listen("chat:reset"),
  onFocusInput: listen("ui:focus-input"),
  onScreenshotAsk: listen("ui:screenshot-ask"),
  onClickThrough: listen("ui:click-through"),
  onScroll: listen("ui:scroll"),
  onCopied: listen("ui:copied"),
  platform: process.platform,
});
