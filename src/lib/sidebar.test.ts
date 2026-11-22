import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { loadSidebarCollapsed, useSidebarCollapsed } from "./sidebar";

const KEY = "novapdf.sidebarCollapsed";

afterEach(() => localStorage.clear());

describe("loadSidebarCollapsed", () => {
  it("defaults to expanded and reads the stored flag", () => {
    expect(loadSidebarCollapsed()).toBe(false);
    localStorage.setItem(KEY, "1");
    expect(loadSidebarCollapsed()).toBe(true);
    localStorage.setItem(KEY, "junk");
    expect(loadSidebarCollapsed()).toBe(false);
  });

  it("falls back to expanded when storage throws", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(loadSidebarCollapsed()).toBe(false);
  });
});

describe("useSidebarCollapsed", () => {
  it("persists the choice", () => {
    const { result } = renderHook(() => useSidebarCollapsed());
    expect(result.current[0]).toBe(false);
    act(() => result.current[1](true));
    expect(result.current[0]).toBe(true);
    expect(localStorage.getItem(KEY)).toBe("1");
    act(() => result.current[1](false));
    expect(localStorage.getItem(KEY)).toBe("0");
  });

  it("still works when storage cannot be written", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    const { result } = renderHook(() => useSidebarCollapsed());
    act(() => result.current[1](true));
    expect(result.current[0]).toBe(true);
  });
});
