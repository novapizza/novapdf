import { describe, expect, it } from "vitest";
import { whenOpened } from "./recent";

const at = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime();

describe("whenOpened", () => {
  const now = at(2026, 11, 28, 9);

  it("counts calendar days, not 24-hour spans", () => {
    expect(whenOpened(at(2026, 11, 28, 0), now)).toBe("Today");
    // Late last night is yesterday, though fewer than 24 hours ago.
    expect(whenOpened(at(2026, 11, 27, 23), now)).toBe("Yesterday");
    expect(whenOpened(at(2026, 11, 25), now)).toBe("3 days ago");
    expect(whenOpened(at(2026, 11, 22), now)).toBe("6 days ago");
  });

  it("a time in the future (a clock that moved) reads as today", () => {
    expect(whenOpened(at(2026, 12, 1), now)).toBe("Today");
  });

  it("older than a week shows the date, with the year only when it differs", () => {
    const thisYear = whenOpened(at(2026, 3, 4), now);
    expect(thisYear).toBe(new Date(at(2026, 3, 4)).toLocaleDateString(undefined, { day: "numeric", month: "short" }));
    const lastYear = whenOpened(at(2025, 3, 4), now);
    expect(lastYear).toContain("2025");
  });

  it("uses the current time by default", () => {
    expect(whenOpened(Date.now())).toBe("Today");
  });
});
