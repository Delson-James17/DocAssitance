import { useEffect, useRef } from "react";
import {
  DEFAULT_APPEARANCE,
  TEXT_OPACITY_RANGE,
  UI_OPACITY_RANGE,
  type Appearance,
} from "../hooks/useAppearance";
import type { PersonaPreset } from "../lib/api";

const PERSONA_OPTIONS: { value: PersonaPreset; label: string }[] = [
  { value: "default", label: "Default" },
  { value: "professional", label: "Professional" },
  { value: "friendly", label: "Friendly" },
  { value: "jolly", label: "Jolly" },
  { value: "custom", label: "Custom" },
];

type WindowMaterial = "acrylic" | "clear";

interface SettingsProps {
  open: boolean;
  onClose: () => void;
  appearance: Appearance;
  onUiOpacity: (value: number) => void;
  onTextOpacity: (value: number) => void;
  onLiveCaption: (value: boolean) => void;
  onTextColor: (value: string | null) => void;
  onBgColor: (value: string | null) => void;
  onReset: () => void;
  /** Whether this is the desktop app, where a native window exists to blur. */
  desktopAvailable: boolean;
  windowMaterial: WindowMaterial;
  onWindowMaterial: (material: WindowMaterial) => void;
  personaPreset: PersonaPreset;
  personaCustom: string;
  onPersonaPreset: (preset: PersonaPreset) => void;
  onPersonaCustom: (custom: string) => void;
}

/**
 * What the colour swatch should show when nothing has been chosen yet — the
 * theme's own colour, read back off the page. An <input type="color"> has no
 * "unset" state, so it has to be given something concrete to display.
 */
function currentChannels(variable: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const raw = getComputedStyle(document.documentElement)
    .getPropertyValue(variable)
    .trim();
  const parts = raw.split(/[\s,]+/).map(Number);
  if (parts.length < 3 || parts.some(Number.isNaN)) return fallback;
  return (
    "#" +
    parts
      .slice(0, 3)
      .map((n) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, "0"))
      .join("")
  );
}

/** 1.0 → "100%", so the default reads as the neutral position. */
function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function Settings({
  open,
  onClose,
  appearance,
  onUiOpacity,
  onTextOpacity,
  onLiveCaption,
  onTextColor,
  onBgColor,
  onReset,
  desktopAvailable,
  windowMaterial,
  onWindowMaterial,
  personaPreset,
  personaCustom,
  onPersonaPreset,
  onPersonaCustom,
}: SettingsProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Click-away and Escape, so the panel never traps the user — it floats over
  // the console and there's no other obvious way out of it.
  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (panelRef.current && !panelRef.current.contains(target)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };

    // Deferred so the click that opened the panel doesn't immediately close it.
    const id = setTimeout(() => document.addEventListener("mousedown", onPointerDown));
    document.addEventListener("keydown", onKeyDown);
    return () => {
      clearTimeout(id);
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, onClose]);

  if (!open) return null;

  const isDefault =
    appearance.ui === DEFAULT_APPEARANCE.ui &&
    appearance.text === DEFAULT_APPEARANCE.text &&
    appearance.liveCaption === DEFAULT_APPEARANCE.liveCaption &&
    appearance.textColor === DEFAULT_APPEARANCE.textColor &&
    appearance.bgColor === DEFAULT_APPEARANCE.bgColor;

  const textSwatch = appearance.textColor ?? currentChannels("--text-rgb", "#ffffff");
  const bgSwatch = appearance.bgColor ?? currentChannels("--surface-rgb", "#12141c");

  return (
    <div className="settings-panel" ref={panelRef} role="dialog" aria-label="Settings">
      <div className="settings-head">
        <span>Settings</span>
        <button className="icon-btn" onClick={onClose} title="Close">
          ×
        </button>
      </div>

      <div className="settings-row">
        <span className="settings-label">Colours</span>
        <div className="settings-colors">
          <label className="settings-color">
            <input
              type="color"
              value={textSwatch}
              onChange={(e) => onTextColor(e.target.value)}
              aria-label="Text colour"
            />
            <span>Text</span>
          </label>
          <label className="settings-color">
            <input
              type="color"
              value={bgSwatch}
              onChange={(e) => onBgColor(e.target.value)}
              aria-label="Background colour"
            />
            <span>Background</span>
          </label>
          <button
            className="link-btn"
            onClick={() => {
              onTextColor(null);
              onBgColor(null);
            }}
            disabled={!appearance.textColor && !appearance.bgColor}
            title="Go back to the colours this theme normally uses"
          >
            Theme colours
          </button>
        </div>
        <span className="settings-hint">
          Saved, and kept when you reopen the app. A chosen colour applies to
          Dark, Light and Glass alike — clear it to let each theme use its own.
        </span>
      </div>

      <label className="settings-row">
        <span className="settings-label">
          Background opacity{" "}
          <span className="settings-value">{percent(appearance.ui)}</span>
        </span>
        <input
          type="range"
          min={UI_OPACITY_RANGE.min}
          max={UI_OPACITY_RANGE.max}
          step={UI_OPACITY_RANGE.step}
          value={appearance.ui}
          onChange={(e) => onUiOpacity(Number(e.target.value))}
        />
        <span className="settings-hint">
          Left is more see-through, right is more solid.
        </span>
      </label>

      <label className="settings-row">
        <span className="settings-label">
          Text opacity{" "}
          <span className="settings-value">{percent(appearance.text)}</span>
        </span>
        <input
          type="range"
          min={TEXT_OPACITY_RANGE.min}
          max={TEXT_OPACITY_RANGE.max}
          step={TEXT_OPACITY_RANGE.step}
          value={appearance.text}
          onChange={(e) => onTextOpacity(Number(e.target.value))}
        />
        <span className="settings-hint">
          Fades the writing without touching the panels behind it.
        </span>
      </label>

      <p className="settings-note muted">
        Only the Glass theme lets the desktop through — Dark and Light paint an
        opaque backdrop, so these mainly change how the panels sit against it.
      </p>

      <div className="settings-row">
        <span className="settings-label">Window blur</span>
        <div className="settings-colors">
          <button
            type="button"
            className={`theme-toggle settings-btn${windowMaterial === "acrylic" ? " on" : ""}`}
            disabled={!desktopAvailable}
            onClick={() => onWindowMaterial("acrylic")}
          >
            Frosted
          </button>
          <button
            type="button"
            className={`theme-toggle settings-btn${windowMaterial === "clear" ? " on" : ""}`}
            disabled={!desktopAvailable}
            onClick={() => onWindowMaterial("clear")}
          >
            Clear
          </button>
        </div>
        <span className="settings-hint">
          {desktopAvailable
            ? "Frosted blurs the desktop behind the window (Windows' fixed Acrylic blur — not adjustable). Clear shows it through sharp, with no blur at all. Switching rebuilds the window, so it'll flash briefly."
            : "Desktop-only — the browser build has no native window to blur."}
        </span>
      </div>

      <label className="settings-toggle">
        <input
          type="checkbox"
          checked={appearance.liveCaption}
          onChange={(e) => onLiveCaption(e.target.checked)}
        />
        <span>
          <span className="settings-label">Live caption while speaking</span>
          <span className="settings-hint">
            Shows words as you talk, by re-transcribing speech in progress.
            Costs a second or two of CPU per update and shares the transcriber
            with the real thing, so on a slower machine it can make listening
            sluggish and delay answers. Off is the reliable setting.
          </span>
        </span>
      </label>

      <div className="settings-row">
        <span className="settings-label">AI answer style</span>
        <div className="settings-colors">
          {PERSONA_OPTIONS.map(({ value, label }) => (
            <button
              key={value}
              type="button"
              className={`theme-toggle settings-btn${personaPreset === value ? " on" : ""}`}
              onClick={() => onPersonaPreset(value)}
            >
              {label}
            </button>
          ))}
        </div>
        {personaPreset === "custom" ? (
          <textarea
            className="edit-input qa-answer-input"
            placeholder='e.g. "Answer like a calm, no-nonsense senior engineer" or "Keep it playful and a bit sarcastic"'
            value={personaCustom}
            maxLength={300}
            rows={3}
            onChange={(e) => onPersonaCustom(e.target.value)}
          />
        ) : null}
        <span className="settings-hint">
          Shapes the tone Claude answers in — Default leaves its own natural
          voice alone. Doesn't change what it says, just how it says it.
        </span>
      </div>

      <button className="link-btn" onClick={onReset} disabled={isDefault}>
        Reset to default
      </button>
    </div>
  );
}
