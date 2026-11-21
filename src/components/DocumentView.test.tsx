import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { useMemo, useReducer } from "react";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DocumentView } from "./DocumentView";
import { type Workspace, initialHistory, reducer } from "../state/workspace";
import type { LooseText, PageText } from "../lib/types";
import { tauriMock } from "../test/tauri";
import { JPEG_BYTES, doc, page, pageText, paragraph } from "../test/fixtures";

// jsdom has no layout: give the scroll area a real size so pages get a sensible scale.
const sizeProps = ["clientWidth", "clientHeight"] as const;
beforeAll(() => {
  Object.defineProperty(HTMLElement.prototype, "clientWidth", { configurable: true, get: () => 900 });
  Object.defineProperty(HTMLElement.prototype, "clientHeight", { configurable: true, get: () => 2000 });
});
afterAll(() => {
  for (const p of sizeProps) delete (HTMLElement.prototype as unknown as Record<string, unknown>)[p];
});

const WM_LOOSE: LooseText = {
  objectIndex: 5,
  bounds: { x: 100, y: 300, width: 300, height: 60 },
  text: "DRAFT",
  rotated: true,
  transparent: true,
  watermarkMark: true,
};
/** Page 1 ends with a two-line paragraph; page 2 starts with one. */
const TEXT: PageText[] = [
  pageText({
    paragraphs: [
      paragraph(1, {
        objectIndices: [10, 11],
        text: "Bottom of page one",
        firstBaseline: 700,
        lineCount: 2,
        lineHeight: 1.25,
        bounds: { x: 72, y: 690, width: 300, height: 30 },
      }),
    ],
    loose: [WM_LOOSE],
  }),
  pageText({
    paragraphs: [
      paragraph(2, {
        objectIndices: [20],
        text: "top of page two",
        firstBaseline: 80,
        lineCount: 1,
        bounds: { x: 72, y: 70, width: 300, height: 14 },
      }),
    ],
  }),
];

let docCounter = 1000; // page text is cached per doc id: a fresh id per test
interface Opts {
  mode?: "read" | "edit";
  text?: PageText[];
  layoutLines?: (args: { text: string; hScale?: number }) => number;
  extract?: (args: Record<string, unknown>) => unknown;
  /** A plain document of this many pages instead of the two-page default. */
  pages?: number;
}

function setup(opts: Opts = {}) {
  const docId = docCounter++;
  const notify = vi.fn();
  const onExitEdit = vi.fn();
  const onRemoveEverywhere = vi.fn();
  const onWatermark = vi.fn();
  const state: { ws: Workspace } = { ws: initialHistory.present };
  tauriMock.handle("render_page", () => JPEG_BYTES);
  tauriMock.handle("extract_page", opts.extract ?? ((a) => (opts.text ?? TEXT)[a.pageIndex as number]));
  tauriMock.handle("layout_text", (a) => {
    const args = a.args as { text: string; hScale?: number };
    const n = opts.layoutLines?.(args) ?? 1;
    return { lineStarts: Array.from({ length: n }, (_, i) => Math.min(i * 5, Math.max(0, args.text.length - 1))) };
  });

  function Harness() {
    const [h, dispatch] = useReducer(reducer, undefined, () =>
      reducer(initialHistory, {
        type: "reset",
        pages: opts.pages
          ? Array.from({ length: opts.pages }, (_, i) => page(i ? `P${i}` : "A", docId, i))
          : [page("A", docId, 0), page("B", docId, 1, { rotation: 90 })],
      }),
    );
    state.ws = h.present;
    const docs = useMemo(() => new Map([[docId, doc(docId, opts.pages ?? 2)]]), []);
    return (
      <DocumentView
        pages={h.present.pages}
        docs={docs}
        links={h.present.links}
        watermark={null}
        fonts={["Helvetica", "Times"]}
        mode={opts.mode ?? "edit"}
        initialPageId="A"
        onCurrentPage={() => {}}
        onChangeEdits={(updates, links) => dispatch({ type: "setEdits", updates, links })}
        onExitEdit={onExitEdit}
        onRemoveEverywhere={onRemoveEverywhere}
        onWatermark={onWatermark}
        notify={notify}
      />
    );
  }
  const utils = render(<Harness />);
  const edits = (i: number) => state.ws.pages[i].edits;
  return { ...utils, docId, notify, onExitEdit, onRemoveEverywhere, onWatermark, state, edits };
}

const surface = (n: number) => document.querySelector<HTMLElement>(`.page-surface[data-page="${n}"]`)!;
const paraOverlay = async (n: number) => {
  await waitFor(() => expect(surface(n).querySelector(".ov-para")).not.toBeNull());
  return surface(n).querySelector<HTMLElement>(".ov-para")!;
};
const editor = () => screen.getByRole("textbox", { name: "" }) as HTMLTextAreaElement;
const press = (init: KeyboardEventInit) => fireEvent.keyDown(document.activeElement ?? document.body, init);

describe("DocumentView: reading", () => {
  it("renders pages with the real page image and no edit overlays", async () => {
    setup({ mode: "read" });
    expect(await screen.findByAltText("Page 1")).toHaveAttribute("src", expect.stringMatching(/^blob:/));
    expect(document.querySelector(".ov-para")).toBeNull();
    expect(screen.getByText("Read-only mode")).toBeInTheDocument();
    expect(tauriMock.calls("extract_page")).toHaveLength(0);
    // Read mode applies the app-level rotation.
    await waitFor(() =>
      expect(tauriMock.calls("render_page").some((c) => (c.args as { rotation: number }).rotation === 90)).toBe(true),
    );
  });

  it("zoom buttons and keyboard shortcuts", async () => {
    setup({ mode: "read" });
    const pill = screen.getByRole("toolbar", { name: "Page and zoom" });
    await userEvent.click(within(pill).getByRole("button", { name: "Zoom in" }));
    expect(pill).toHaveTextContent("120%");
    await userEvent.click(within(pill).getByRole("button", { name: "Zoom out" }));
    expect(pill).toHaveTextContent("100%");
    press({ key: "=", ctrlKey: true });
    expect(pill).toHaveTextContent("120%");
    press({ key: "0", ctrlKey: true });
    expect(pill).toHaveTextContent("100%");
    press({ key: "-", ctrlKey: true });
    expect(pill).toHaveTextContent("83%");
    await userEvent.click(within(pill).getByRole("button", { name: "Fit width" }));
    expect(pill).toHaveTextContent("100%");
    const scroll = document.querySelector(".doc-scroll")!;
    fireEvent.wheel(scroll, { deltaY: -100, ctrlKey: true });
    expect(pill).toHaveTextContent("110%");
    fireEvent.wheel(scroll, { deltaY: -100 }); // plain wheel scrolls, does not zoom
    expect(pill).toHaveTextContent("110%");
  });

  it("page number box: valid numbers jump, others reset", async () => {
    setup({ mode: "read" });
    const input = screen.getByRole("textbox", { name: "Page number" });
    const scroll = document.querySelector<HTMLElement>(".doc-scroll")!;
    await userEvent.click(input);
    await userEvent.keyboard("{Control>}a{/Control}2{Enter}");
    expect(scroll.scrollTop).toBeGreaterThan(500);
    await userEvent.click(input);
    await userEvent.keyboard("{Control>}a{/Control}99{Enter}");
    expect(input).toHaveValue("1");
    await userEvent.click(input);
    await userEvent.keyboard("{Control>}a{/Control}7{Escape}");
    expect(input).toHaveValue("1");
    await userEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(scroll.scrollTop).toBeGreaterThan(500);
  });

  it("filmstrip: tabs, thumbnails, and hiding it", async () => {
    setup({ mode: "read" });
    const strip = screen.getByRole("complementary", { name: "Pages" });
    expect(within(strip).getByRole("button", { name: "Go to page 1" })).toHaveAttribute("aria-current", "page");
    await userEvent.click(within(strip).getByRole("button", { name: "Go to page 2" }));
    expect(document.querySelector<HTMLElement>(".doc-scroll")!.scrollTop).toBeGreaterThan(500);
    await userEvent.click(within(strip).getByRole("tab", { name: "Outline" }));
    expect(screen.getByText("Outline not available yet")).toBeInTheDocument();
    await userEvent.click(within(strip).getByRole("tab", { name: "Marks" }));
    expect(screen.getByText("No marks yet")).toBeInTheDocument();
    await userEvent.click(within(strip).getByRole("tab", { name: /Pages/ }));
    await userEvent.click(screen.getByRole("button", { name: "Toggle page thumbnails" }));
    expect(screen.queryByRole("complementary", { name: "Pages" })).not.toBeInTheDocument();
  });

  it("jumping far renders the landing page first; pages seen before show at once", async () => {
    setup({ mode: "read", pages: 30 });
    const views = () =>
      tauriMock
        .calls("render_page")
        .map((c) => c.args as { pageIndex: number; format: string })
        .filter((a) => a.format === "png")
        .map((a) => a.pageIndex);
    expect(await screen.findByAltText("Page 1")).toBeInTheDocument();
    // Page 1 went first, at once; the pages below it follow after a short delay.
    expect(views()[0]).toBe(0);
    await waitFor(() => expect(views()).toEqual([0, 1, 2, 3]));
    const before = views().length;
    const scroll = document.querySelector<HTMLElement>(".doc-scroll")!;
    const strip = screen.getByRole("complementary", { name: "Pages" });
    await userEvent.click(within(strip).getByRole("button", { name: "Go to page 20" }));
    fireEvent.scroll(scroll);
    await waitFor(() => expect(surface(20)).not.toBeNull());
    // The landing page goes to the worker right away, ahead of its neighbours.
    expect(views().slice(before)).toEqual([19]);
    // Until its image arrives, the filmstrip thumbnail stands in.
    expect(surface(20).querySelector("img.placeholder")).not.toBeNull();
    expect(await screen.findByAltText("Page 20")).toBeInTheDocument();
    await waitFor(() => expect(views().length).toBeGreaterThan(before + 1));

    // Back to page 1: its image is cached, so it shows with no spinner and no render.
    await userEvent.click(within(strip).getByRole("button", { name: "Go to page 1" }));
    fireEvent.scroll(scroll);
    await waitFor(() => expect(surface(1)).not.toBeNull());
    expect(within(surface(1)).getByAltText("Page 1")).toBeInTheDocument();
    expect(surface(1).querySelector(".page-spinner")).toBeNull();
    expect(views().filter((i) => i === 0)).toHaveLength(1);
  });

  it("reports render failures", async () => {
    const { notify } = setup({ mode: "read" });
    tauriMock.handle("render_page", () => {
      throw "engine restarted";
    });
    // A zoom change triggers a new render at a new width.
    await userEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    await waitFor(() => expect(notify).toHaveBeenCalledWith(expect.stringContaining("engine restarted"), "error"));
  });
});

describe("DocumentView: editing text", () => {
  it("edits a paragraph in place: the original is removed and a block drawn", async () => {
    const { edits } = setup();
    expect(screen.getByRole("radiogroup", { name: "Edit tool" })).toBeInTheDocument();
    fireEvent.click(await paraOverlay(1));
    const ta = editor();
    expect(ta).toHaveValue("Bottom of page one");
    await userEvent.type(ta, " (revised)");
    fireEvent.keyDown(ta, { key: "Enter", ctrlKey: true });

    expect(edits(0).removedObjects).toEqual([10, 11]);
    expect(edits(0).blocks).toEqual([
      expect.objectContaining({ text: "Bottom of page one (revised)", x: 72, baseline: 700, width: 306, size: 12 }),
    ]);
    // The new block is selected in the inspector.
    expect(screen.getByRole("heading", { name: "Text box" })).toBeInTheDocument();
  });

  it("Escape cancels, and committing unchanged text changes nothing", async () => {
    const { edits } = setup();
    fireEvent.click(await paraOverlay(1));
    await userEvent.type(editor(), "xyz");
    fireEvent.keyDown(editor(), { key: "Escape" });
    expect(screen.queryByRole("textbox", { name: "" })).not.toBeInTheDocument();
    fireEvent.click(await paraOverlay(1));
    fireEvent.blur(editor());
    expect(edits(0).removedObjects).toEqual([]);
    expect(edits(0).blocks).toEqual([]);
  });

  it("clearing a paragraph deletes it", async () => {
    const { edits } = setup();
    fireEvent.click(await paraOverlay(1));
    await userEvent.clear(editor());
    fireEvent.blur(editor());
    expect(edits(0).removedObjects).toEqual([10, 11]);
    expect(edits(0).blocks).toEqual([]);
  });

  it("shows the line budget and can tighten letters to fit", async () => {
    // Too long at normal width; fits when narrowed below 95%.
    setup({ layoutLines: (a) => ((a.hScale ?? 1) < 0.95 ? 2 : 10) });
    fireEvent.click(await paraOverlay(1));
    const budget = await screen.findByText(/lines will overlap the text below/);
    expect(budget).toHaveTextContent("10 / 4 lines · 6 lines will overlap");
    await userEvent.click(screen.getByRole("button", { name: "Tighten to fit" }));
    expect(await screen.findByText("2 / 4 lines")).toBeInTheDocument();
    expect(editor().style.transform).toMatch(/scaleX\(0\.9/);
  });

  it("says when even narrower letters will not fit", async () => {
    const { notify } = setup({ layoutLines: () => 20 });
    fireEvent.click(await paraOverlay(1));
    await userEvent.click(await screen.findByRole("button", { name: "Tighten to fit" }));
    await waitFor(() => expect(notify).toHaveBeenCalledWith(expect.stringContaining("too long for the space"), "error"));
  });

  it("adds a text box with the text tool", async () => {
    const { edits } = setup();
    press({ key: "t" });
    expect(screen.getByRole("radio", { name: /Add Text/ })).toHaveAttribute("aria-checked", "true");
    fireEvent.click(surface(1), { clientX: 200, clientY: 100 });
    await userEvent.type(editor(), "New note");
    fireEvent.blur(editor());
    expect(edits(0).blocks).toEqual([expect.objectContaining({ text: "New note", font: expect.objectContaining({ family: "Helvetica" }) })]);
    expect(screen.getByRole("radio", { name: /Select/ })).toHaveAttribute("aria-checked", "true");
  });

  it("an empty new text box is discarded", async () => {
    const { edits } = setup();
    await userEvent.click(screen.getByRole("radio", { name: /Add Text/ }));
    fireEvent.click(surface(1), { clientX: 10, clientY: 10 });
    fireEvent.blur(editor());
    expect(edits(0).blocks).toEqual([]);
  });

  it("selects, restyles, drags, re-edits and deletes a text block", async () => {
    const { edits } = setup();
    // Create a block by editing the paragraph.
    fireEvent.click(await paraOverlay(1));
    await userEvent.type(editor(), "!");
    fireEvent.blur(editor());
    const blockEl = () => surface(1).querySelector<HTMLElement>(".ov-block")!;

    // Restyle from the inspector.
    await userEvent.click(screen.getByRole("button", { name: "Bold" }));
    expect(edits(0).blocks[0].font.bold).toBe(true);

    // Drag it 30 px right.
    const x0 = edits(0).blocks[0].x;
    fireEvent.pointerDown(blockEl(), { button: 0, clientX: 0, clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(blockEl(), { clientX: 30, clientY: 0, pointerId: 1 });
    fireEvent.pointerUp(blockEl(), { pointerId: 1 });
    expect(edits(0).blocks[0].x).toBeGreaterThan(x0);
    // A click without movement is not a move.
    const x1 = edits(0).blocks[0].x;
    fireEvent.pointerDown(blockEl(), { button: 0, clientX: 0, clientY: 0, pointerId: 1 });
    fireEvent.pointerUp(blockEl(), { pointerId: 1 });
    expect(edits(0).blocks[0].x).toBe(x1);

    // Enter re-opens it; Escape-free edit with Ctrl+Enter.
    press({ key: "Enter" });
    await userEvent.type(editor(), "?");
    fireEvent.keyDown(editor(), { key: "Enter", ctrlKey: true });
    expect(edits(0).blocks[0].text).toMatch(/!\?$/);

    // Double-click edits too; clearing removes the block.
    fireEvent.doubleClick(blockEl());
    await userEvent.clear(editor());
    fireEvent.blur(editor());
    expect(edits(0).blocks).toEqual([]);
  });

  it("Delete key removes the selected block; Escape clears selection, then exits", async () => {
    const { edits, onExitEdit } = setup();
    fireEvent.click(await paraOverlay(1));
    await userEvent.type(editor(), "!");
    fireEvent.blur(editor());
    fireEvent.pointerDown(surface(1).querySelector(".ov-block")!, { button: 0, pointerId: 1 });
    press({ key: "Delete" });
    expect(edits(0).blocks).toEqual([]);
    press({ key: "t" });
    press({ key: "Escape" }); // text tool → select tool
    expect(onExitEdit).not.toHaveBeenCalled();
    press({ key: "Escape" });
    expect(onExitEdit).toHaveBeenCalled();
  });

  it("watermark text: delete here, or remove on all pages", async () => {
    const { edits, onRemoveEverywhere, docId } = setup();
    await waitFor(() => expect(surface(1).querySelector(".ov-loose")).not.toBeNull());
    fireEvent.click(surface(1).querySelector(".ov-loose")!);
    expect(screen.getByRole("heading", { name: "Watermark" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Remove on all pages…" }));
    expect(onRemoveEverywhere).toHaveBeenCalledWith("DRAFT", docId);
    await userEvent.click(screen.getByRole("button", { name: "Delete here" }));
    expect(edits(0).removedObjects).toEqual([5]);
    expect(surface(1).querySelector(".ov-loose")).toBeNull();
  });

  it("deleting a selected paragraph, then restoring the page", async () => {
    const { edits } = setup();
    fireEvent.click(await paraOverlay(1));
    fireEvent.keyDown(editor(), { key: "Escape" });
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(edits(0).removedObjects).toEqual([10, 11]);
    await userEvent.click(screen.getByRole("button", { name: "Restore page 1 to original" }));
    expect(edits(0).removedObjects).toEqual([]);
  });

  it("Watermark Studio button", async () => {
    const { onWatermark } = setup();
    await userEvent.click(screen.getByRole("button", { name: /Watermark Studio/ }));
    expect(onWatermark).toHaveBeenCalled();
  });

  it("edit mode shows pages unrotated with a badge", async () => {
    setup();
    await waitFor(() => expect(surface(2)).not.toBeNull());
    expect(within(surface(2)).getByText(/Shown unrotated · 90° on save/)).toBeInTheDocument();
  });
});

describe("DocumentView: text extraction failure", () => {
  it("shows the error on the page and retries", async () => {
    let fail = true;
    setup({
      extract: (a) => {
        if (fail) throw "Text layer is damaged";
        return TEXT[a.pageIndex as number];
      },
    });
    const notice = await within(surface(1)).findByText(/Text could not be read on this page: Text layer is damaged/);
    fail = false;
    await userEvent.click(within(notice).getByRole("button", { name: "Retry" }));
    expect(await paraOverlay(1)).toBeTruthy();
    expect(within(surface(1)).queryByText(/could not be read/)).not.toBeInTheDocument();
  });
});

describe("DocumentView: paragraph across a page break", () => {
  async function linkParagraphs() {
    const s = setup();
    fireEvent.click(await paraOverlay(1));
    fireEvent.keyDown(editor(), { key: "Escape" });
    expect(screen.getByRole("heading", { name: "Paragraph" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continued from previous…" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Continues on next page…" }));
    expect(screen.getByText(/Click the paragraph on page 2 where this text continues/)).toBeInTheDocument();
    const target = await paraOverlay(2);
    expect(target).toHaveAttribute("title", "Link to this paragraph");
    fireEvent.click(target);
    expect(await screen.findByRole("heading", { name: "Paragraph across pages 1–2" })).toBeInTheDocument();
    return s;
  }

  it("links two halves, edits them as one and applies to both pages", async () => {
    const { edits, state } = await linkParagraphs();
    const ta = screen.getByRole("textbox", { name: "" });
    expect(ta).toHaveValue("Bottom of page one top of page two");
    await userEvent.type(ta, " more");
    const apply = screen.getByRole("button", { name: "Link and apply" });
    await waitFor(() => expect(apply).toBeEnabled());
    await userEvent.click(apply);

    expect(state.ws.links).toHaveLength(1);
    expect(edits(0).removedObjects).toEqual([10, 11]);
    expect(edits(1).removedObjects).toEqual([20]);
    expect(edits(0).blocks[0].text).toBe("Bottom of page one top of page two more");
    // The first half is selected and shown as linked.
    expect(screen.getByRole("heading", { name: "Linked paragraph · pages 1–2" })).toBeInTheDocument();

    // Restyle re-flows both halves.
    await userEvent.click(screen.getByRole("button", { name: "Align center" }));
    await waitFor(() => expect(edits(1).removedObjects).toEqual([20]));
    expect(edits(0).blocks[0].align).toBe("center");

    // Unlink keeps the text boxes but drops the link.
    await userEvent.click(screen.getByRole("button", { name: "Unlink" }));
    expect(state.ws.links).toEqual([]);
    expect(edits(0).blocks).toHaveLength(1);
  });

  it("deleting a linked half removes both halves", async () => {
    const { edits, state } = await linkParagraphs();
    await waitFor(() => expect(screen.getByRole("button", { name: "Link and apply" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "Link and apply" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete paragraph" }));
    expect(state.ws.links).toEqual([]);
    expect(edits(0).blocks).toEqual([]);
  });

  it("cancel leaves the page untouched", async () => {
    const { edits } = await linkParagraphs();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(edits(0)).toEqual({ removedObjects: [], removedAnnots: [], blocks: [] });
  });

  it("the pick can be cancelled from the banner or by clicking elsewhere", async () => {
    setup();
    fireEvent.click(await paraOverlay(1));
    fireEvent.keyDown(editor(), { key: "Escape" });
    await userEvent.click(screen.getByRole("button", { name: "Continues on next page…" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByText(/Click the paragraph on page 2/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Continues on next page…" }));
    press({ key: "Escape" });
    expect(screen.queryByText(/Click the paragraph on page 2/)).not.toBeInTheDocument();
  });

  it("re-flow that does not fit is refused with a message", async () => {
    let lines = 1;
    const s = setup({ layoutLines: () => lines });
    fireEvent.click(await paraOverlay(1));
    fireEvent.keyDown(editor(), { key: "Escape" });
    await userEvent.click(screen.getByRole("button", { name: "Continues on next page…" }));
    fireEvent.click(await paraOverlay(2));
    await waitFor(() => expect(screen.getByRole("button", { name: "Link and apply" })).toBeEnabled());
    await userEvent.click(screen.getByRole("button", { name: "Link and apply" }));
    lines = 500;
    const size = screen.getByLabelText("Size");
    await userEvent.clear(size);
    await userEvent.type(size, "40");
    await act(async () => fireEvent.blur(size));
    await waitFor(() => expect(s.notify).toHaveBeenCalledWith(expect.stringContaining("That change does not fit"), "error"));
  });
});
