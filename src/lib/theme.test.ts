import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";

const KEY = "novapdf.theme";

/** theme.ts reads matchMedia once at import, so each test imports it fresh. */
async function loadTheme(osDark: boolean) {
  const listeners = new Set<() => void>();
  const query = {
    matches: osDark,
    addEventListener: vi.fn((_: string, cb: () => void) => listeners.add(cb)),
    removeEventListener: vi.fn((_: string, cb: () => void) => listeners.delete(cb)),
  };
  vi.spyOn(window, "matchMedia").mockReturnValue(query as unknown as MediaQueryList);
  vi.resetModules();
  const mod = await import("./theme");
  const setOs = (dark: boolean) => {
    query.matches = dark;
    for (const l of listeners) l();
  };
  return { ...mod, query, setOs };
}

afterEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});

describe("loadThemePref", () => {
  it("defaults to system and ignores junk", async () => {
    const { loadThemePref } = await loadTheme(false);
    expect(loadThemePref()).toBe("system");
    localStorage.setItem(KEY, "purple");
    expect(loadThemePref()).toBe("system");
    localStorage.setItem(KEY, "dark");
    expect(loadThemePref()).toBe("dark");
  });

  it("falls back to system when storage throws", async () => {
    const { loadThemePref } = await loadTheme(false);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(loadThemePref()).toBe("system");
  });
});

describe("applyTheme", () => {
  it("pins light/dark and resolves system from the OS", async () => {
    const { applyTheme } = await loadTheme(true);
    applyTheme("light");
    expect(document.documentElement.dataset.theme).toBe("light");
    applyTheme("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    applyTheme("system");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});

describe("useTheme", () => {
  it("persists the choice and applies it", async () => {
    const { useTheme } = await loadTheme(false);
    const { result } = renderHook(() => useTheme());
    expect(result.current[0]).toBe("system");
    act(() => result.current[1]("dark"));
    expect(result.current[0]).toBe("dark");
    expect(localStorage.getItem(KEY)).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("follows OS changes only while on system", async () => {
    const { useTheme, setOs, query } = await loadTheme(false);
    const { result } = renderHook(() => useTheme());
    expect(document.documentElement.dataset.theme).toBe("light");
    act(() => setOs(true));
    expect(document.documentElement.dataset.theme).toBe("dark");

    act(() => result.current[1]("light"));
    expect(query.removeEventListener).toHaveBeenCalled();
    act(() => setOs(true));
    expect(document.documentElement.dataset.theme).toBe("light");
  });

  it("still works when storage cannot be written", async () => {
    const { useTheme } = await loadTheme(false);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    const { result } = renderHook(() => useTheme());
    act(() => result.current[1]("dark"));
    expect(document.documentElement.dataset.theme).toBe("dark");
  });
});
