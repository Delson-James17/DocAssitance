// Dev launcher: runs the backend + Vite together, with keyboard shortcuts.
//   o → open the app in your browser
//   q → quit (also Ctrl+C)
//
// With --electron it also launches the desktop shell against the same Vite
// server, so the renderer keeps hot reload instead of being rebuilt into
// dist/ on every change.
import { spawn } from "node:child_process";
import readline from "node:readline";
import process from "node:process";

const APP_URL = "http://localhost:5173";
const WITH_ELECTRON = process.argv.includes("--electron");

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const BLUE = "\x1b[34m";
const GREEN = "\x1b[32m";
const MAGENTA = "\x1b[35m";
const DIM = "\x1b[2m";

/** @type {import("node:child_process").ChildProcess[]} */
const children = [];
let quitting = false;

// Run a command, prefixing each output line with a coloured [name] tag.
// Defaults to running under this Node binary; `command` overrides that (the
// Electron shell needs its own runtime).
function run(name, args, color, { command = process.execPath, env } = {}) {
  const child = spawn(command, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: env ? { ...process.env, ...env } : process.env,
  });
  const prefix = `${color}[${name}]${RESET} `;

  const forward = (stream, out) =>
    readline
      .createInterface({ input: stream })
      .on("line", (line) => out.write(prefix + line + "\n"));

  forward(child.stdout, process.stdout);
  forward(child.stderr, process.stderr);

  child.on("exit", (code) => {
    if (!quitting) {
      process.stdout.write(prefix + `exited (${code}) — shutting down\n`);
      shutdown(code ?? 1);
    }
  });

  children.push(child);
}

function shutdown(code = 0) {
  if (quitting) return;
  quitting = true;
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  for (const child of children) child.kill();
  process.exit(code);
}

function openBrowser(url) {
  const command =
    process.platform === "win32"
      ? `start "" "${url}"`
      : process.platform === "darwin"
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  spawn(command, { shell: true, stdio: "ignore" });
}

// Electron shows an error page if it loads before Vite is listening, so wait
// for the dev server to actually answer before starting the shell.
async function waitForServer(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(url);
      return true;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  return false;
}

async function startElectron() {
  if (!(await waitForServer(APP_URL))) {
    process.stdout.write("Vite never came up — not starting Electron.\n");
    shutdown(1);
    return;
  }
  // The "electron" package's main export is the path to its binary.
  const { default: electronPath } = await import("electron");
  // VITE_DEV_SERVER_URL is what puts electron/main.js into dev mode: it loads
  // this URL instead of starting its own embedded server.
  run("electron", ["."], MAGENTA, {
    command: electronPath,
    env: { VITE_DEV_SERVER_URL: APP_URL },
  });
}

run("server", ["--watch", "server/index.js"], BLUE);
run("web", ["node_modules/vite/bin/vite.js"], GREEN);
if (WITH_ELECTRON) startElectron();

process.stdout.write(
  `\n  ${BOLD}Voice Doc Assistant — dev${WITH_ELECTRON ? " (desktop)" : ""}${RESET}\n` +
    `  ${DIM}app:${RESET} ${APP_URL}   ` +
    `press ${BOLD}o${RESET} to open the browser, ${BOLD}q${RESET} to quit\n\n`,
);

// Capture single keypresses for the shortcuts.
if (process.stdin.isTTY) {
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.on("keypress", (_str, key) => {
    if (!key) return;
    if (key.name === "o") openBrowser(APP_URL);
    else if (key.name === "q" || (key.ctrl && key.name === "c")) shutdown(0);
  });
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));
