import { useEffect, useState } from "react";

/** "system" follows the OS light/dark setting; the others pin it. */
export type ThemePref = "system" | "light" | "dark";

const KEY = "novapdf.theme";
const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");

export function loadThemePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === "light" || v === "dark" || v === "system") return v;
  } catch {
    /* storage unavailable: fall back to system */
  }
  return "system";
}

/** Sets data-theme on <html> to the resolved theme; App.css keys dark tokens off it. */
export function applyTheme(pref: ThemePref) {
  const dark = pref === "dark" || (pref === "system" && darkQuery.matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

/** Theme preference state: persisted, applied to the document, and live-updated when the OS setting changes. */
export function useTheme(): [ThemePref, (p: ThemePref) => void] {
  const [pref, setPref] = useState<ThemePref>(loadThemePref);

  useEffect(() => {
    applyTheme(pref);
    try {
      localStorage.setItem(KEY, pref);
    } catch {
      /* not persisted this time */
    }
    if (pref !== "system") return;
    const onChange = () => applyTheme("system");
    darkQuery.addEventListener("change", onChange);
    return () => darkQuery.removeEventListener("change", onChange);
  }, [pref]);

  return [pref, setPref];
}
