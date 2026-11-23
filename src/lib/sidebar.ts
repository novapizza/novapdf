import { useEffect, useState } from "react";

const KEY = "novapdf.sidebarCollapsed";

export function loadSidebarCollapsed(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    /* storage unavailable: start expanded */
    return false;
  }
}

/** Whether the left menu is collapsed to icons only. Persisted across launches. */
export function useSidebarCollapsed(): [boolean, (v: boolean) => void] {
  const [collapsed, setCollapsed] = useState<boolean>(loadSidebarCollapsed);

  useEffect(() => {
    try {
      localStorage.setItem(KEY, collapsed ? "1" : "0");
    } catch {
      /* not persisted this time */
    }
  }, [collapsed]);

  return [collapsed, setCollapsed];
}
