import { useCallback, useEffect, useState } from "react";

export type Theme = "dark" | "light" | "transparent";

const STORAGE_KEY = "theme";

// The toggle cycles through these in order.
const CYCLE: Theme[] = ["dark", "light", "transparent"];

// Respects a saved choice first; otherwise falls back to the OS-level
// light/dark preference so a first-time visitor doesn't have to reach
// for the toggle at all.
function getInitialTheme(): Theme {
  const stored = localStorage.getItem(STORAGE_KEY);
  if (stored === "dark" || stored === "light" || stored === "transparent") return stored;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches
    ? "light"
    : "dark";
}

export function useTheme() {
  const [theme, setTheme] = useState<Theme>(getInitialTheme);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(STORAGE_KEY, theme);
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme((prev) => CYCLE[(CYCLE.indexOf(prev) + 1) % CYCLE.length]);
  }, []);

  return { theme, toggleTheme };
}
