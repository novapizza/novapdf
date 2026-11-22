// Global test setup: browser APIs that jsdom lacks, and Tauri mocked out.
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";
import { tauriMock } from "./tauri";

afterEach(() => {
  cleanup();
  tauriMock.reset();
  // Persisted UI preferences (theme, sidebar) must not leak between tests.
  localStorage.clear();
});

// theme.ts reads matchMedia at import time.
if (!window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: vi.fn((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
}

class NoopObserver {
  constructor(private cb?: (entries: unknown[], obs: unknown) => void) {}
  observe(el: Element) {
    // Report everything as visible so thumbnails request renders.
    this.cb?.([{ isIntersecting: true, target: el }], this);
  }
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return [];
  }
}
globalThis.ResizeObserver ??= NoopObserver as unknown as typeof ResizeObserver;
globalThis.IntersectionObserver ??= NoopObserver as unknown as typeof IntersectionObserver;

// Canvas text measurement: a fixed-advance font (0.5 em per character), so wrap
// estimates are predictable in tests.
HTMLCanvasElement.prototype.getContext = function getContext() {
  const ctx = {
    font: "10px sans-serif",
    measureText(text: string) {
      const size = Number(/(\d+(?:\.\d+)?)px/.exec(ctx.font)?.[1] ?? 10);
      return { width: text.length * size * 0.5 } as TextMetrics;
    },
  };
  return ctx;
} as unknown as typeof HTMLCanvasElement.prototype.getContext;

let urlCount = 0;
URL.createObjectURL ??= () => `blob:test/${++urlCount}`;
URL.revokeObjectURL ??= () => {};
Element.prototype.scrollIntoView ??= function scrollIntoView() {};
Element.prototype.setPointerCapture ??= function setPointerCapture() {};
Element.prototype.releasePointerCapture ??= function releasePointerCapture() {};

// Tauri: no backend in unit tests. Tests set behaviour with tauriMock (see ./tauri.ts).
vi.mock("@tauri-apps/api/core", async () => (await import("./tauri")).coreModule);
vi.mock("@tauri-apps/api/event", async () => (await import("./tauri")).eventModule);
vi.mock("@tauri-apps/api/window", async () => (await import("./tauri")).windowModule);
vi.mock("@tauri-apps/plugin-dialog", async () => (await import("./tauri")).dialogModule);
