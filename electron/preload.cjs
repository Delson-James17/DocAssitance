// Preload script — the only bridge between the renderer and Node.
//
// CommonJS for the same reason as main.cjs: Electron's built-in module is
// injected through require(), not through ESM resolution.
//
// The renderer is a normal web app talking to a normal HTTP API, so it needs
// very little from here. Everything exposed is a plain value or a one-way
// call; no ipcRenderer object is handed over, so the renderer can't reach
// arbitrary channels.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktop", {
  isElectron: true,
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
  /** Opens a URL in the user's default browser instead of in the app. */
  openExternal: (url) => ipcRenderer.invoke("desktop:open-external", url),

  // The window is frameless, so the app's own title bar drives these.
  window: {
    minimize: () => ipcRenderer.invoke("window:minimize"),
    /** @returns {Promise<boolean>} whether the window ended up maximized */
    toggleMaximize: () => ipcRenderer.invoke("window:maximize"),
    close: () => ipcRenderer.invoke("window:close"),
    /**
     * "Move": pins the window on top of every other window, so it stays
     * visible even after alt-tabbing away.
     * @returns {Promise<boolean>} whether the window is now pinned
     */
    togglePin: () => ipcRenderer.invoke("window:toggle-pin"),
  },

  // Screenshot question: captures the screen so a question shown visually
  // (not spoken) can be answered the same way. Desktop-only — the web build
  // has no OS-level screen capture to call, so the button that triggers this
  // stays disabled when `desktop.screenshot` is undefined.
  screenshot: {
    /** @returns {Promise<{ dataUrl?: string, error?: string }>} */
    capture: () => ipcRenderer.invoke("screenshot:capture"),
  },

  // Local speech-to-text (whisper.cpp). Only available in the desktop app —
  // the web build has no equivalent, and src/hooks/useSpeechRecognition.ts
  // falls back to "voice unavailable" when `desktop` is undefined.
  speech: {
    /** @returns {Promise<{ ok: boolean, error?: string }>} */
    check: () => ipcRenderer.invoke("speech:check"),
    /** Warms up the model so the first utterance isn't slow. */
    warmUp: () => ipcRenderer.invoke("speech:warm-up"),
    /**
     * @param {ArrayBuffer} wav 16kHz mono WAV
     * @param {string} language Whisper code, e.g. "en" or "tl"
     * @returns {Promise<{ text?: string, error?: string }>}
     */
    transcribe: (wav, language) =>
      ipcRenderer.invoke("speech:transcribe", wav, language),
  },
});
