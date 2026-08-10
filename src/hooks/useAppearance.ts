import { useCallback, useEffect, useState } from "react";

// How see-through the window is depends entirely on what's behind it — a busy
// wallpaper needs more tint than a plain one, and that's a matter of taste
// besides. So rather than baking in one answer, both alphas are user
// settings that drive the --ui-opacity / --text-opacity variables the theme
// palettes are written against (see src/index.css).

const STORAGE_KEY = "appearance";

/** 1 is the designed look; higher is more solid, lower more see-through. */
export const UI_OPACITY_RANGE = { min: 0.3, max: 2.5, step: 0.05 } as const;
/** Text can be faded, but never past the point of being unreadable. */
export const TEXT_OPACITY_RANGE = { min: 0.5, max: 1, step: 0.02 } as const;

export interface Appearance {
  /** Multiplier applied to every translucent surface's alpha. */
  ui: number;
  /** Multiplier applied to the text colours' alpha. */
  text: number;
  /**
   * Re-transcribe speech while it's still being spoken, so the text appears
   * as you talk.
   *
   * Off by default, and deliberately so: each preview costs a second or two
   * of CPU, and the transcriber handles one request at a time — so on a
   * modest machine the previews compete with the transcription you're
   * actually waiting for and make listening feel unreliable.
   */
  liveCaption: boolean;
  /**
   * Custom colours as "#rrggbb", or null to keep whatever the current theme
   * uses. Null rather than a concrete default on purpose: an unset colour
   * follows the theme when you switch between Dark, Light and Glass, while a
   * chosen one deliberately overrides all three.
   */
  textColor: string | null;
  bgColor: string | null;
}

export const DEFAULT_APPEARANCE: Appearance = {
  ui: 1,
  text: 1,
  liveCaption: false,
  textColor: null,
  bgColor: null,
};

const HEX = /^#[0-9a-f]{6}$/i;

/** "#1e2233" → "30 34 51", the bare triple CSS colour functions want. */
function hexToChannels(hex: string): string | null {
  if (!HEX.test(hex)) return null;
  const n = parseInt(hex.slice(1), 16);
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
}

/** Darkens a hex colour toward black — used for the page behind the panels. */
function darken(hex: string, amount: number): string | null {
  if (!HEX.test(hex)) return null;
  const n = parseInt(hex.slice(1), 16);
  const scale = (v: number) => Math.round(v * (1 - amount));
  const r = scale((n >> 16) & 255);
  const g = scale((n >> 8) & 255);
  const b = scale(n & 255);
  return `rgb(${r} ${g} ${b})`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function load(): Appearance {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_APPEARANCE;
    const parsed = JSON.parse(raw) as Partial<Appearance>;
    return {
      ui: clamp(
        Number(parsed.ui) || DEFAULT_APPEARANCE.ui,
        UI_OPACITY_RANGE.min,
        UI_OPACITY_RANGE.max,
      ),
      text: clamp(
        Number(parsed.text) || DEFAULT_APPEARANCE.text,
        TEXT_OPACITY_RANGE.min,
        TEXT_OPACITY_RANGE.max,
      ),
      liveCaption: parsed.liveCaption === true,
      textColor: typeof parsed.textColor === "string" && HEX.test(parsed.textColor)
        ? parsed.textColor
        : null,
      bgColor: typeof parsed.bgColor === "string" && HEX.test(parsed.bgColor)
        ? parsed.bgColor
        : null,
    };
  } catch {
    // Corrupt or unreadable storage shouldn't stop the app from rendering.
    return DEFAULT_APPEARANCE;
  }
}

export function useAppearance() {
  const [appearance, setAppearance] = useState<Appearance>(load);

  useEffect(() => {
    const root = document.documentElement;
    root.style.setProperty("--ui-opacity", String(appearance.ui));
    root.style.setProperty("--text-opacity", String(appearance.text));

    // Removing the property (rather than writing a default) is what lets an
    // unset colour fall back to whatever the active theme defines.
    const textChannels = appearance.textColor && hexToChannels(appearance.textColor);
    if (textChannels) root.style.setProperty("--text-rgb", textChannels);
    else root.style.removeProperty("--text-rgb");

    const surfaceChannels = appearance.bgColor && hexToChannels(appearance.bgColor);
    if (surfaceChannels) {
      root.style.setProperty("--surface-rgb", surfaceChannels);
      // The page behind the panels, for the opaque themes. A touch darker than
      // the panels themselves so they still read as sitting on top of it.
      const backdrop = darken(appearance.bgColor as string, 0.55);
      if (backdrop) root.style.setProperty("--desktop", backdrop);
    } else {
      root.style.removeProperty("--surface-rgb");
      root.style.removeProperty("--desktop");
    }

    localStorage.setItem(STORAGE_KEY, JSON.stringify(appearance));
  }, [appearance]);

  const setUiOpacity = useCallback((ui: number) => {
    setAppearance((prev) => ({ ...prev, ui }));
  }, []);

  const setTextOpacity = useCallback((text: number) => {
    setAppearance((prev) => ({ ...prev, text }));
  }, []);

  const setLiveCaption = useCallback((liveCaption: boolean) => {
    setAppearance((prev) => ({ ...prev, liveCaption }));
  }, []);

  const setTextColor = useCallback((textColor: string | null) => {
    setAppearance((prev) => ({ ...prev, textColor }));
  }, []);

  const setBgColor = useCallback((bgColor: string | null) => {
    setAppearance((prev) => ({ ...prev, bgColor }));
  }, []);

  const reset = useCallback(() => setAppearance(DEFAULT_APPEARANCE), []);

  return {
    appearance,
    setUiOpacity,
    setTextOpacity,
    setLiveCaption,
    setTextColor,
    setBgColor,
    reset,
  };
}
