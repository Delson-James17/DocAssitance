import { useCallback, useEffect, useRef, useState } from "react";
import { startMic, type MicSession } from "../lib/mic";
import { startSystemAudio } from "../lib/systemAudio";
import { detectSpeechLang, type SpeechLang } from "../lib/detectLang";

/**
 * Where speech comes from.
 *
 * "headset" is the original mode: it loops back whatever Windows is playing
 * (see systemAudio.ts), which is why it "just works" while wearing
 * headphones — nothing the headphones play leaks back into the microphone,
 * so there's no feedback to filter out.
 *
 * Without headphones, the same audio comes out of the speakers and straight
 * back into the mic, so looping back system audio would transcribe the
 * meeting *and* its own echo. "mic" captures the microphone directly
 * instead — the input device changes, but everything downstream (VAD, PCM,
 * WAV framing in mic.ts) is identical either way.
 */
export type AudioSource = "headset" | "mic";

// --- Why not the Web Speech API? ------------------------------------------
// This used to be built on window.webkitSpeechRecognition. That API doesn't
// work in Electron: Chrome's implementation calls a Google speech service
// using private API keys that are baked into official Chrome builds and
// can't be redistributed, so in Electron the recognizer starts and then
// immediately fails with error "network". There's no flag that turns it on.
//
// Speech now runs locally through whisper.cpp in the main process — no cloud
// service, no per-minute cost, and it works offline. The visible trade-off is
// that Whisper transcribes a *finished* utterance rather than streaming, so
// there's no word-by-word interim text: `interim` reports the state of the
// current utterance ("…" while speaking, "" otherwise) instead of a partial
// transcript. Everything else about the hook's shape is unchanged.

/** Whisper wants ISO-639-1; the app tracks BCP-47 for display. */
const WHISPER_LANG: Record<SpeechLang, string> = {
  "en-US": "en",
  "fil-PH": "tl",
};

/**
 * How long to wait after someone stops speaking before deciding the message
 * is finished.
 *
 * People pause between sentences. The microphone gate (src/lib/mic.ts) has to
 * cut on those pauses — that's what lets transcription start straight away
 * instead of waiting for the whole monologue — but each cut used to become its
 * own entry, so one spoken introduction arrived as five fragments and the Q&A
 * matcher only ever saw a piece of the question.
 *
 * So the cut and the *message boundary* are now two different things: audio is
 * still cut early and transcribed eagerly, and the resulting pieces are glued
 * back together unless the speaker really has finished.
 *
 * This window is measured from the moment speech stopped, and runs at the same
 * time as transcription rather than after it. When transcription takes longer
 * than the window — the normal case on a slower machine — merging is free.
 *
 * It is deliberately long enough to survive a *whole speaking turn*, not just
 * one sentence. Someone asking a multi-part question breathes between clauses
 * ("...technical questions," pause, "could you please introduce yourself")
 * and those gaps routinely pass a second. For meeting questions, the audio
 * gate already waits for a real silence before handing Whisper a chunk, so an
 * additional message-gap delay only makes a completed question feel late.
 *
 * This is the main speed/completeness dial. Lower it for a snappier reply at
 * the cost of chopping long questions into pieces.
 */
const MESSAGE_GAP_MS = 0;

/**
 * Hard ceiling on a single message, so an uninterrupted monologue eventually
 * gets handed over instead of growing without bound.
 */
const MAX_MESSAGE_MS = 90_000;

interface DesktopSpeech {
  check: () => Promise<{ ok: boolean; error?: string }>;
  warmUp: () => Promise<{ ok: boolean; error?: string }>;
  transcribe: (
    wav: ArrayBuffer,
    language: string,
  ) => Promise<{ text?: string; error?: string }>;
}

function getSpeech(): DesktopSpeech | null {
  return (window as unknown as { desktop?: { speech?: DesktopSpeech } }).desktop
    ?.speech ?? null;
}

interface UseSpeechRecognition {
  supported: boolean;
  /** Windows is still opening the output-audio stream; do not speak yet. */
  starting: boolean;
  listening: boolean;
  /** "…" while an utterance is in progress — see the note above. */
  interim: string;
  finalText: string;
  /** Which language the recognizer is currently listening for — adapts
   * automatically based on what gets transcribed (see detectLang.ts). */
  activeLang: SpeechLang;
  /** Why speech is unavailable, or the last recognition error. */
  error: string | null;
  toggle: () => void;
}

// Continuously transcribes speech and calls `onFinalUtterance` for each
// completed sentence. Automatically switches between English and Filipino
// recognition based on the language each utterance looks like — Whisper is
// told which language to expect, so this adapts going forward rather than
// detecting both simultaneously.
export interface SpeechOptions {
  /** Re-transcribe speech as it's spoken. Costs CPU — see useAppearance. */
  liveCaption?: boolean;
  /** Which device to listen on — see the AudioSource doc comment above. */
  source?: AudioSource;
}

export function useSpeechRecognition(
  onFinalUtterance: (utterance: string) => void,
  options: SpeechOptions = {},
): UseSpeechRecognition {
  const [supported, setSupported] = useState(false);
  const [starting, setStarting] = useState(false);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [finalText, setFinalText] = useState("");
  const [activeLang, setActiveLang] = useState<SpeechLang>("en-US");
  const [error, setError] = useState<string | null>(null);

  const sessionRef = useRef<MicSession | null>(null);
  // How many utterances are being transcribed right now — speaking a second
  // sentence while the first is still in flight must not clear the indicator.
  const pendingRef = useRef(0);
  // Guards the async gap between "open the mic" and "the mic is open".
  const startingRef = useRef(false);
  // Mirrors `listening` for the async callbacks below, which would otherwise
  // close over a stale value.
  const listeningRef = useRef(false);

  // --- Message assembly (see MESSAGE_GAP_MS) ---
  /** Transcribed pieces of the message currently being spoken. */
  const partsRef = useRef<string[]>([]);
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** When speech last stopped — the message-gap window counts from here. */
  const lastSpeechEndRef = useRef(0);
  /** When the current message began, for the MAX_MESSAGE_MS ceiling. */
  const messageStartRef = useRef(0);
  const speakingRef = useRef(false);
  /** Live transcription of the piece currently being spoken. */
  const partialRef = useRef("");
  /** True while a preview is being transcribed, so they can't pile up. */
  const partialBusyRef = useRef(false);
  // Read inside the audio callback, so toggling the setting takes effect
  // immediately instead of needing the microphone restarted.
  const liveCaptionRef = useRef(false);
  liveCaptionRef.current = options.liveCaption === true;
  // Read when toggle() opens a new session, so switching the setting takes
  // effect on the next Play rather than needing anything else to change.
  const sourceRef = useRef<AudioSource>("headset");
  sourceRef.current = options.source ?? "headset";
  // Read inside the audio callback, which outlives any single render.
  const langRef = useRef<SpeechLang>(activeLang);
  langRef.current = activeLang;
  const callbackRef = useRef(onFinalUtterance);
  callbackRef.current = onFinalUtterance;

  // Is voice input possible at all? Two ways it isn't: this is the web build
  // (no desktop bridge), or the engine hasn't been downloaded yet. Both are
  // worth saying out loud, because they need completely different fixes.
  useEffect(() => {
    let cancelled = false;

    (async () => {
      const speech = getSpeech();
      if (!speech) {
        if (!cancelled) {
          setError(
            "Voice input needs the desktop app — speech recognition runs locally.",
          );
        }
        return;
      }
      const mediaApi =
        sourceRef.current === "mic"
          ? navigator.mediaDevices?.getUserMedia
          : navigator.mediaDevices?.getDisplayMedia;
      if (!mediaApi) {
        if (!cancelled) {
          setError(
            sourceRef.current === "mic"
              ? "Microphone capture is unavailable in this Electron build."
              : "System-audio capture is unavailable in this Electron build.",
          );
        }
        return;
      }

      const result = await speech.check();
      if (cancelled) return;
      if (result.ok) {
        setSupported(true);
        setError(null);
        // Starting whisper here means the first meeting sentence does not
        // wait for the model process to boot after the user presses Play.
        void speech.warmUp();
      } else {
        setError(result.error ?? "Speech engine unavailable.");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  // Stop the Windows loopback stream if the component goes away mid-session.
  useEffect(() => {
    return () => {
      sessionRef.current?.stop();
      sessionRef.current = null;
      if (flushTimerRef.current) clearTimeout(flushTimerRef.current);
    };
  }, []);

  /**
   * The caption as it currently stands: everything already transcribed, plus
   * the live guess at whatever is being said right now.
   */
  const refreshInterim = useCallback(() => {
    const text = [...partsRef.current, partialRef.current]
      .filter(Boolean)
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    setInterim(text || (speakingRef.current ? "…" : ""));
  }, []);

  /** Hands the assembled message over as one utterance. */
  const emitMessage = useCallback(() => {
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }

    const message = partsRef.current.join(" ").replace(/\s+/g, " ").trim();
    partsRef.current = [];
    partialRef.current = "";
    messageStartRef.current = 0;
    setInterim("");
    if (!message) return;

    setFinalText((prev) => prev + message + " ");
    callbackRef.current(message);

    // Adapt the recognition language for the *next* message based on what
    // this one looked like.
    const detected = detectSpeechLang(message);
    setActiveLang((current) => (detected !== current ? detected : current));
  }, []);

  /**
   * Emits once the speaker has been quiet for MESSAGE_GAP_MS and nothing is
   * still transcribing. Called after every piece; each call re-arms the timer,
   * so a message only lands when the pause is genuinely a full stop.
   */
  const scheduleFlush = useCallback(() => {
    if (flushTimerRef.current) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    // Still talking, or a piece is still in the transcriber — the message
    // isn't over. Whichever finishes last will re-arm this.
    if (speakingRef.current || pendingRef.current > 0) return;
    if (partsRef.current.length === 0) return;

    // A monologue that never pauses would otherwise never be handed over.
    if (messageStartRef.current && Date.now() - messageStartRef.current > MAX_MESSAGE_MS) {
      emitMessage();
      return;
    }

    // Count from when speech stopped, not from now, so the time already spent
    // transcribing counts towards the gap instead of being added to it.
    const elapsed = Date.now() - lastSpeechEndRef.current;
    const wait = Math.max(0, MESSAGE_GAP_MS - elapsed);
    flushTimerRef.current = setTimeout(emitMessage, wait);
  }, [emitMessage]);

  const handleUtterance = useCallback(
    async (wav: ArrayBuffer) => {
      const speech = getSpeech();
      if (!speech) return;

      // A new piece is in flight, so the message is not over — cancel any
      // hand-off already armed by the previous piece. Without this, a flush
      // scheduled after sentence one fires while sentence two is still being
      // transcribed, and the message splits in two after all.
      if (flushTimerRef.current) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }

      // Transcription takes about a second, during which the user has stopped
      // talking and nothing has appeared yet. Without this the app looks
      // frozen exactly when it's working hardest.
      pendingRef.current += 1;
      setInterim("…");

      // Every exit from here has to reach scheduleFlush(). If a transcription
      // throws and this is skipped, the message assembled so far is stranded:
      // nothing re-arms the hand-off, so the app keeps listening but never
      // hands anything over again — it just looks broken.
      let result: { text?: string; error?: string };
      try {
        result = await speech.transcribe(wav, WHISPER_LANG[langRef.current]);
      } catch (err) {
        result = { error: (err as Error).message };
      } finally {
        pendingRef.current -= 1;
      }

      if (result.error) {
        setError(result.error);
        scheduleFlush();
        return;
      }

      const piece = (result.text ?? "").trim();
      // Whisper returns nothing for noise-only audio — that's not an error, it
      // just wasn't speech.
      if (piece) {
        if (partsRef.current.length === 0) messageStartRef.current = Date.now();
        partsRef.current.push(piece);
      }
      // This audio is now transcribed for real, so the live guess covering it
      // is obsolete — dropping it is what stops the preview being duplicated
      // alongside the finished text.
      partialRef.current = "";
      refreshInterim();
      scheduleFlush();
    },
    [scheduleFlush, refreshInterim],
  );

  /**
   * Transcribes a snapshot of speech still in progress, purely to drive the
   * live caption. Deliberately best-effort: it is skipped whenever a real
   * utterance is being transcribed, because the finished text is what the
   * user is actually waiting on and previews must never delay it.
   */
  const handlePartial = useCallback(
    async (wav: ArrayBuffer) => {
      const speech = getSpeech();
      if (!speech) return;
      if (!liveCaptionRef.current) return;
      if (partialBusyRef.current || pendingRef.current > 0) return;

      partialBusyRef.current = true;
      try {
        const result = await speech.transcribe(wav, WHISPER_LANG[langRef.current]);
        // A real transcription landed while this was running — it supersedes
        // the guess, so throw the stale preview away.
        if (pendingRef.current > 0 || !speakingRef.current) return;
        const text = (result.text ?? "").trim();
        if (!text) return;
        partialRef.current = text;
        refreshInterim();
      } catch {
        // A dropped preview is not worth surfacing.
      } finally {
        partialBusyRef.current = false;
      }
    },
    [refreshInterim],
  );

  const toggle = useCallback(() => {
    if (sessionRef.current || listeningRef.current) {
      listeningRef.current = false;
      speakingRef.current = false;
      // stop() flushes any buffered audio, so let that last piece transcribe
      // and land before giving up on the message.
      sessionRef.current?.stop();
      sessionRef.current = null;
      setListening(false);
      lastSpeechEndRef.current = Date.now();
      scheduleFlush();
      return;
    }

    // Opening the loopback stream is asynchronous, and until it resolves
    // sessionRef is still null — a second click cannot open another stream.
    if (startingRef.current) return;
    startingRef.current = true;
    setStarting(true);

    setFinalText("");
    setInterim("");
    setError(null);
    listeningRef.current = true;

    // Load the model while the user is drawing breath, so the first utterance
    // doesn't also pay for the ~1.5s model load.
    void getSpeech()?.warmUp();

    const useMic = sourceRef.current === "mic";
    const startCapture = useMic ? startMic : startSystemAudio;

    startCapture({
      onUtterance: handleUtterance,
      onPartial: handlePartial,
      // No partial transcript exists to show, so this is just a "you're being
      // heard" signal for the console's live line.
      onSpeakingChange: (speaking) => {
        speakingRef.current = speaking;
        if (speaking) {
          // They've started again — this is a continuation, not a new
          // message. Cancel any pending hand-off and keep collecting.
          if (flushTimerRef.current) {
            clearTimeout(flushTimerRef.current);
            flushTimerRef.current = null;
          }
          // Keep whatever has been assembled so far on screen — replacing it
          // with a bare "…" every time they draw breath would make a long
          // question flicker between text and nothing.
          refreshInterim();
        } else {
          lastSpeechEndRef.current = Date.now();
          scheduleFlush();
        }
      },
    })
      .then((session) => {
        // Stopped again before the mic finished opening — don't leave an
        // orphaned session running with no way to reach it.
        if (!listeningRef.current) {
          session.stop();
          return;
        }
        sessionRef.current = session;
        // Only show the active/stop state once the device has supplied
        // actual frames — loopback frames from Windows, or real mic frames.
        // Anything spoken before this point cannot be captured, so this
        // prevents a misleading early indicator.
        setListening(true);
      })
      .catch((err: Error) => {
        setError(
          err.name === "NotAllowedError"
            ? useMic
              ? "Microphone access was denied. Allow the microphone permission and try again."
              : "Windows system-audio capture was denied or unavailable."
            : err.message,
        );
        listeningRef.current = false;
        setListening(false);
        setInterim("");
      })
      .finally(() => {
        startingRef.current = false;
        setStarting(false);
      });
  }, [handleUtterance, handlePartial, scheduleFlush, refreshInterim]);

  return { supported, starting, listening, interim, finalText, activeLang, error, toggle };
}
