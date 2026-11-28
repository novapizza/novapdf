// The recent files list as the Library shows it. The list itself lives in Rust
// (src-tauri/src/recent.rs); the UI only gets names to show and ids to open them by.

const DAY_MS = 24 * 60 * 60 * 1000;

/** Midnight at the start of the local day that `ms` falls in. */
function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** "Today", "Yesterday", "3 days ago" for the last week, then the date. */
export function whenOpened(openedAt: number, now: number = Date.now()): string {
  const days = Math.round((startOfDay(now) - startOfDay(openedAt)) / DAY_MS);
  if (days <= 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  const date = new Date(openedAt);
  const sameYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleDateString(undefined, sameYear ? { day: "numeric", month: "short" } : { day: "numeric", month: "short", year: "numeric" });
}
