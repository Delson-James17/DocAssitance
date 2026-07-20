// Dev launcher: runs the backend + Vite together, with keyboard shortcuts.
//   o → open the app in your browser
//   q → quit (also Ctrl+C)
import { spawn } from "node:child_process";
import readline from "node:readline";
import process from "node:process";

const APP_URL = "http://localhost:5173";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const BLUE = "\x1b[34m";
const GREEN = "\x1b[32m";
const DIM = "\x1b[2m";

/** @type {import("node:child_process").ChildProcess[]} */
const children = [];
let quitting = false;

// Run a command, prefixing each output line with a coloured [name] tag.
function run(name, args, color) {
  const child = spawn(process.execPath, args, {
    stdio: ["ignore", "pipe", "pipe"],
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

run("server", ["--watch", "server/index.js"], BLUE);
run("web", ["node_modules/vite/bin/vite.js"], GREEN);

process.stdout.write(
  `\n  ${BOLD}Voice Doc Assistant — dev${RESET}\n` +
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
