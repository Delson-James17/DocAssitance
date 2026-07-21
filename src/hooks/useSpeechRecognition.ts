import { useCallback, useEffect, useRef, useState } from "react";
import { detectSpeechLang, type SpeechLang } from "../lib/detectLang";

// --- Minimal local typings for the Web Speech API --------------------------
// The Web Speech API isn't a stable standard, so we declare just what we use
// rather than depend on it existing in the TS DOM lib.
interface RecognitionAlternative {
  readonly transcript: string;
}
interface RecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  readonly [index: number]: RecognitionAlternative;
}
interface RecognitionResultList {
  readonly length: number;
  readonly [index: number]: RecognitionResult;
}
interface RecognitionEvent {
  readonly resultIndex: number;
  readonly results: RecognitionResultList;
}
interface RecognitionErrorEvent {
  readonly error: string;
}
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  onresult: ((e: RecognitionEvent) => void) | null;
  onerror: ((e: RecognitionErrorEvent) => void) | null;
  onend: (() => void) | null;
}
type RecognitionCtor = new () => Recognition;

function getRecognitionCtor(): RecognitionCtor | null {
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

interface UseSpeechRecognition {
  supported: boolean;
  listening: boolean;
  interim: string;
  finalText: string;
  /** Which language the recognizer is currently listening for — adapts
   * automatically based on what gets transcribed (see detectLang.ts). */
  activeLang: SpeechLang;
  toggle: () => void;
}

// Continuously transcribes speech and calls `onFinalUtterance` for each
// completed sentence. Automatically switches between English and Filipino
// recognition based on the language each utterance looks like — the Web
// Speech API can only listen in one language at a time, so this adapts
// going forward rather than detecting both simultaneously.
export function useSpeechRecognition(
  onFinalUtterance: (utterance: string) => void,
): UseSpeechRecognition {
  const [supported] = useState(() => getRecognitionCtor() !== null);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [finalText, setFinalText] = useState("");
  const [activeLang, setActiveLang] = useState<SpeechLang>("en-US");

  const recognitionRef = useRef<Recognition | null>(null);
  const listeningRef = useRef(false);
  // Keep the latest callback without re-creating the recognition object.
  const callbackRef = useRef(onFinalUtterance);
  callbackRef.current = onFinalUtterance;

  useEffect(() => {
    const Ctor = getRecognitionCtor();
    if (!Ctor) return;

    const recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = activeLang;

    recognition.onresult = (event) => {
      let interimText = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0].transcript;
        if (result.isFinal) {
          setFinalText((prev) => prev + text + " ");
          const utterance = text.trim();
          if (utterance) {
            callbackRef.current(utterance);
            // Adapt the recognition language for the *next* utterance based
            // on what this one looked like.
            const detected = detectSpeechLang(utterance);
            setActiveLang((current) => (detected !== current ? detected : current));
          }
        } else {
          interimText += text;
        }
      }
      setInterim(interimText);
    };

    recognition.onerror = (e) => {
      if (e.error !== "no-speech" && e.error !== "aborted") {
        console.warn("Speech error:", e.error);
      }
    };

    // Chrome ends recognition periodically; restart while we mean to listen.
    recognition.onend = () => {
      if (listeningRef.current) recognition.start();
    };

    recognitionRef.current = recognition;
    setInterim("");

    // A language switch mid-session replaces the recognizer — if we were
    // already listening, keep going seamlessly on the new one instead of
    // dropping back to idle and making the user click Start again.
    if (listeningRef.current) {
      recognition.start();
    }

    return () => {
      recognition.onend = null;
      recognition.stop();
    };
  }, [activeLang]);

  const toggle = useCallback(() => {
    const recognition = recognitionRef.current;
    if (!recognition) return;

    if (listeningRef.current) {
      listeningRef.current = false;
      setListening(false);
      setInterim("");
      recognition.stop();
    } else {
      setFinalText("");
      setInterim("");
      listeningRef.current = true;
      setListening(true);
      recognition.start();
    }
  }, []);

  return { supported, listening, interim, finalText, activeLang, toggle };
}
