import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import { JPEG_BYTES, doc, page } from "../test/fixtures";

// A controllable IntersectionObserver. The thumbnails share one observer, created
// on first use, so each test loads fresh modules after installing this.
class FakeObserver {
  static instances: FakeObserver[] = [];
  observed = new Set<Element>();
  constructor(private cb: IntersectionObserverCallback) {
    FakeObserver.instances.push(this);
  }
  observe(el: Element) {
    this.observed.add(el);
  }
  unobserve(el: Element) {
    this.observed.delete(el);
  }
  disconnect() {}
  takeRecords() {
    return [];
  }
  show(el: Element, visible: boolean) {
    act(() =>
      this.cb([{ target: el, isIntersecting: visible } as IntersectionObserverEntry], this as unknown as IntersectionObserver),
    );
  }
}

let PageGrid: typeof import("./PageGrid").PageGrid;
let tauriMock: typeof import("../test/tauri").tauriMock;
const original = globalThis.IntersectionObserver;

beforeEach(async () => {
  FakeObserver.instances = [];
  globalThis.IntersectionObserver = FakeObserver as unknown as typeof IntersectionObserver;
  vi.resetModules();
  ({ PageGrid } = await import("./PageGrid"));
  tauriMock = (await import("../test/tauri")).tauriMock;
  tauriMock.handle("render_page", () => JPEG_BYTES);
});
afterEach(() => {
  globalThis.IntersectionObserver = original;
});

function grid(count: number) {
  const pages = Array.from({ length: count }, (_, i) => page(`p${i}`, 1, i));
  const { container, unmount } = render(
    <PageGrid
      pages={pages}
      docs={new Map([[1, doc(1, count, "a.pdf")]])}
      watermark={null}
      selection={new Set()}
      thumbWidth={170}
      onSelect={vi.fn()}
      onMove={vi.fn()}
      onOpenEditor={vi.fn()}
    />,
  );
  const boxes = [...container.querySelectorAll(".thumb-img")];
  const imgs = (i: number) => boxes[i].querySelectorAll("img").length;
  return { container, unmount, boxes, imgs };
}

describe("thumbnail visibility", () => {
  it("uses one observer for all thumbnails and stops watching on unmount", () => {
    const { boxes, unmount } = grid(4);
    expect(FakeObserver.instances).toHaveLength(1);
    expect(FakeObserver.instances[0].observed.size).toBe(boxes.length);
    unmount();
    expect(FakeObserver.instances[0].observed.size).toBe(0);
  });

  it("renders only thumbnails near the viewport, once each", async () => {
    const { boxes, imgs } = grid(3);
    const io = FakeObserver.instances[0];
    expect(tauriMock.calls("render_page")).toHaveLength(0);

    io.show(boxes[1], true);
    await waitFor(() => expect(imgs(1)).toBe(1));
    expect(imgs(0)).toBe(0);

    // Scrolled away and back: the <img> stays (Chromium discards off-screen decoded
    // bitmaps itself), and the cached render is reused.
    io.show(boxes[1], false);
    expect(imgs(1)).toBe(1);
    io.show(boxes[1], true);
    expect(imgs(1)).toBe(1);
    expect(tauriMock.calls("render_page")).toHaveLength(1);
  });
});
