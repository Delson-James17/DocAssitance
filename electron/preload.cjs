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
  /**
   * Opens the auto-saved logs folder (see app:save-logs-and-close on close)
   * in Explorer. Creates the folder first if no session has ever closed
   * with something to save yet, so this never opens nothing.
   * @returns {Promise<boolean>}
   */
  openLogsFolder: () => ipcRenderer.invoke("app:open-logs-folder"),

  // The window is frameless, so the app's own title bar drives these.
  window: {
    minimize: () => ipcRenderer.invoke("window:minimize"),
    /** @returns {Promise<boolean>} whether the window ended up maximized */
    toggleMaximize: () => ipcRenderer.invoke("window:maximize"),
    close: () => ipcRenderer.invoke("window:close"),
    /**
     * Registers the callback that runs once, right before the window
     * actually closes (however that close was triggered — the close
     * button, Alt+F4, closing from the taskbar). main.cjs intercepts the
     * real close to give this a chance to run first; call saveLogsAndClose
     * from inside it to let the close proceed.
     * @param {() => void | Promise<void>} handler
     * @returns {() => void} unsubscribe
     */
    onBeforeClose: (handler) => {
      const listener = () => void handler();
      ipcRenderer.on("app:will-close", listener);
      return () => ipcRenderer.removeListener("app:will-close", listener);
    },
    /**
     * Writes this session's logs (if any — either string may be empty) to
     * the app's own logs folder, then lets the close that's been waiting on
     * onBeforeClose's handler actually proceed.
     * @param {{ fullText: string, qaText: string }} payload
     */
    saveLogsAndClose: (payload) => ipcRenderer.invoke("app:save-logs-and-close", payload),
    /**
     * "Move": pins the window on top of every other window, so it stays
     * visible even after alt-tabbing away.
     * @returns {Promise<boolean>} whether the window is now pinned
     */
    togglePin: () => ipcRenderer.invoke("window:toggle-pin"),
    /** Requests Windows capture exclusion without hiding the local window. */
    setContentProtection: (enabled) =>
      ipcRenderer.invoke("window:set-content-protection", enabled),
    /**
     * Hold-Shift-to-click-through: fades the window out and passes clicks to
     * whatever's behind it. Restores the instant Shift is physically
     * released, even after clicking into another app moves keyboard focus
     * away — main.cjs polls Windows' real key state (GetAsyncKeyState) for
     * this rather than relying only on this renderer's own keyup, which
     * would otherwise never fire once focus is gone.
     */
    setClickThrough: (enabled) => ipcRenderer.invoke("window:set-clickthrough", enabled),
    /**
     * Window blur mode: "acrylic" (frosted glass) or "clear" (sharp
     * passthrough, no blur). Switching rebuilds the native window, so expect
     * a brief flash while the new one replaces the old.
     * @returns {Promise<"acrylic" | "clear">}
     */
    getMaterial: () => ipcRenderer.invoke("window:get-material"),
    /** @returns {Promise<"acrylic" | "clear">} the material that's now active */
    setMaterial: (material) => ipcRenderer.invoke("window:set-material", material),
    /**
     * Manual resize support for Clear mode, where the window is transparent
     * and Windows won't hit-test a drag on its border on its own (see
     * main.cjs). getBounds/setBounds are the two primitives
     * ResizeHandles.tsx drives from a pointer-capture drag.
     * @returns {Promise<{ x: number, y: number, width: number, height: number } | null>}
     */
    getBounds: () => ipcRenderer.invoke("window:get-bounds"),
    setBounds: (bounds) => ipcRenderer.invoke("window:set-bounds", bounds),
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
