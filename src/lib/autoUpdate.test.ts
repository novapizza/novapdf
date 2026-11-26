import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { loadAutoUpdate, useAutoUpdate } from "./autoUpdate";

const KEY = "novapdf.autoUpdate";

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

describe("loadAutoUpdate", () => {
  it("defaults to on and only an explicit 0 turns it off", () => {
    expect(loadAutoUpdate()).toBe(true);
    localStorage.setItem(KEY, "0");
    expect(loadAutoUpdate()).toBe(false);
    localStorage.setItem(KEY, "junk");
    expect(loadAutoUpdate()).toBe(true);
  });

  it("falls back to on when storage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(loadAutoUpdate()).toBe(true);
  });
});

describe("useAutoUpdate", () => {
  it("persists the choice", () => {
    const { result } = renderHook(() => useAutoUpdate());
    expect(result.current[0]).toBe(true);
    act(() => result.current[1](false));
    expect(result.current[0]).toBe(false);
    expect(localStorage.getItem(KEY)).toBe("0");
    act(() => result.current[1](true));
    expect(localStorage.getItem(KEY)).toBe("1");
  });

  it("still works when storage cannot be written", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    const { result } = renderHook(() => useAutoUpdate());
    act(() => result.current[1](false));
    expect(result.current[0]).toBe(false);
  });
});
