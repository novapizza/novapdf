import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RenderRequest } from "./api";

// renderCache keeps module state (cache, queue), so each test gets a fresh copy.
// The Tauri mock is re-imported after the reset so it is the same instance the
// fresh renderCache talks to.
let rc: typeof import("./renderCache");
let tauriMock: typeof import("../test/tauri").tauriMock;
beforeEach(async () => {
  vi.resetModules();
  rc = await import("./renderCache");
  tauriMock = (await import("../test/tauri")).tauriMock;
});

let n = 0;
const req = (extra: Partial<RenderRequest> = {}): RenderRequest => ({
  docId: 1,
  pageIndex: n++,
  width: 240,
  format: "jpeg",
  rotation: 0,
  edits: null,
  watermark: null,
  priority: "thumb",
  ...extra,
});

/** A render backend whose replies the test releases by hand. */
function manualBackend(bytes = 4) {
  const pending: { args: RenderRequest; resolve: () => void; reject: (e: unknown) => void }[] = [];
  tauriMock.handle(
    "render_page",
    (a) =>
      new Promise((resolve, reject) =>
        pending.push({ args: a.args as RenderRequest, resolve: () => resolve(new Uint8Array(bytes).buffer), reject }),
      ),
  );
  return pending;
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("renderKey", () => {
  it("ignores priority but not anything that changes pixels", () => {
    const base = req();
    expect(rc.renderKey({ ...base, priority: "view" })).toBe(rc.renderKey({ ...base, priority: "thumb" }));
    expect(rc.renderKey({ ...base, width: 360 })).not.toBe(rc.renderKey(base));
    expect(rc.renderKey({ ...base, rotation: 90 })).not.toBe(rc.renderKey(base));
  });
});

describe("requestRender", () => {
  it("caches results: a second request does not hit the backend", async () => {
    tauriMock.handle("render_page", () => new Uint8Array(4).buffer);
    const r = req({ priority: "view" });
    const url = await rc.requestRender(r);
    expect(url).toMatch(/^blob:/);
    expect(rc.cached(r)).toBe(url);
    expect(await rc.requestRender(r)).toBe(url);
    expect(tauriMock.calls("render_page")).toHaveLength(1);
  });

  it("de-duplicates identical in-flight requests", async () => {
    const pending = manualBackend();
    const r = req({ priority: "view" });
    const a = rc.requestRender(r);
    const b = rc.requestRender({ ...r });
    expect(pending).toHaveLength(1);
    pending[0].resolve();
    expect(await a).toBe(await b);
  });

  it("runs at most three thumbnails at once, newest first", async () => {
    const pending = manualBackend();
    const reqs = Array.from({ length: 5 }, () => req());
    const results = reqs.map((r) => rc.requestRender(r));
    expect(pending.map((p) => p.args.pageIndex)).toEqual(reqs.slice(0, 3).map((r) => r.pageIndex));
    pending[0].resolve();
    await flush();
    // The newest queued request (index 4) goes before the older one (index 3).
    expect(pending[3].args.pageIndex).toBe(reqs[4].pageIndex);
    for (const p of pending.slice(1)) p.resolve();
    await flush();
    pending[4].resolve();
    await Promise.all(results);
    expect(pending).toHaveLength(5);
  });

  it("view requests skip the thumbnail queue", async () => {
    const pending = manualBackend();
    for (let i = 0; i < 4; i++) rc.requestRender(req());
    expect(pending).toHaveLength(3);
    rc.requestRender(req({ priority: "view" }));
    expect(pending).toHaveLength(4);
  });

  it("drops queued thumbnails that were aborted before starting", async () => {
    const pending = manualBackend();
    for (let i = 0; i < 3; i++) rc.requestRender(req());
    const ctrl = new AbortController();
    const queued = rc.requestRender(req(), ctrl.signal);
    ctrl.abort();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
    pending[0].resolve();
    await flush();
    expect(pending).toHaveLength(3);
  });

  it("rejects a job whose signal aborted while it waited in the queue", async () => {
    const pending = manualBackend();
    for (let i = 0; i < 3; i++) rc.requestRender(req());
    const ctrl = new AbortController();
    const queued = rc.requestRender(req(), ctrl.signal);
    // Abort without the listener path: mark aborted, then let pump() find it.
    Object.defineProperty(ctrl.signal, "aborted", { value: true });
    pending[0].resolve();
    await expect(queued).rejects.toMatchObject({ name: "AbortError" });
  });

  it("a queued duplicate of an in-flight thumbnail shares its result", async () => {
    const pending = manualBackend();
    const view = req({ priority: "view" });
    const first = rc.requestRender(view);
    for (let i = 0; i < 3; i++) rc.requestRender(req());
    const dup = rc.requestRender({ ...view, priority: "thumb" });
    expect(dup).toBe(first);
    pending[0].resolve();
    expect(await dup).toBe(await first);
  });

  it("queued jobs whose key became in-flight share it", async () => {
    const pending = manualBackend();
    const fillers = Array.from({ length: 3 }, () => req());
    for (const f of fillers) rc.requestRender(f);
    const r = req();
    const queued = rc.requestRender(r);
    // Same key starts as a view render while the thumb waits.
    rc.requestRender({ ...r, priority: "view" });
    pending[0].resolve();
    await flush();
    pending[3].resolve();
    await expect(queued).resolves.toMatch(/^blob:/);
    expect(pending).toHaveLength(4);
  });

  it("propagates backend errors and does not cache them", async () => {
    let fail = true;
    tauriMock.handle("render_page", () => {
      if (fail) throw new Error("render failed");
      return new Uint8Array(4).buffer;
    });
    const r = req();
    await expect(rc.requestRender(r)).rejects.toThrow("render failed");
    fail = false;
    await expect(rc.requestRender(r)).resolves.toMatch(/^blob:/);
  });

  it("evicts old entries past the byte budget and revokes their URLs", async () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
    let u = 0;
    vi.spyOn(URL, "createObjectURL").mockImplementation(() => `blob:big/${++u}`);
    // 200 MB each: the budget (384 MB) holds one.
    tauriMock.handle("render_page", () => ({ byteLength: 0 }));
    const big = 200 * 1024 * 1024;
    vi.spyOn(globalThis, "Blob").mockImplementation(function (this: Blob) {
      return { size: big, type: "image/jpeg" } as Blob;
    } as unknown as typeof Blob);
    const a = req({ priority: "view" });
    const b = req({ priority: "view" });
    await rc.requestRender(a);
    await rc.requestRender(b);
    expect(rc.cached(a)).toBeUndefined();
    expect(rc.cached(b)).toBeDefined();
    expect(revoke).toHaveBeenCalledTimes(1);
  });
});
