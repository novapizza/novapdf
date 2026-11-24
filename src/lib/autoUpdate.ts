import { useEffect, useState } from "react";

const KEY = "novapdf.autoUpdate";

/** How often a running app looks for a newer version, after the check at launch. */
export const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** On unless the user turned it off. */
export function loadAutoUpdate(): boolean {
  try {
    return localStorage.getItem(KEY) !== "0";
  } catch {
    /* storage unavailable: keep the default */
    return true;
  }
}

/**
 * Whether updates download in the background and install when the app quits.
 * Off means the user checks and installs from the command palette. Persisted.
 */
export function useAutoUpdate(): [boolean, (v: boolean) => void] {
  const [auto, setAuto] = useState<boolean>(loadAutoUpdate);

  useEffect(() => {
    try {
      localStorage.setItem(KEY, auto ? "1" : "0");
    } catch {
      /* not persisted this time */
    }
  }, [auto]);

  return [auto, setAuto];
}
