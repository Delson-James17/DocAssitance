// Local speech-to-text, via whisper.cpp running on this machine.
//
// Nothing is sent to a cloud service and there is no per-minute cost. The
// trade-off versus a streaming cloud recognizer is that Whisper transcribes a
// *finished* chunk of audio rather than a live stream, so the renderer does
// the voice-activity detection and hands over one utterance at a time (see
// src/lib/mic.ts).
//
// whisper-server is used instead of whisper-cli because the CLI reloads the
// ~150MB model on every invocation — about 1.5s of pure overhead per
// utterance. The server keeps it resident, so only inference is paid for.
const path = require("node:path");
const fs = require("node:fs");
const os = require("node:os");
const net = require("node:net");
const { spawn } = require("node:child_process");

const IS_WINDOWS = process.platform === "win32";
const SERVER_EXE = IS_WINDOWS ? "whisper-server.exe" : "whisper-server";

// Encoder context, in Whisper's mel frames. The full 1500 frames is 30
// seconds; 512 is about 10. Audio beyond this is not transcribed, so
// src/lib/mic.ts caps an utterance below AUDIO_CTX_SECONDS.
const AUDIO_CTX = 512;
/** Roughly how much audio AUDIO_CTX covers. 1500 frames === 30s. */
const AUDIO_CTX_SECONDS = Math.floor((AUDIO_CTX / 1500) * 30);

// Whisper emits bracketed markers for things that aren't speech —
// "[BLANK_AUDIO]", "(silence)", "*coughs*". They're noise for our purposes:
// an utterance that transcribes to nothing but these should be dropped, not
// turned into a question.
const NON_SPEECH = /\[[^\]]*\]|\([^)]*\)|\*[^*]*\*/g;

// Whisper was trained on a lot of subtitled video, so when it's handed audio
// with no real speech in it, it doesn't return nothing — it returns the most
// common thing in that training data. These are the phrases it invents out of
// silence. Dropping them costs almost nothing: none of them is a question, so
// none would ever have produced a useful answer.
const HALLUCINATIONS = new Set([
  "you",
  "thank you",
  "thanks",
  "thank you very much",
  "thanks for watching",
  "thank you for watching",
  "thanks for watching my video",
  "please subscribe",
  "subscribe",
  "like and subscribe",
  "bye",
  "goodbye",
  "bye bye",
  "f love",
  "the end",
  "to be continued",
  "music",
  "applause",
  "silence",
]);

/**
 * True when a transcript is one of Whisper's silence artifacts rather than
 * something the user actually said.
 *
 * @param {string} text
 */
function isHallucination(text) {
  const normalized = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();

  // Punctuation-only results ("." or "...") are always noise.
  if (!normalized) return true;
  return HALLUCINATIONS.has(normalized);
}

/**
 * Resolves where the binaries and model live. In development that's
 * vendor/whisper (populated by scripts/fetch-whisper.mjs); in a packaged app
 * electron-builder copies the same tree into the app's resources directory.
 *
 * @param {boolean} isPackaged
 * @param {string} rootDir
 */
function resolveAssets(isPackaged, rootDir) {
  const base = isPackaged
    ? path.join(process.resourcesPath, "whisper")
    : path.join(rootDir, "vendor", "whisper");

  const binDir = path.join(base, "bin");
  const modelsDir = path.join(base, "models");

  const exe = path.join(binDir, SERVER_EXE);
  // Whichever model the user downloaded — the fetch script can install tiny,
  // base, or small, and we shouldn't care which.
  const model = fs.existsSync(modelsDir)
    ? fs
        .readdirSync(modelsDir)
        .filter((f) => f.startsWith("ggml-") && f.endsWith(".bin"))
        .map((f) => path.join(modelsDir, f))[0]
    : undefined;

  return { binDir, exe, model };
}

/** Asks the OS for a free port by binding one and immediately releasing it. */
function freePort() {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

/**
 * Manages the whisper-server child process and turns audio into text.
 *
 * @param {{ isPackaged: boolean, rootDir: string }} options
 */
function createWhisper({ isPackaged, rootDir }) {
  const assets = resolveAssets(isPackaged, rootDir);

  /** @type {import("node:child_process").ChildProcess | null} */
  let child = null;
  /** @type {Promise<string> | null} */
  let starting = null;

  /** Why speech can't run, or null if it can. */
  function unavailableReason() {
    if (!fs.existsSync(assets.exe)) {
      return "Speech engine not installed. Run `npm run whisper:setup`.";
    }
    if (!assets.model) {
      return "No Whisper model found. Run `npm run whisper:setup`.";
    }
    return null;
  }

  async function waitUntilReady(port, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (child === null || child.exitCode !== null) {
        throw new Error("Speech engine stopped while starting up.");
      }
      try {
        // Any HTTP answer means it's accepting connections; the path itself
        // doesn't matter.
        await fetch(`http://127.0.0.1:${port}/`, { method: "GET" });
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    throw new Error("Speech engine did not start in time.");
  }

  /** Boots the server if it isn't already up. Safe to call repeatedly. */
  function start() {
    if (starting) return starting;

    const reason = unavailableReason();
    if (reason) return Promise.reject(new Error(reason));

    starting = (async () => {
      const port = await freePort();

      child = spawn(
        assets.exe,
        [
          "--model", assets.model,
          "--host", "127.0.0.1",
          "--port", String(port),
          // Whisper is CPU-bound here; give it the machine's cores. (Measured:
          // halving the thread count roughly doubles the time, so use them all.)
          "--threads", String(Math.max(2, os.cpus().length)),

          // The single biggest speed win. Whisper's encoder always runs over a
          // 30-second window no matter how short the clip is, so a 4-second
          // question pays for 26 seconds of silence. Shrinking the audio
          // context to ~10s of frames cut a 4s utterance from 3028ms to
          // 1094ms on a Ryzen 5 3500U — 2.8x — with byte-identical output.
          //
          // The cost: audio past roughly AUDIO_CTX_SECONDS is ignored, which
          // is why src/lib/mic.ts must never hand over a longer segment.
          "--audio-ctx", String(AUDIO_CTX),
          // Greedy decoding. No measurable accuracy change here, and it drops
          // the candidate search.
          "--best-of", "1",
          // Do NOT pass --suppress-nst. It suppresses the "[BLANK_AUDIO]"
          // token, which sounds desirable but is actively harmful: with the
          // marker suppressed the model has to emit *some* word for silent
          // audio, and it picks a hallucinated one ("you", "Thank you.").
          // Leaving it on means silence is clearly labelled and easy to drop.
          //
          // Skip temperature fallback — re-decoding failed audio at higher
          // temperatures is a major source of invented text.
          "--no-fallback",
        ],
        { cwd: assets.binDir, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
      );

      child.stderr.on("data", (buf) => {
        const line = buf.toString().trim();
        if (line) console.log(`[whisper] ${line}`);
      });

      child.on("exit", (code) => {
        if (code !== 0 && code !== null) console.log(`[whisper] exited (${code})`);
        child = null;
        starting = null;
      });

      await waitUntilReady(port);
      console.log(`[whisper] ready on 127.0.0.1:${port} (${path.basename(assets.model)})`);
      return `http://127.0.0.1:${port}`;
    })();

    // A failed start shouldn't poison every later attempt.
    starting.catch(() => {
      starting = null;
    });

    return starting;
  }

  return {
    unavailableReason,
    start,

    /**
     * Transcribes one utterance.
     *
     * @param {Buffer} wav 16kHz mono WAV, as produced by src/lib/mic.ts
     * @param {string} language Whisper language code ("en", "tl", or "auto")
     * @returns {Promise<string>} the transcript, or "" if it was only noise
     */
    async transcribe(wav, language) {
      const origin = await start();

      const form = new FormData();
      form.append("file", new Blob([wav], { type: "audio/wav" }), "audio.wav");
      form.append("language", language);
      form.append("response_format", "json");
      // Whisper will happily invent text for silence; this keeps it honest.
      form.append("temperature", "0");

      const res = await fetch(`${origin}/inference`, { method: "POST", body: form });
      if (!res.ok) {
        throw new Error(`Transcription failed (${res.status})`);
      }

      const data = await res.json();
      // Whisper breaks its output into timestamped segments, so the text
      // arrives with newlines mid-sentence — collapse them, or an utterance
      // reaches the matcher as "what your country can\n do for you".
      const text = (data?.text ?? "")
        .replace(NON_SPEECH, "")
        .replace(/\s+/g, " ")
        .trim();

      return isHallucination(text) ? "" : text;
    },

    stop() {
      if (child) child.kill();
      child = null;
      starting = null;
    },
  };
}

module.exports = { createWhisper, AUDIO_CTX_SECONDS };
