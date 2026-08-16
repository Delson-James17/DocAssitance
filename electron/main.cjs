// Electron main process.
//
// Deliberately CommonJS even though the rest of the project is ESM. Electron
// injects its built-in `electron` module by patching CommonJS require(); it
// does not intercept ESM resolution, so in a checkout that has the `electron`
// npm package in node_modules (i.e. any dev machine) `import ... from
// "electron"` resolves to that package instead — which exports the path to
// the binary, not the API. require() always gets the real thing.
//
// The renderer is *not* loaded over file:// — the same Express app that runs
// in the web build is started in-process and bound to 127.0.0.1 on an
// ephemeral port, and the window loads that URL. Two reasons:
//
//   1. Every relative `/api/...` fetch in src/lib/api.ts (including the SSE
//      stream) keeps working unchanged, as does the SPA fallback in
//      server/app.js. No renderer code has to know it's inside Electron.
//   2. http://127.0.0.1 is a secure context, so getUserMedia still works for
//      the microphone. file:// is not, and would break speech capture.
//
// In dev the Vite server (port 5173) already proxies /api to the standalone
// backend on 3000, so we skip the embedded server and just load Vite.
const path = require("node:path");
const fs = require("node:fs");
const { app, BrowserWindow, ipcMain, shell, desktopCapturer, screen } = require("electron");
const dotenv = require("dotenv");
const { createWhisper } = require("./whisper.cjs");

const rootDir = path.resolve(__dirname, "..");

const DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;
const isDev = Boolean(DEV_SERVER_URL);

// --- Environment ----------------------------------------------------------
// A packaged app's cwd is wherever the user launched it from, so the bare
// dotenv.config() in server/config.js can't find the keys on its own. Load
// them here first, before anything imports config.js. dotenv never overwrites
// an already-set variable, so real environment variables still win and the
// first file found takes precedence over later ones.
function loadEnv() {
  const candidates = [
    // Next to the installed .exe. Checked first so it can override, but NOT
    // the recommended spot: the NSIS installer clears the install directory
    // on upgrade, so a .env kept here is silently destroyed every time the
    // app is reinstalled.
    path.join(path.dirname(app.getPath("exe")), ".env"),
    // The durable one — userData is outside the install directory and
    // survives upgrades and uninstalls.
    path.join(app.getPath("userData"), ".env"),
    // Bundled fallback (dev, or a build that shipped with a .env).
    path.join(rootDir, ".env"),
  ];

  for (const file of candidates) {
    if (fs.existsSync(file)) dotenv.config({ path: file });
  }

  // Where the user should put their keys if none were found. The server can't
  // work this out on its own — it has no idea it's inside a packaged app — so
  // it's handed down for the "no API key" message in ask.controller.js.
  // Points at userData, not the install directory: telling someone to put
  // their key somewhere the next upgrade deletes is worse than useless.
  process.env.ENV_FILE_HINT = candidates[1];

  if (!process.env.ANTHROPIC_API_KEY) {
    console.log(`[desktop] no ANTHROPIC_API_KEY found. Looked in:`);
    for (const file of candidates) console.log(`  - ${file}`);
  }
}

/** @type {import("node:http").Server | null} */
let httpServer = null;

const whisper = createWhisper({ isPackaged: app.isPackaged, rootDir });

// --- Window blur mode ------------------------------------------------------
// "clear" = transparent: true (sharp passthrough, no blur — see createWindow).
// "acrylic" = backgroundMaterial: "acrylic" (Windows' frosted-glass blur).
// The two are mutually exclusive Windows/Electron options, and `transparent`
// can't be flipped on a live window — switching modes means destroying the
// window and creating a new one (see ipcMain "window:set-material" below).
// Persisted to a small file rather than passed through the renderer's
// localStorage, since the choice has to be known *before* the window (and
// therefore the renderer) exists.
function materialFilePath() {
  return path.join(app.getPath("userData"), "window-material.json");
}

function loadMaterial() {
  try {
    const raw = JSON.parse(fs.readFileSync(materialFilePath(), "utf8"));
    return raw.material === "acrylic" ? "acrylic" : "clear";
  } catch {
    return "clear";
  }
}

function saveMaterial(material) {
  try {
    fs.writeFileSync(materialFilePath(), JSON.stringify({ material }));
  } catch (err) {
    console.warn("[desktop] could not save window blur preference:", err.message);
  }
}

let windowMaterial = "clear";
/** @type {import("electron").BrowserWindow | null} */
let mainWindow = null;
let appUrl = "";

/**
 * Starts the Express app on a random free port, bound to the loopback
 * interface only. The web build's `app.listen(port)` binds 0.0.0.0, which
 * would expose the API — and the Anthropic key behind it — to the whole
 * local network. A desktop app has no reason to be reachable off-machine.
 *
 * @returns {Promise<string>} the origin to load, e.g. "http://127.0.0.1:51234"
 */
async function startServer() {
  // server/ is ESM, so it can only be pulled in dynamically from here.
  const { createApp } = await import("../server/app.js");

  return new Promise((resolve, reject) => {
    const server = createApp().listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Server did not bind to a TCP port"));
        return;
      }
      httpServer = server;
      console.log(`[desktop] serving on http://127.0.0.1:${address.port}`);
      resolve(`http://127.0.0.1:${address.port}`);
    });
    server.on("error", reject);
  });
}

function createWindow(url, material) {
  // `transparent: true` and `backgroundMaterial` are mutually exclusive on
  // Windows, so which one gets passed below decides the whole window's blur
  // behaviour: true passthrough (desktop shows through crisp, unblurred) vs
  // Acrylic (Windows' frosted glass, a fixed blur radius the OS controls —
  // there's no API to dial it to anything in between). "clear" loses edge
  // hit-testing by default (see the WM_NCHITTEST hook below), which is what
  // restores drag-to-resize for it.
  const isClear = material !== "acrylic";

  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    // Low floor on purpose. The old 900x600 minimum meant the window simply
    // refused to shrink any further — it looked like resizing was broken.
    // The layout collapses to a single column well below this (src/index.css),
    // so the window can be squeezed down beside whatever else is on screen,
    // the way any browser window can.
    minWidth: 380,
    minHeight: 420,
    // An alpha-zero background colour is what lets the desktop show through
    // wherever the page doesn't paint. The Glass theme makes <body>
    // transparent (src/index.css) so the desktop is visible; the Dark and
    // Light themes paint an opaque backdrop over it.
    backgroundColor: "#00000000",
    ...(isClear ? { transparent: true } : { backgroundMaterial: "acrylic" }),
    // The app already draws its own title bar and window buttons, so drop the
    // native frame and the default File/Edit menu rather than showing two
    // sets of chrome stacked on top of each other.
    frame: false,
    // Don't show a white flash while the renderer boots.
    show: false,
    title: "Voice Doc Assistant",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      // Chromium throttles a renderer whose window is minimised, hidden or
      // covered by another window: timers are clamped and the main thread is
      // starved. The audio thread keeps capturing, but the handler that
      // receives those frames (src/lib/mic.ts) barely runs, so continuous
      // listening dies the moment the app isn't in front — which is exactly
      // when it's most useful. This app is meant to keep transcribing while
      // you work in another window, so the throttle has to go.
      backgroundThrottling: false,
    },
  });

  // A transparent BrowserWindow's default edge hit-testing on Windows treats
  // the whole frame as "client area", so dragging the border does nothing —
  // there's no native frame left for Windows to hit-test a resize against.
  // This restores it manually: WM_NCHITTEST fires on every mouse-over, and
  // classifying the cursor's position against the window's edges (via
  // setNextHitTest) is what makes Windows offer its normal resize cursor and
  // drag-to-resize there, same as any framed window gets for free. Acrylic
  // mode doesn't need this — only `transparent: true` breaks the default.
  if (isClear && process.platform === "win32") {
    try {
      const EDGE = 8; // px from the border that still counts as a resize grab
      win.hookWindowMessage(0x0084 /* WM_NCHITTEST */, () => {
        const cursor = screen.getCursorScreenPoint();
        const { x, y, width, height } = win.getBounds();
        const left = cursor.x - x;
        const top = cursor.y - y;
        const right = width - left;
        const bottom = height - top;

        const nearLeft = left <= EDGE;
        const nearRight = right <= EDGE;
        const nearTop = top <= EDGE;
        const nearBottom = bottom <= EDGE;

        if (nearTop && nearLeft) win.setNextHitTest("topleft");
        else if (nearTop && nearRight) win.setNextHitTest("topright");
        else if (nearBottom && nearLeft) win.setNextHitTest("bottomleft");
        else if (nearBottom && nearRight) win.setNextHitTest("bottomright");
        else if (nearLeft) win.setNextHitTest("left");
        else if (nearRight) win.setNextHitTest("right");
        else if (nearTop) win.setNextHitTest("top");
        else if (nearBottom) win.setNextHitTest("bottom");
      });
    } catch (err) {
      console.error("[desktop] could not hook edge resize for the clear window:", err);
    }
  }

  // Privacy-first default: on supported Windows versions this requests
  // WDA_EXCLUDEFROMCAPTURE before the window is shown. The window is still
  // fully visible and interactive on the user's own monitor.
  if (process.platform === "win32" && typeof win.setContentProtection === "function") {
    try {
      win.setContentProtection(true);
    } catch (err) {
      console.warn("[desktop] could not enable capture exclusion by default:", err.message);
    }
  }

  win.once("ready-to-show", () => win.show());

  // The mic prompt has no meaning here — there's no browser chrome to show
  // it in, and the user already granted the app permission at the OS level.
  // Only our own origin is trusted, and only for media.
  const { origin } = new URL(url);

  win.webContents.session.setPermissionRequestHandler(
    (webContents, permission, callback) => {
      callback(permission === "media" && new URL(webContents.getURL()).origin === origin);
    },
  );
  win.webContents.session.setPermissionCheckHandler(
    (_webContents, permission, requestOrigin) =>
      permission === "media" && requestOrigin === origin,
  );

  // Permit only this window's user-initiated display-media request and attach
  // Windows' output loopback track. The renderer cannot select a source or
  // request the microphone through this handler.
  win.webContents.session.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const display = screen.getPrimaryDisplay();
      const sources = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: { width: 1, height: 1 },
      });
      const source = sources.find((item) => item.display_id === String(display.id)) ?? sources[0];
      if (!source) return callback({});
      callback({ video: source, audio: "loopback" });
    } catch (err) {
      console.error("[system-audio] could not start Windows loopback", err);
      callback({});
    }
  });

  // External links open in the real browser rather than replacing the app.
  win.webContents.setWindowOpenHandler(({ url: target }) => {
    if (/^https?:$/.test(new URL(target).protocol)) shell.openExternal(target);
    return { action: "deny" };
  });

  win.webContents.on("will-navigate", (event, target) => {
    if (new URL(target).origin !== origin) {
      event.preventDefault();
      shell.openExternal(target);
    }
  });

  win.loadURL(url);
  if (isDev) win.webContents.openDevTools({ mode: "detach" });

  return win;
}

// A second launch should focus the existing window, not start a second copy
// with its own server and its own microphone.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  // Backs window.desktop.openExternal(). Restricted to http(s) so a
  // compromised renderer can't hand the OS a file:// or custom-scheme URL.
  // The window has no native frame, so the title bar the app draws itself has
  // to do the real work. See .win-controls in src/index.css.
  ipcMain.handle("window:minimize", (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize();
  });

  ipcMain.handle("window:maximize", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return false;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    return win.isMaximized();
  });

  ipcMain.handle("window:close", (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close();
  });

  // --- "Move": pin the window on top -----------------------------------------
  // On by default, so the window behaves like an overlay that survives
  // Alt+Tab without needing a click first — Move is how you turn it back off.
  let alwaysOnTopManual = true;

  function applyAlwaysOnTop(win) {
    // "screen-saver" is the level that stays on top over another app running
    // fullscreen (a call in presentation mode) — the plain "floating" level
    // does not.
    win.setAlwaysOnTop(alwaysOnTopManual, "screen-saver");
  }

  ipcMain.handle("window:toggle-pin", (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win) return false;
    alwaysOnTopManual = !alwaysOnTopManual;
    applyAlwaysOnTop(win);
    return alwaysOnTopManual;
  });

  // --- Window blur mode: Acrylic (frosted) vs Clear (sharp passthrough) ----
  // `transparent` can't be toggled on a live BrowserWindow, so switching
  // modes tears down the current window and builds a new one in its place,
  // carrying over its size/position/maximized state so it doesn't jump.
  ipcMain.handle("window:get-material", () => windowMaterial);

  ipcMain.handle("window:set-material", (_event, material) => {
    if (material !== "acrylic" && material !== "clear") return windowMaterial;
    windowMaterial = material;
    saveMaterial(material);
    if (!appUrl) return windowMaterial;

    const old = mainWindow;
    const bounds = old?.getBounds();
    const wasMaximized = old?.isMaximized() ?? false;

    const next = createWindow(appUrl, windowMaterial);
    if (bounds) next.setBounds(bounds);
    if (wasMaximized) next.maximize();
    applyAlwaysOnTop(next);
    next.once("ready-to-show", () => old?.destroy());
    mainWindow = next;

    return windowMaterial;
  });

  // Electron maps this to SetWindowDisplayAffinity on Windows. Modern
  // Windows 10/11 use WDA_EXCLUDEFROMCAPTURE; older Windows releases and
  // some capture programs may not honour it, so this is a best-effort request.
  // It never hides, minimises, or otherwise changes the local window.
  ipcMain.handle("window:set-content-protection", (event, enabled) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    if (!win || typeof enabled !== "boolean") {
      return { ok: false, enabled: false, reason: "Window is unavailable." };
    }
    if (process.platform !== "win32" || typeof win.setContentProtection !== "function") {
      return {
        ok: false,
        enabled: false,
        reason: "Screen-sharing exclusion is only available in the Windows desktop app.",
      };
    }
    try {
      win.setContentProtection(enabled);
      return {
        ok: true,
        enabled,
        reason: enabled
          ? "Capture exclusion requested. Some Windows versions and capture apps may not support it."
          : "Capture exclusion turned off.",
      };
    } catch (err) {
      return {
        ok: false,
        enabled: false,
        reason: `Could not change capture exclusion: ${err.message}`,
      };
    }
  });

  // --- Screenshot question --------------------------------------------------
  // Captures the screen so a question displayed visually (a shared doc, a
  // coding platform, a slide) can be answered the same way a spoken one is.
  // The app's own window is hidden for the capture and restored right after
  // — otherwise, especially with Move's always-on-top pin, the screenshot
  // would just be a photo of this app instead of whatever is behind it.
  ipcMain.handle("screenshot:capture", async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const wasVisible = win?.isVisible() ?? false;
    try {
      if (wasVisible) win.hide();
      // Give the compositor a moment to repaint without this window before
      // the capture below reads the screen.
      if (wasVisible) await new Promise((resolve) => setTimeout(resolve, 200));

      const display = screen.getPrimaryDisplay();
      const scaleFactor = display.scaleFactor || 1;
      const sources = await desktopCapturer.getSources({
        types: ["screen"],
        thumbnailSize: {
          width: Math.round(display.size.width * scaleFactor),
          height: Math.round(display.size.height * scaleFactor),
        },
      });
      const source =
        sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
      if (!source) return { error: "No screen source was available to capture." };

      return { dataUrl: source.thumbnail.toDataURL() };
    } catch (err) {
      return { error: err.message };
    } finally {
      if (wasVisible) win.show();
    }
  });

  ipcMain.handle("desktop:open-external", (_event, target) => {
    if (typeof target !== "string") return false;
    let protocol;
    try {
      ({ protocol } = new URL(target));
    } catch {
      return false;
    }
    if (protocol !== "http:" && protocol !== "https:") return false;
    shell.openExternal(target);
    return true;
  });

  // --- Local speech-to-text -----------------------------------------------
  // Transcription runs in this process because whisper.cpp is a native binary
  // the renderer can't reach. The renderer captures the audio and segments it
  // into utterances (src/lib/mic.ts); each one arrives here as WAV bytes.
  ipcMain.handle("speech:check", () => {
    const error = whisper.unavailableReason();
    return error ? { ok: false, error } : { ok: true };
  });

  ipcMain.handle("speech:warm-up", async () => {
    try {
      await whisper.start();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle("speech:transcribe", async (_event, wav, language) => {
    try {
      return { text: await whisper.transcribe(Buffer.from(wav), language) };
    } catch (err) {
      console.error("[whisper]", err);
      return { error: err.message };
    }
  });

  app.whenReady().then(async () => {
    loadEnv();
    windowMaterial = loadMaterial();
    appUrl = isDev ? DEV_SERVER_URL : await startServer();
    mainWindow = createWindow(appUrl, windowMaterial);
    applyAlwaysOnTop(mainWindow);

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createWindow(appUrl, windowMaterial);
        applyAlwaysOnTop(mainWindow);
      }
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });

  app.on("before-quit", () => {
    httpServer?.close();
    httpServer = null;
    // Without this the whisper-server child outlives the app and keeps the
    // model in memory.
    whisper.stop();
  });
}
