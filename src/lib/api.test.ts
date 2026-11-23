import { describe, expect, it } from "vitest";
import { api, errorMessage, type RenderRequest } from "./api";
import { EMPTY_EDITS, editsAreEmpty } from "./types";
import { tauriMock } from "../test/tauri";
import { JPEG_BYTES, block } from "../test/fixtures";

const req = (extra: Partial<RenderRequest> = {}): RenderRequest => ({
  docId: 1,
  pageIndex: 0,
  width: 240,
  format: "jpeg",
  rotation: 0,
  edits: null,
  watermark: null,
  priority: "thumb",
  ...extra,
});

describe("api", () => {
  it("passes command names and argument names the Rust side expects", async () => {
    for (const cmd of ["open_with_dialog", "open_dropped", "close_document", "extract_page", "find_watermarks", "save_with_dialog", "layout_text", "list_fonts", "check_update", "install_update"]) {
      tauriMock.handle(cmd, () => "ok");
    }
    await api.openWithDialog();
    await api.openDropped(["a.pdf"]);
    await api.closeDocument(3);
    await api.extractPage(3, 4);
    await api.findWatermarks(3, "DRAFT");
    await api.listFonts();
    const font = { family: "Helvetica", bold: false, italic: false };
    await api.layoutText({ text: "hi", font, size: 12, width: 100 });
    const save = { pages: [], watermark: null, sanitize: true, suggestedName: "x.pdf" };
    await api.saveWithDialog(save);
    await api.checkUpdate();
    await api.installUpdate();

    expect(tauriMock.calls("check_update")).toHaveLength(1);
    expect(tauriMock.calls("install_update")).toHaveLength(1);
    expect(tauriMock.calls("open_dropped")).toEqual([{ paths: ["a.pdf"] }]);
    expect(tauriMock.calls("close_document")).toEqual([{ docId: 3 }]);
    expect(tauriMock.calls("extract_page")).toEqual([{ docId: 3, pageIndex: 4 }]);
    expect(tauriMock.calls("find_watermarks")).toEqual([{ docId: 3, text: "DRAFT" }]);
    expect(tauriMock.calls("layout_text")).toEqual([{ args: { text: "hi", font, size: 12, width: 100 } }]);
    expect(tauriMock.calls("save_with_dialog")).toEqual([{ args: save }]);
  });

  it("renderPage drops empty edits and wraps bytes in a typed Blob", async () => {
    tauriMock.handle("render_page", () => JPEG_BYTES);
    const blob = await api.renderPage(req({ edits: EMPTY_EDITS }));
    expect(blob.type).toBe("image/jpeg");
    expect(blob.size).toBe(4);
    expect((tauriMock.calls("render_page")[0].args as RenderRequest).edits).toBeNull();

    const edits = { ...EMPTY_EDITS, blocks: [block("b")] };
    const png = await api.renderPage(req({ edits, format: "png" }));
    expect(png.type).toBe("image/png");
    expect((tauriMock.calls("render_page")[1].args as RenderRequest).edits).toBe(edits);
  });
});

describe("errorMessage", () => {
  it("reads strings, Errors and falls back otherwise", () => {
    expect(errorMessage("boom")).toBe("boom");
    expect(errorMessage(new Error("bad"))).toBe("bad");
    expect(errorMessage({ code: 1 })).toBe("Something went wrong.");
  });
});

describe("editsAreEmpty", () => {
  it("is true only when nothing is removed or added", () => {
    expect(editsAreEmpty(EMPTY_EDITS)).toBe(true);
    expect(editsAreEmpty({ ...EMPTY_EDITS, removedObjects: [1] })).toBe(false);
    expect(editsAreEmpty({ ...EMPTY_EDITS, removedAnnots: [1] })).toBe(false);
    expect(editsAreEmpty({ ...EMPTY_EDITS, blocks: [block("b")] })).toBe(false);
  });
});
