import { useCallback, useEffect, useRef, useState } from "react";
import { startMic, type MicSession } from "../lib/mic";
import { startSystemAudio } from "../lib/systemAudio";

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

// Whisper is always told to expect English (ISO-639-1 "en") rather than
// auto-detecting or switching languages mid-session. Forcing the language
// is also the more accurate setting for English speech specifically —
// language auto-detection is itself a source of transcription errors, and
// this app no longer needs to recognise Filipino/Tagalog at all.
const WHISPER_LANGUAGE = "en";

/**
 * Hard ceiling on a single message, so an uninterrupted monologue eventually
 * gets handed over instead of growing without bound, even if Stop is never
 * pressed. Not the normal way a message ends — see scheduleFlush below,
 * which otherwise only hands a message over when the user presses Stop.
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
  /** Why speech is unavailable, or the last recognition error. */
  error: string | null;
  toggle: () => void;
}

// Continuously transcribes speech and calls `onFinalUtterance` for each
// completed sentence. Whisper is always told to expect English — see
// WHISPER_LANGUAGE above.
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

  // --- Message assembly ---
  // A message is handed over only when the user presses Stop (see toggle()
  // below) or the MAX_MESSAGE_MS ceiling fires — never on a mid-speech pause.
  // Pauses used to end a message on their own (a MESSAGE_GAP_MS timer armed
  // after every silence), which is what made the app answer while the
  // question was still being asked; scheduleFlush now only ever fires from
  // an explicit Stop (via stoppingRef) or that ceiling.
  /** Transcribed pieces of the message currently being spoken. */
  const partsRef = useRef<string[]>([]);
  /** Set by Stop; tells scheduleFlush the *next* time nothing is pending is
   *  a real end-of-message, not just a breathing pause. */
  const stoppingRef = useRef(false);
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
    const message = partsRef.current.join(" ").replace(/\s+/g, " ").trim();
    partsRef.current = [];
    partialRef.current = "";
    messageStartRef.current = 0;
    setInterim("");
    if (!message) return;

    setFinalText((prev) => prev + message + " ");
    callbackRef.current(message);
  }, []);

  /**
   * The only place a message can end. Called after every transcribed piece
   * and every speaking-stop event, but a plain pause does nothing here — it
   * takes either stoppingRef (set by the user pressing Stop) or the
   * MAX_MESSAGE_MS ceiling to actually emit. Whichever condition isn't met
   * yet, a later call (the next piece finishing, or Stop itself) re-checks.
   */
  const scheduleFlush = useCallback(() => {
    // Still talking, or a piece is still in the transcriber — not settled
    // enough to decide anything yet. Whichever finishes last calls this again.
    if (speakingRef.current || pendingRef.current > 0) return;

    if (partsRef.current.length === 0) {
      stoppingRef.current = false;
      return;
    }

    if (stoppingRef.current) {
      stoppingRef.current = false;
      emitMessage();
      return;
    }

    // Safety net for a monologue that's still going with Stop never pressed.
    if (messageStartRef.current && Date.now() - messageStartRef.current > MAX_MESSAGE_MS) {
      emitMessage();
      return;
    }
  }, [emitMessage]);

  const handleUtterance = useCallback(
    async (wav: ArrayBuffer) => {
      const speech = getSpeech();
      if (!speech) return;

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
        result = await speech.transcribe(wav, WHISPER_LANGUAGE);
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
        const result = await speech.transcribe(wav, WHISPER_LANGUAGE);
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
      // The only place this is set — it's what turns the *next* settled
      // moment (this call, or once the final piece below finishes
      // transcribing) into a real end-of-message instead of another pause.
      stoppingRef.current = true;
      // stop() flushes any buffered audio, so let that last piece transcribe
      // and land before giving up on the message.
      sessionRef.current?.stop();
      sessionRef.current = null;
      setListening(false);
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
          // Keep whatever has been assembled so far on screen — replacing it
          // with a bare "…" every time they draw breath would make a long
          // question flicker between text and nothing.
          refreshInterim();
        } else {
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

  return { supported, starting, listening, interim, finalText, error, toggle };
}
