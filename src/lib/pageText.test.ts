import { describe, expect, it } from "vitest";
import { loadPageText } from "./pageText";
import { tauriMock } from "../test/tauri";
import { pageText } from "../test/fixtures";

// The cache is module state, so each test uses its own doc ids.

describe("loadPageText", () => {
  it("extracts once per page and serves repeats from the cache", async () => {
    tauriMock.handle("extract_page", () => pageText());
    const a = loadPageText(100, 0);
    const b = loadPageText(100, 0);
    expect(b).toBe(a);
    await a;
    await loadPageText(100, 1);
    expect(tauriMock.calls("extract_page")).toEqual([
      { docId: 100, pageIndex: 0 },
      { docId: 100, pageIndex: 1 },
    ]);
  });

  it("forgets failures so the next call retries", async () => {
    let fail = true;
    tauriMock.handle("extract_page", () => {
      if (fail) throw new Error("worker crashed");
      return pageText();
    });
    await expect(loadPageText(200, 0)).rejects.toThrow("worker crashed");
    fail = false;
    await expect(loadPageText(200, 0)).resolves.toEqual(pageText());
    expect(tauriMock.calls("extract_page")).toHaveLength(2);
  });

  it("evicts the least recently used entry beyond 500 pages", async () => {
    tauriMock.handle("extract_page", () => pageText());
    await loadPageText(300, 0);
    for (let i = 1; i <= 499; i++) loadPageText(300, i);
    loadPageText(300, 0); // touch: now most recent
    loadPageText(300, 500); // evicts page 1, not page 0
    tauriMock.invoke.mockClear();
    loadPageText(300, 0);
    expect(tauriMock.calls("extract_page")).toEqual([]);
    loadPageText(300, 1);
    expect(tauriMock.calls("extract_page")).toEqual([{ docId: 300, pageIndex: 1 }]);
  });
});
