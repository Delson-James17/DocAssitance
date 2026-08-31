import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Console } from "./components/Console";
import { QaPanel } from "./components/QaPanel";
import { ResizeHandles } from "./components/ResizeHandles";
import { Settings } from "./components/Settings";
import { useAppearance } from "./hooks/useAppearance";
import { useQa } from "./hooks/useQa";
import { useSpeechRecognition } from "./hooks/useSpeechRecognition";
import { useTheme } from "./hooks/useTheme";
import {
  askQuestion,
  askScreenshot as askScreenshotApi,
  type CodeLanguage,
  type CodeLanguagePreset,
  type HistoryEntry,
  type Persona,
  type PersonaPreset,
} from "./lib/api";
import { DUPLICATE_THRESHOLD, similarity } from "./lib/dedupe";
import { findRelatedContext, matchSavedQa } from "./lib/qaMatch";
import { buildTranscript, downloadQaTranscript, downloadTranscript } from "./lib/transcript";
import type { RecordEntry } from "./types";

// How close a spoken line has to be to the answer on screen before it's taken
// as the user reading that answer out loud rather than asking something new.
// Lower than DUPLICATE_THRESHOLD on purpose: someone reciting an answer
// paraphrases, stumbles and skips words, so the match is never exact.
const ANSWER_ECHO_THRESHOLD = 0.45;

// How many recent exchanges ride along as real conversation turns so a
// follow-up ("explain that more", "why line 3") gets answered with the
// actual prior context instead of in isolation — see historyRef below.
// Small on purpose: every entry here is resent on *every* later question
// until it ages out, so this trades a bit of follow-up "memory" for
// bounded per-question cost.
const MAX_HISTORY = 3;

interface CachedAnswer {
  question: string;
  answer: string;
  /**
   * A fingerprint of both the answer-shaping settings (persona, short
   * answers, job description, code language) *and* the conversation history
   * active when this was generated — see the cacheKey built in ask() below.
   * A cache hit requires this to match the *current* value of both, not
   * just a similar question: settings changing (switching C# to JavaScript
   * and re-asking the same problem) or the conversation context differing
   * (the same short follow-up text means something different in a different
   * conversation) would otherwise silently hand back a stale answer instead
   * of asking Claude again properly.
   */
  settingsKey: string;
}

interface DesktopWindow {
  minimize: () => void;
  toggleMaximize: () => void;
  close: () => void;
  /** @returns whether the window is now pinned on top */
  togglePin: () => Promise<boolean>;
  setContentProtection: (enabled: boolean) => Promise<ContentProtectionResult>;
  getMaterial: () => Promise<WindowMaterial>;
  setMaterial: (material: WindowMaterial) => Promise<WindowMaterial>;
  getBounds: () => Promise<{ x: number; y: number; width: number; height: number } | null>;
  setBounds: (bounds: { x: number; y: number; width: number; height: number }) => Promise<void>;
  setClickThrough: (enabled: boolean) => Promise<void>;
  /** @returns unsubscribe */
  onBeforeClose: (handler: () => void | Promise<void>) => () => void;
  saveLogsAndClose: (payload: { fullText: string; qaText: string }) => Promise<void>;
}

type WindowMaterial = "acrylic" | "clear";

interface ContentProtectionResult {
  ok: boolean;
  enabled: boolean;
  reason: string;
}

// Present only in the desktop app. In the browser the title bar's buttons stay
// decorative, which is what they always were.
const desktopWindow: DesktopWindow | undefined = (
  window as unknown as { desktop?: { window?: DesktopWindow } }
).desktop?.window;

interface DesktopScreenshot {
  capture: () => Promise<{ dataUrl?: string; error?: string }>;
}

// Present only in the desktop app — capturing the screen needs OS-level
// access the browser doesn't grant a web page.
const desktopScreenshot: DesktopScreenshot | undefined = (
  window as unknown as { desktop?: { screenshot?: DesktopScreenshot } }
).desktop?.screenshot;

// Opens the folder session logs are auto-saved to on close (see the
// onBeforeClose handler below). Desktop-only — the web build has nothing on
// disk for this to point at.
const desktopOpenLogsFolder: (() => Promise<boolean>) | undefined = (
  window as unknown as { desktop?: { openLogsFolder?: () => Promise<boolean> } }
).desktop?.openLogsFolder;

function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID()
    : String(Date.now() + Math.random());
}

export default function App() {
  const qa = useQa();
  const { theme, toggleTheme } = useTheme();
  const {
    appearance,
    setUiOpacity,
    setTextOpacity,
    setLiveCaption,
    setTextColor,
    setBgColor,
    reset: resetAppearance,
  } = useAppearance();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [record, setRecord] = useState<RecordEntry[]>([]);
  const [qaOpen, setQaOpen] = useState(false);

  // "Move": pins the real OS window on top of every other window (desktop
  // only — there's no equivalent for a browser tab). Lives in App.tsx rather
  // than either style's own component because it's the same underlying
  // window regardless of which style is showing, and switching styles
  // shouldn't reset it. Starts pinned to match main.cjs's own default — the
  // whole point is that the window behaves like an overlay from launch,
  // without needing a click first; Move is how you turn it back off.
  const [pinned, setPinned] = useState(() => Boolean(desktopWindow));
  const togglePin = useCallback(() => {
    void desktopWindow?.togglePin().then((next) => setPinned(next));
  }, []);

  // Display affinity belongs to the current native window, so it is not
  // persisted after the application closes.
  // The native window enables this by default during creation (main.cjs).
  // Browser builds have no native window or capture-exclusion capability.
  const [hiddenFromSharing, setHiddenFromSharing] = useState(() => Boolean(desktopWindow));
  const [sharingStatus, setSharingStatus] = useState("");
  const toggleContentProtection = useCallback(() => {
    if (!desktopWindow) return;
    void desktopWindow.setContentProtection(!hiddenFromSharing).then((result) => {
      setSharingStatus(result.reason);
      if (result.ok) setHiddenFromSharing(result.enabled);
    });
  }, [hiddenFromSharing]);

  // Window blur mode (desktop-only): "acrylic" frosts the desktop behind the
  // window, "clear" shows it through unblurred. Read from the main process
  // rather than localStorage, since it's the main process — not this
  // renderer — that owns the choice (the window has to be built with it).
  const [windowMaterial, setWindowMaterialState] = useState<WindowMaterial>("clear");
  useEffect(() => {
    void desktopWindow?.getMaterial().then(setWindowMaterialState);
  }, []);
  const setWindowMaterial = useCallback((material: WindowMaterial) => {
    void desktopWindow?.setMaterial(material).then(setWindowMaterialState);
  }, []);

  // Persisted kill switch: when off, no question ever reaches the Claude
  // API, so it's a hard guarantee against burning tokens, not just a UI
  // nicety. Defaults on; only saved to localStorage once the user flips it.
  const [aiEnabled, setAiEnabled] = useState<boolean>(
    () => localStorage.getItem("aiEnabled") !== "off",
  );
  const toggleAi = useCallback(() => {
    setAiEnabled((prev) => {
      const next = !prev;
      localStorage.setItem("aiEnabled", next ? "on" : "off");
      return next;
    });
  }, []);

  // How Claude's answers should sound — a preset tone, or "custom" free-text
  // behavior instructions. Sent with every question (see ask/askScreenshot
  // below); the actual wording for each preset lives server-side
  // (server/prompts.js) so there's one source of truth for what each means.
  const [personaPreset, setPersonaPreset] = useState<PersonaPreset>(
    () => (localStorage.getItem("personaPreset") as PersonaPreset | null) ?? "default",
  );
  const [personaCustom, setPersonaCustomState] = useState<string>(
    () => localStorage.getItem("personaCustom") ?? "",
  );
  const setPersona = useCallback((preset: PersonaPreset) => {
    setPersonaPreset(preset);
    localStorage.setItem("personaPreset", preset);
  }, []);
  const setPersonaCustom = useCallback((custom: string) => {
    setPersonaCustomState(custom);
    localStorage.setItem("personaCustom", custom);
  }, []);
  const persona: Persona = { preset: personaPreset, custom: personaCustom };

  // Independent of tone: a short answer can still be Professional, Jolly,
  // etc. — see server/prompts.js's SHORT_ANSWER_INSTRUCTION for what this
  // actually asks Claude to do (a one-line summary instead of an explanation).
  const [shortAnswers, setShortAnswersState] = useState<boolean>(
    () => localStorage.getItem("shortAnswers") === "on",
  );
  const setShortAnswers = useCallback((value: boolean) => {
    setShortAnswersState(value);
    localStorage.setItem("shortAnswers", value ? "on" : "off");
  }, []);

  // A pasted job posting — sent with every question so personal/interview
  // answers get tailored toward it (which skills/experience to lead with,
  // language to echo). See server/prompts.js's jobDescriptionInstruction for
  // what this actually tells Claude to do with it; empty by default and
  // ignored entirely by the server when blank, so this costs nothing until
  // something's actually pasted in.
  const [jobDescription, setJobDescriptionState] = useState<string>(
    () => localStorage.getItem("jobDescription") ?? "",
  );
  const setJobDescription = useCallback((value: string) => {
    setJobDescriptionState(value);
    localStorage.setItem("jobDescription", value);
  }, []);

  // Which language Claude writes code in for coding-style questions ("solve
  // this problem", "write a function that…") — a preset, or "custom" for
  // anything not listed. "auto" (the default) leaves Claude's own judgment
  // alone; the actual instruction text for each preset lives server-side
  // (server/prompts.js's codeLanguageInstruction) for one source of truth.
  const [codeLanguagePreset, setCodeLanguagePresetState] = useState<CodeLanguagePreset>(
    () => (localStorage.getItem("codeLanguagePreset") as CodeLanguagePreset | null) ?? "auto",
  );
  const [codeLanguageCustom, setCodeLanguageCustomState] = useState<string>(
    () => localStorage.getItem("codeLanguageCustom") ?? "",
  );
  const setCodeLanguagePreset = useCallback((preset: CodeLanguagePreset) => {
    setCodeLanguagePresetState(preset);
    localStorage.setItem("codeLanguagePreset", preset);
  }, []);
  const setCodeLanguageCustom = useCallback((custom: string) => {
    setCodeLanguageCustomState(custom);
    localStorage.setItem("codeLanguageCustom", custom);
  }, []);
  const codeLanguage: CodeLanguage = { preset: codeLanguagePreset, custom: codeLanguageCustom };

  // Fingerprint of every setting that changes how an answer is *shaped*
  // (not what it says) — see CachedAnswer's settingsKey for why the answer
  // cache below needs this rather than just matching on question text.
  const settingsKey = useMemo(
    () =>
      JSON.stringify([
        personaPreset,
        personaCustom,
        shortAnswers,
        jobDescription,
        codeLanguagePreset,
        codeLanguageCustom,
      ]),
    [personaPreset, personaCustom, shortAnswers, jobDescription, codeLanguagePreset, codeLanguageCustom],
  );

  // Which device speech is captured from. "headset" loops back system audio
  // (see systemAudio.ts) — it only works cleanly with headphones, since
  // otherwise the speakers' own output leaks back into the mic. "mic"
  // captures the microphone directly, for listening without a headset.
  // Persisted like aiEnabled, and defaults to "headset" to match the
  // behaviour that already existed before this toggle.
  const [audioSource, setAudioSource] = useState<"headset" | "mic">(
    () => (localStorage.getItem("audioSource") === "mic" ? "mic" : "headset"),
  );
  const toggleAudioSource = useCallback(() => {
    setAudioSource((prev) => {
      const next = prev === "headset" ? "mic" : "headset";
      localStorage.setItem("audioSource", next);
      return next;
    });
  }, []);

  // Non-question speech is kept verbatim — the record is the whole
  // conversation, not just the parts that got answered.
  const addNote = useCallback((text: string) => {
    setRecord((prev) => [
      { id: newId(), kind: "note", text, timestamp: Date.now() },
      ...prev,
    ]);
  }, []);

  // Claude answers already paid for — reusing them for a repeat (or close
  // rewording of a) question is free whether AI is currently on or off,
  // since no new call is made either way.
  const answerCacheRef = useRef<CachedAnswer[]>([]);

  // The last few exchanges (any source — saved, cached, or Claude), sent as
  // real prior conversation turns on the *next* question — see MAX_HISTORY
  // above and HistoryEntry in lib/api.ts. A ref rather than state: it's read
  // at ask-time, not rendered, and doesn't need to trigger anything.
  const historyRef = useRef<HistoryEntry[]>([]);
  const pushHistory = useCallback((question: string, answer: string) => {
    if (!answer) return;
    historyRef.current = [...historyRef.current, { question, answer }].slice(-MAX_HISTORY);
  }, []);

  const pushQa = useCallback(
    (fields: Omit<Extract<RecordEntry, { kind: "qa" }>, "id" | "kind" | "timestamp">) => {
      const id = newId();
      setRecord((prev) => [
        { id, kind: "qa", timestamp: Date.now(), ...fields },
        ...prev,
      ]);
      return id;
    },
    [],
  );

  const patchQa = useCallback(
    (id: string, fields: Partial<Extract<RecordEntry, { kind: "qa" }>>) => {
      setRecord((prev) =>
        prev.map((e) => (e.id === id && e.kind === "qa" ? { ...e, ...fields } : e)),
      );
    },
    [],
  );

  // Every question — typed, spoken, or otherwise — funnels through here.
  // Three paths, in order: (1) a saved Q&A match always wins — it's an
  // exact answer someone wrote on purpose, so it can't be "the wrong
  // answer" the way an inference could be. Matching is keyword-coverage
  // based (matchSavedQa), robust to rewording — voice-transcribed questions
  // rarely match a saved question's exact wording. (2) a near-duplicate of
  // an earlier question is answered from cache, no network call at all.
  // (3) otherwise, with AI on, ask Claude and cache the result; with AI
  // off, there's nothing left that can answer it for free, so say so.
  const ask = useCallback(
    (question: string) => {
      // Folds in the current conversation history, not just the answer-
      // shaping settings: two occurrences of the same short follow-up
      // ("explain that more") asked in different conversations don't mean
      // the same thing, so a cache hit needs the *context* to match too,
      // not just the words.
      const cacheKey = settingsKey + JSON.stringify(historyRef.current);

      const savedMatch = matchSavedQa(qa.entries, question);
      if (savedMatch) {
        pushQa({ question, answer: savedMatch.answer, pending: false, source: "saved" });
        pushHistory(question, savedMatch.answer);
        return;
      }

      const cached = answerCacheRef.current.find(
        (c) => c.settingsKey === cacheKey && similarity(c.question, question) >= DUPLICATE_THRESHOLD,
      );
      if (cached) {
        pushQa({ question, answer: cached.answer, pending: false, source: "cache" });
        pushHistory(question, cached.answer);
        return;
      }

      if (!aiEnabled) {
        pushQa({
          question,
          answer: "",
          pending: false,
          source: "none",
          error: "No saved answer for this — turn AI on to ask Claude.",
        });
        return;
      }

      const id = pushQa({ question, answer: "", pending: true, source: "claude" });

      // Loosely-related saved entries (not a match, just topically nearby)
      // ride along as background so Claude's improvised answer stays
      // consistent with real facts the user already wrote about themselves,
      // instead of inventing an unrelated persona. Unrelated questions
      // naturally find none, so cost is unaffected for those.
      const context = findRelatedContext(qa.entries, question);
      // Snapshot now, not read fresh inside onDone — this is what the
      // question was actually answered *with*, and has to be the same
      // reference tagged onto the cache entry below for cacheKey to mean
      // anything.
      const history = historyRef.current;

      void askQuestion(
        question,
        {
          onDelta: (text) =>
            setRecord((prev) =>
              prev.map((e) =>
                e.id === id && e.kind === "qa" ? { ...e, answer: e.answer + text } : e,
              ),
            ),
          onDone: (answer) => {
            patchQa(id, { pending: false, answer });
            pushHistory(question, answer);
            answerCacheRef.current = [
              { question, answer, settingsKey: cacheKey },
              ...answerCacheRef.current,
            ].slice(0, 50);
          },
          onError: (message) => patchQa(id, { pending: false, error: message }),
        },
        context,
        persona,
        shortAnswers,
        jobDescription,
        codeLanguage,
        history,
      );
    },
    [
      aiEnabled,
      qa.entries,
      pushQa,
      patchQa,
      pushHistory,
      persona,
      shortAnswers,
      jobDescription,
      codeLanguage,
      settingsKey,
    ],
  );

  // A question read visually (a shared doc, a coding platform, a slide)
  // instead of heard. There's no text to match against saved Q&A or the
  // answer cache the way ask() does — Claude reads the screenshot directly
  // (native vision support) — so this always costs a Claude call and is a
  // no-op with AI off, same as a spoken question would be in that case.
  const askScreenshot = useCallback(() => {
    if (!desktopScreenshot) return;

    if (!aiEnabled) {
      pushQa({
        question: "📷 Screenshot",
        answer: "",
        pending: false,
        source: "none",
        error: "AI is off — turn it on to read a screenshot.",
      });
      return;
    }

    void (async () => {
      const result = await desktopScreenshot.capture();
      if (result.error || !result.dataUrl) {
        pushQa({
          question: "📷 Screenshot",
          answer: "",
          pending: false,
          source: "none",
          error: result.error ?? "Couldn't capture the screen.",
        });
        return;
      }

      const id = pushQa({
        question: "📷 Screenshot",
        answer: "",
        pending: true,
        source: "claude",
      });

      void askScreenshotApi(
        result.dataUrl,
        {
          onDelta: (text) =>
            setRecord((prev) =>
              prev.map((e) =>
                e.id === id && e.kind === "qa" ? { ...e, answer: e.answer + text } : e,
              ),
            ),
          onDone: (answer) => {
            patchQa(id, { pending: false, answer });
            pushHistory("📷 Screenshot", answer);
          },
          onError: (message) => patchQa(id, { pending: false, error: message }),
        },
        [],
        persona,
        shortAnswers,
        jobDescription,
        codeLanguage,
        historyRef.current,
      );
    })();
  }, [aiEnabled, pushQa, patchQa, pushHistory, persona, shortAnswers, jobDescription, codeLanguage]);

  // The most recent answer shown, so it can be recognised if it's read back
  // out loud. See the echo check in onFinalUtterance.
  const lastAnswerRef = useRef("");
  useEffect(() => {
    const latest = record.find((e) => e.kind === "qa" && !e.pending && e.answer);
    if (latest && latest.kind === "qa") lastAnswerRef.current = latest.answer;
  }, [record]);

  // Every utterance heard while listening gets answered — there's no
  // question heuristic gating it anymore, since a missed "is this a
  // question" guess meant a spoken question silently got filed as a note
  // and never answered. The one thing still filtered out is the user's own
  // voice reading the last answer back off the screen: without that check,
  // every readback would immediately be re-asked as if it were new.
  const onFinalUtterance = useCallback(
    (utterance: string) => {
      const answer = lastAnswerRef.current;
      if (answer && similarity(utterance, answer) >= ANSWER_ECHO_THRESHOLD) {
        addNote(utterance);
        return;
      }

      ask(utterance);
    },
    [ask, addNote],
  );

  const {
    supported,
    starting,
    listening,
    interim,
    error: speechError,
    toggle,
  } = useSpeechRecognition(onFinalUtterance, {
    liveCaption: appearance.liveCaption,
    source: audioSource,
  });

  const toggleListening = toggle;

  // Global keyboard shortcuts — a fallback for when clicking is inconvenient
  // mid-practice. "." and space both toggle listening (there is only one
  // control now); any digit or letter key instantly recalls
  // whichever saved entry has that quick key assigned (see QaPanel.tsx),
  // pushing it
  // into the record and mini boxes exactly like a live saved-Q&A match
  // would — a manual override for the questions you most need on hand in
  // case voice or typing lets you down. Up/Down scroll the conversation log;
  // [ and ] switch the window blur mode (Frosted/Clear, same as the Settings
  // toggle); a bare tap of Ctrl (pressed and released with no other key
  // meanwhile) takes a screenshot — Fn itself can't be used for this: on
  // essentially every laptop keyboard, Fn is handled entirely by the
  // keyboard's own firmware and never reaches Windows (or any app) as a real
  // keypress. Holding Shift makes the window click-through so whatever's
  // behind it can be clicked, restoring the moment Shift is released (see
  // window:set-clickthrough in main.cjs for how that survives a click
  // during the hold sending focus elsewhere first). Ignored while focus is
  // in any editable field so normal typing (the command bar, the Saved Q&A
  // forms) is never hijacked.
  useEffect(() => {
    function isEditableTarget(target: EventTarget | null): boolean {
      if (!(target instanceof HTMLElement)) return false;
      const tag = target.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
    }

    // True only while Control is down and nothing else has been pressed
    // alongside it yet — a normal Ctrl+C/Ctrl+V still works untouched,
    // since the moment that second key lands this flips false and the
    // keyup never fires the screenshot.
    let ctrlTap = false;

    function onKeyDown(e: KeyboardEvent) {
      if (isEditableTarget(e.target)) return;

      if (e.key === "Control") {
        if (!e.repeat) ctrlTap = true;
        return;
      }
      ctrlTap = false;

      // Hold Shift to click through the window to whatever's behind it —
      // see window:set-clickthrough in main.cjs for how it restores itself
      // (Shift's own keyup below, or regaining focus as a fallback for when
      // a click during the hold sends focus elsewhere first).
      if (e.key === "Shift") {
        if (!e.repeat) void desktopWindow?.setClickThrough(true);
        return;
      }

      if (e.metaKey || e.ctrlKey || e.altKey) return;

      if (e.key === "." || e.key === " ") {
        e.preventDefault();
        toggleListening();
        return;
      }
      if (e.key === "ArrowUp" || e.key === "ArrowDown") {
        const el = document.querySelector<HTMLElement>(".scrollback");
        if (el) {
          e.preventDefault();
          el.scrollBy({ top: e.key === "ArrowUp" ? -80 : 80, behavior: "smooth" });
        }
        return;
      }
      // Window blur mode — desktop-only, same as clicking Frosted/Clear in
      // Settings (see setWindowMaterial above). A no-op in the browser build
      // since setWindowMaterial itself no-ops without desktopWindow.
      if (e.key === "[" || e.key === "]") {
        e.preventDefault();
        setWindowMaterial(e.key === "[" ? "acrylic" : "clear");
        return;
      }
      // Case-insensitive: an entry assigned "q" answers to Q as well, so a
      // stray caps lock can't cost you the shortcut.
      const key = e.key.toLowerCase();
      if (/^[a-z0-9]$/.test(key)) {
        const entry = qa.entries.find((en) => en.hotkey === key);
        if (entry) {
          e.preventDefault();
          pushQa({ question: entry.question, answer: entry.answer, pending: false, source: "saved" });
        }
      }
    }

    function onKeyUp(e: KeyboardEvent) {
      if (e.key === "Shift") {
        void desktopWindow?.setClickThrough(false);
        return;
      }
      if (e.key !== "Control") return;
      const wasTap = ctrlTap;
      ctrlTap = false;
      if (wasTap && !isEditableTarget(document.activeElement)) askScreenshot();
    }

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [qa.entries, toggleListening, pushQa, askScreenshot, setWindowMaterial]);

  // Right-click-drag to move the window from anywhere (desktop only) — the
  // title bar's own drag region (see .title-bar in index.css) only answers
  // to the left button and isn't always reachable once the window is small
  // or sitting over content you still need to click through to. Reuses the
  // same getBounds/setBounds bridge ResizeHandles.tsx drives; unlike that
  // component this doesn't need pointer capture on a specific element,
  // since the drag is already tracked at the window level regardless of
  // what's under the cursor.
  useEffect(() => {
    if (!desktopWindow) return;

    function isEditableTarget(target: EventTarget | null): boolean {
      if (!(target instanceof HTMLElement)) return false;
      const tag = target.tagName;
      return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable;
    }

    let dragStart: { x: number; y: number; width: number; height: number } | null = null;
    let startX = 0;
    let startY = 0;

    function onPointerDown(e: PointerEvent) {
      if (e.button !== 2 || isEditableTarget(e.target)) return;
      startX = e.screenX;
      startY = e.screenY;
      void desktopWindow!.getBounds().then((bounds) => {
        if (bounds) dragStart = bounds;
      });
    }

    function onPointerMove(e: PointerEvent) {
      if (!dragStart) return;
      void desktopWindow!.setBounds({
        x: dragStart.x + (e.screenX - startX),
        y: dragStart.y + (e.screenY - startY),
        width: dragStart.width,
        height: dragStart.height,
      });
    }

    function onPointerUp(e: PointerEvent) {
      if (e.button === 2) dragStart = null;
    }

    // The right-click context menu would otherwise pop up the instant the
    // drag starts — left alone over editable fields, so right-click paste
    // still works in the command bar.
    function onContextMenu(e: MouseEvent) {
      if (!isEditableTarget(e.target)) e.preventDefault();
    }

    window.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("contextmenu", onContextMenu);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("contextmenu", onContextMenu);
    };
  }, []);

  // Auto-save this session's logs on close (desktop only) — silent, no
  // confirmation dialog. A ref rather than a dependency on `record` itself:
  // this only needs whatever the record happens to be at the moment the
  // window is actually closing, and re-registering the underlying IPC
  // listener on every transcribed word (record changes constantly while
  // listening) would be wasteful for an effect that fires exactly once.
  const recordRef = useRef(record);
  useEffect(() => {
    recordRef.current = record;
  }, [record]);

  useEffect(() => {
    if (!desktopWindow) return;
    return desktopWindow.onBeforeClose(async () => {
      const current = recordRef.current;
      const qaEntries = current.filter((e): e is Extract<RecordEntry, { kind: "qa" }> => e.kind === "qa");
      await desktopWindow!.saveLogsAndClose({
        fullText: current.length > 0 ? buildTranscript(current) : "",
        qaText: qaEntries.length > 0 ? buildTranscript(qaEntries) : "",
      });
    });
  }, []);

  const busy = record.some((e) => e.kind === "qa" && e.pending);

  // Wipes the on-screen record (and the answer cache keyed to it) — nothing
  // server-side to undo, but it's the whole conversation so confirm first
  // rather than lose it to a stray click.
  const handleClear = useCallback(() => {
    if (record.length === 0) return;
    if (!window.confirm("Clear the whole conversation record? This can't be undone.")) return;
    setRecord([]);
    answerCacheRef.current = [];
    historyRef.current = [];
  }, [record.length]);

  return (
    <>
    {desktopWindow && windowMaterial === "clear" ? (
      <ResizeHandles desktopWindow={desktopWindow} />
    ) : null}
    <div className="term-app">
      <div className="title-bar">
        <span className="title-text">
          <span className="glyph">&gt;_</span>
          C:\Users\Guest\VoiceDocAssistant
        </span>
        <span className="win-controls">
          {/* Shows the theme you're *in*, not the one you'd switch to — the
              other way round reads as a label and had people thinking they
              were already in Glass mode. Where it goes next lives in the
              tooltip. */}
          <button
            className="theme-toggle"
            onClick={toggleTheme}
            title={
              theme === "dark"
                ? "Theme: Dark — click for Light"
                : theme === "light"
                  ? "Theme: Light — click for Glass"
                  : "Theme: Glass — click for Dark"
            }
          >
            {theme === "dark" ? "☾ Dark" : theme === "light" ? "☀ Light" : "◐ Glass"}
          </button>
          <button
            className={`theme-toggle settings-btn${settingsOpen ? " on" : ""}`}
            onClick={() => setSettingsOpen((prev) => !prev)}
            title="Appearance — background and text transparency"
            aria-label="Appearance settings"
          >
            ⚙
          </button>
          <button
            className={`theme-toggle settings-btn${pinned ? " on" : ""}`}
            onClick={togglePin}
            disabled={!desktopWindow}
            aria-label="Move"
            title={
              desktopWindow
                ? pinned
                  ? "Move: on — this window stays on top of everything else. Click to turn off."
                  : "Move — keep this window on top of other apps, even after Alt+Tab"
                : "Move is desktop-only — the browser build has no window to pin"
            }
          >
            📌
          </button>
          <button
            className={`theme-toggle settings-btn${hiddenFromSharing ? " on" : ""}`}
            onClick={toggleContentProtection}
            disabled={!desktopWindow}
            title={
              desktopWindow
                ? hiddenFromSharing
                  ? "Hide from Screen Sharing: on — click to allow capture again"
                  : "Hide from Screen Sharing — request exclusion from supported Windows capture methods"
                : "Hide from Screen Sharing is only available in the Windows desktop app"
            }
            aria-pressed={hiddenFromSharing}
          >
            🛡
          </button>
          {sharingStatus && <span className="sr-only" role="status">{sharingStatus}</span>}
          <button className="min" onClick={() => desktopWindow?.minimize()} title="Minimize">
            &#8211;
          </button>
          <button
            className="max"
            onClick={() => desktopWindow?.toggleMaximize()}
            title="Maximize"
          >
            &#9633;
          </button>
          <button className="close" onClick={() => desktopWindow?.close()} title="Close">
            &#215;
          </button>
        </span>
      </div>

      <div className="workspace">
        <Console
          supported={supported}
          starting={starting}
          listening={listening}
          busy={busy}
          interim={interim}
          onToggleMic={toggleListening}
          audioSource={audioSource}
          onToggleAudioSource={toggleAudioSource}
          record={record}
          onAsk={ask}
          onScreenshot={askScreenshot}
          screenshotAvailable={Boolean(desktopScreenshot)}
          aiEnabled={aiEnabled}
          onToggleAi={toggleAi}
          onDownload={() => downloadTranscript(record)}
          onDownloadQa={() => downloadQaTranscript(record)}
          onOpenLogsFolder={desktopOpenLogsFolder ? () => void desktopOpenLogsFolder() : undefined}
          codeLanguagePreset={codeLanguagePreset}
          onCodeLanguagePreset={setCodeLanguagePreset}
          onClear={handleClear}
          qaCount={qa.entries.length}
          qaOpen={qaOpen}
          onToggleQa={() => setQaOpen((v) => !v)}
        />
        <QaPanel
          entries={qa.entries}
          open={qaOpen}
          onAdd={qa.add}
          onUpdate={qa.update}
          onRemove={qa.remove}
          onRemoveAll={qa.removeAll}
          onImport={qa.importMany}
        />
      </div>

      {speechError && (
        <p className="unsupported">
          ⚠ {speechError}
          {!supported && " You can still type questions."}
        </p>
      )}
    </div>

    {/* Deliberately a sibling of .term-app, not a child. .term-app clips its
        overflow to keep square corners inside its rounded frame, which would
        clip this popover out of existence — and its backdrop-filter makes it
        a containing block, so even position: fixed wouldn't escape. */}
    <Settings
      open={settingsOpen}
      onClose={() => setSettingsOpen(false)}
      appearance={appearance}
      onUiOpacity={setUiOpacity}
      onTextOpacity={setTextOpacity}
      onLiveCaption={setLiveCaption}
      onTextColor={setTextColor}
      onBgColor={setBgColor}
      onReset={resetAppearance}
      desktopAvailable={Boolean(desktopWindow)}
      windowMaterial={windowMaterial}
      onWindowMaterial={setWindowMaterial}
      personaPreset={personaPreset}
      personaCustom={personaCustom}
      onPersonaPreset={setPersona}
      onPersonaCustom={setPersonaCustom}
      shortAnswers={shortAnswers}
      onShortAnswers={setShortAnswers}
      jobDescription={jobDescription}
      onJobDescription={setJobDescription}
      codeLanguagePreset={codeLanguagePreset}
      codeLanguageCustom={codeLanguageCustom}
      onCodeLanguageCustom={setCodeLanguageCustom}
    />
    </>
  );
}
