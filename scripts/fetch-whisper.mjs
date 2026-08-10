// Downloads the whisper.cpp runtime + a GGML model into vendor/whisper/.
//
// Speech-to-text runs entirely on this machine, so the app needs two things
// that are far too big to keep in git (~150MB): the prebuilt whisper.cpp
// binaries and a model file. This script fetches both, and is safe to re-run —
// anything already present is left alone.
//
//   npm run whisper:setup             # default model (base)
//   npm run whisper:setup -- tiny     # faster, less accurate
//   npm run whisper:setup -- small    # slower, best Filipino accuracy
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const WHISPER_VERSION = "v1.9.1";
const DEFAULT_MODEL = "base";

// Only the files whisper-server actually needs. The release zip also carries
// ~20 unrelated executables (tests, parakeet, SDL-based demos) that would
// otherwise be dead weight in the installer.
const KEEP = [/^whisper-server\.exe$/i, /^whisper\.dll$/i, /^ggml.*\.dll$/i];

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vendorDir = path.join(rootDir, "vendor", "whisper");
const binDir = path.join(vendorDir, "bin");
const modelsDir = path.join(vendorDir, "models");

const model = (process.argv[2] ?? DEFAULT_MODEL).replace(/^ggml-|\.bin$/g, "");

function log(msg) {
  process.stdout.write(`[whisper] ${msg}\n`);
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`GET ${url} → ${res.status}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

// The release assets are per-platform. Windows is the one this project
// packages for; the others are listed so a build on that platform can still
// find the right archive rather than silently doing nothing.
function assetFor(platform) {
  if (platform === "win32") {
    return {
      name: "whisper-bin-x64.zip",
      // whisper-server needs no extra runtime beyond the DLLs beside it.
      extract: (zip, into) => {
        const staging = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-"));
        execFileSync(
          "powershell",
          [
            "-NoProfile",
            "-Command",
            `Expand-Archive -LiteralPath "${zip}" -DestinationPath "${staging}" -Force`,
          ],
          { stdio: "inherit" },
        );
        // The zip nests everything under Release/.
        const files = [];
        const walk = (dir) => {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) walk(full);
            else files.push(full);
          }
        };
        walk(staging);

        fs.mkdirSync(into, { recursive: true });
        let copied = 0;
        for (const file of files) {
          const base = path.basename(file);
          if (!KEEP.some((re) => re.test(base))) continue;
          fs.copyFileSync(file, path.join(into, base));
          copied++;
        }
        fs.rmSync(staging, { recursive: true, force: true });
        return copied;
      },
    };
  }

  if (platform === "linux") {
    return {
      name: "whisper-bin-ubuntu-x64.tar.gz",
      extract: (archive, into) => {
        fs.mkdirSync(into, { recursive: true });
        execFileSync("tar", ["-xzf", archive, "-C", into, "--strip-components=1"], {
          stdio: "inherit",
        });
        return fs.readdirSync(into).length;
      },
    };
  }

  return null;
}

async function fetchBinaries() {
  const serverExe = path.join(binDir, process.platform === "win32" ? "whisper-server.exe" : "whisper-server");
  if (fs.existsSync(serverExe)) {
    log(`binaries already present in ${path.relative(rootDir, binDir)} — skipping`);
    return;
  }

  const asset = assetFor(process.platform);
  if (!asset) {
    throw new Error(
      `No prebuilt whisper.cpp release for ${process.platform}. Build it from ` +
        `source (https://github.com/ggml-org/whisper.cpp) and put whisper-server ` +
        `plus its libraries in ${path.relative(rootDir, binDir)}.`,
    );
  }

  const url = `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_VERSION}/${asset.name}`;
  const archive = path.join(os.tmpdir(), asset.name);

  log(`downloading whisper.cpp ${WHISPER_VERSION} (${asset.name})`);
  await download(url, archive);
  const copied = asset.extract(archive, binDir);
  fs.rmSync(archive, { force: true });
  log(`installed ${copied} runtime files → ${path.relative(rootDir, binDir)}`);
}

async function fetchModel() {
  const dest = path.join(modelsDir, `ggml-${model}.bin`);
  if (fs.existsSync(dest)) {
    log(`model ${model} already present — skipping`);
    return;
  }

  const url = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-${model}.bin`;
  log(`downloading model "${model}" — this is the big one, please wait`);
  await download(url, dest);
  const mb = (fs.statSync(dest).size / 1048576).toFixed(0);
  log(`installed ggml-${model}.bin (${mb}MB) → ${path.relative(rootDir, modelsDir)}`);
}

try {
  await fetchBinaries();
  await fetchModel();
  log("ready — voice input will work in the desktop app");
} catch (err) {
  process.stderr.write(`[whisper] ${err.message}\n`);
  process.exit(1);
}
