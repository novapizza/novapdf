import { type Mock, afterEach, describe, expect, it, vi } from "vitest";
import { StrictMode } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  type AnnotActions,
  type AnnotRef,
  AnnotationLayer,
  DEFAULT_ANNOT_STYLE,
  type ReadTool,
  type TextSel,
  placeBeside,
  sameRef,
  styleSlot,
} from "./AnnotationLayer";
import { clearAnnotCache } from "../lib/annotations";
import { clearCharCache } from "../lib/textSelect";
import type { AnnotInfo, NewAnnot, PageEdits, Rotation } from "../lib/types";
import { EMPTY_EDITS } from "../lib/types";
import { tauriMock } from "../test/tauri";
import { annotInfo, newHighlight, newInk, newNote, page } from "../test/fixtures";

afterEach(() => {
  clearAnnotCache();
  clearCharCache();
});

/** "Hello world": 11 characters, 10 pt wide, on one line at y 100..112, from x 50. */
const HELLO = {
  codes: [..."Hello world"].map((c) => c.charCodeAt(0)),
  boxes: [..."Hello world"].flatMap((_, i) => [50 + i * 10, 100, 10, 12]),
};

function actions(): { [K in keyof AnnotActions]: Mock<AnnotActions[K]> } {
  return {
    select: vi.fn(),
    add: vi.fn(),
    placeNote: vi.fn(),
    selectText: vi.fn(),
    commitText: vi.fn(),
    commitDraft: vi.fn(),
    cancel: vi.fn(),
    dismiss: vi.fn(() => false),
    remove: vi.fn(),
    move: vi.fn(),
    highlightSelection: vi.fn(),
    copySelection: vi.fn(),
    error: vi.fn(),
  };
}

interface Opts {
  tool?: ReadTool;
  edits?: PageEdits;
  annots?: AnnotInfo[];
  selected?: AnnotRef | null;
  draft?: NewAnnot | null;
  textSel?: TextSel | null;
  interactive?: boolean;
  rotation?: Rotation;
  marker?: boolean;
  docId?: number;
}

let docCounter = 1;

function setup(o: Opts = {}) {
  const docId = o.docId ?? docCounter++;
  tauriMock.handle("list_annotations", (a) => [{ pageIndex: a.first, annots: o.annots ?? [], more: 0 }]);
  tauriMock.handle("text_chars", () => HELLO);
  const act$ = actions();
  const props = (extra: Partial<Opts> = {}) => {
    const x = { ...o, ...extra };
    return (
      <div className="page-surface" data-testid="surface">
        <AnnotationLayer
          page={page("A", docId, 0)}
          width={612}
          height={792}
          scale={1}
          rotation={x.rotation ?? 0}
          edits={x.edits ?? EMPTY_EDITS}
          interactive={x.interactive ?? true}
          tool={x.tool ?? "hand"}
          style={{ ...DEFAULT_ANNOT_STYLE, marker: x.marker ?? false }}
          author="Linh"
          selected={x.selected ?? null}
          draft={x.draft ?? null}
          textSel={x.textSel ?? null}
          rank={0}
          actions={act$}
        />
      </div>
    );
  };
  const utils = render(props());
  return { ...utils, actions: act$, rerenderWith: (extra: Partial<Opts>) => utils.rerender(props(extra)) };
}

const capture = () => screen.getByTestId("annot-capture");
const down = (x: number, y: number) => fireEvent.pointerDown(capture(), { button: 0, clientX: x, clientY: y, pointerId: 1 });
const move = (x: number, y: number) => fireEvent.pointerMove(capture(), { clientX: x, clientY: y, pointerId: 1 });
const up = () => fireEvent.pointerUp(capture(), { pointerId: 1 });

describe("AnnotationLayer: comments in the file", () => {
  it("adds click targets for top-level comments and opens them", async () => {
    const { actions } = setup({ annots: [annotInfo(0), annotInfo(1, { inReplyTo: 0 }), annotInfo(2, { subtype: "Highlight" })] });
    const hit = await screen.findByTestId("file-annot-0");
    expect(hit).toHaveAttribute("title", "Comment 0");
    expect(screen.queryByTestId("file-annot-1")).toBeNull(); // a reply: shown in its parent's card
    await userEvent.click(hit);
    expect(actions.select).toHaveBeenCalledWith("A", { kind: "file", index: 0 });
    expect(tauriMock.calls("list_annotations")[0]).toMatchObject({ first: 0, count: 1, background: true });
  });

  it("shows the selected comment's card with replies, and saves edits on blur", async () => {
    const list = [annotInfo(0, { author: "Ann" }), annotInfo(1, { inReplyTo: 0, author: "Bo", contents: "Agreed" })];
    const { actions } = setup({ annots: list, selected: { kind: "file", index: 0 } });
    const card = await screen.findByRole("dialog", { name: "Note" });
    expect(card).toHaveTextContent("Ann");
    expect(screen.getByRole("list", { name: "Replies" })).toHaveTextContent("Agreed");
    const box = screen.getByRole("textbox", { name: "Comment text" });
    expect(box).toHaveValue("Comment 0");
    await userEvent.clear(box);
    await userEvent.type(box, "Changed");
    fireEvent.blur(box);
    expect(actions.commitText).toHaveBeenCalledWith("A", { kind: "file", index: 0 }, "Changed");
    // Unchanged since the last save: blurring again does not save again.
    fireEvent.blur(box);
    expect(actions.commitText).toHaveBeenCalledTimes(1);
  });

  it("Esc closes the card without saving; Delete removes the comment without saving", async () => {
    const { actions, rerenderWith } = setup({ annots: [annotInfo(0)], selected: { kind: "file", index: 0 } });
    let box = await screen.findByRole("textbox", { name: "Comment text" });
    await userEvent.type(box, " more");
    fireEvent.keyDown(box, { key: "Escape" });
    expect(actions.cancel).toHaveBeenCalled();
    rerenderWith({ selected: null });
    expect(actions.commitText).not.toHaveBeenCalled();

    rerenderWith({ selected: { kind: "file", index: 0 } });
    box = await screen.findByRole("textbox", { name: "Comment text" });
    await userEvent.type(box, " more");
    await userEvent.click(screen.getByRole("button", { name: "Delete comment" }));
    expect(actions.remove).toHaveBeenCalledWith("A", { kind: "file", index: 0 });
    rerenderWith({ selected: null });
    expect(actions.commitText).not.toHaveBeenCalled();
  });

  it("shows text that was cut short as read-only", async () => {
    setup({ annots: [annotInfo(0, { truncated: true })], selected: { kind: "file", index: 0 } });
    expect(await screen.findByText(/too long to edit here/)).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("reports a failed load", async () => {
    tauriMock.handle("list_annotations", () => {
      throw new Error("worker gone");
    });
    const act$ = actions();
    render(
      <AnnotationLayer
        page={page("A", 999, 4)}
        width={612}
        height={792}
        scale={1}
        rotation={0}
        edits={EMPTY_EDITS}
        interactive
        tool="hand"
        style={DEFAULT_ANNOT_STYLE}
        author=""
        selected={null}
        draft={null}
        textSel={null}
        rank={3}
        actions={act$}
      />,
    );
    await waitFor(() => expect(act$.error).toHaveBeenCalledWith("Comments on page 5: worker gone"));
  });
});

describe("AnnotationLayer: comments made in the app", () => {
  const edits = { ...EMPTY_EDITS, annotations: [newNote("n1"), newHighlight("h1"), newInk("i1"), newInk("m1", { opacity: 0.4 })] };

  it("draws each kind, blending highlights and marker strokes with the page", () => {
    setup({ edits });
    const blend = document.querySelector(".annot-layer.blend")!;
    expect(blend.querySelectorAll("[data-kind=highlight]")).toHaveLength(1);
    expect(blend.querySelectorAll("[data-kind=ink]")).toHaveLength(1); // the marker
    const top = document.querySelectorAll(".annot-layer")[1];
    expect(top.querySelectorAll("[data-kind=note], [data-kind=ink]")).toHaveLength(2);
  });

  it("opens one with the hand, and edits or deletes it from its card", async () => {
    const { actions, rerenderWith } = setup({ edits });
    await userEvent.click(screen.getByTestId("annot-h1"));
    expect(actions.select).toHaveBeenCalledWith("A", { kind: "new", id: "h1" });
    rerenderWith({ selected: { kind: "new", id: "h1" } });
    expect(screen.getByRole("dialog", { name: "Highlight" })).toBeInTheDocument();
    expect(document.querySelector(".annot-outline")).not.toBeNull();
    const box = screen.getByRole("textbox", { name: "Comment text" });
    expect(box).not.toHaveFocus();
    await userEvent.type(box, "Why?");
    fireEvent.blur(box);
    expect(actions.commitText).toHaveBeenCalledWith("A", { kind: "new", id: "h1" }, "Why?");
    await userEvent.click(screen.getByRole("button", { name: "Delete comment" }));
    expect(actions.remove).toHaveBeenCalledWith("A", { kind: "new", id: "h1" });
  });

  it("only the hand opens comments", () => {
    setup({ edits, tool: "ink" });
    expect(screen.queryByTestId("annot-h1")).toBeNull();
  });

  it("with the Note tool, notes can still be opened (and so edited); other comments cannot", async () => {
    const { actions } = setup({ edits, tool: "note", annots: [annotInfo(0), annotInfo(2, { subtype: "Highlight" })] });
    expect(screen.queryByTestId("annot-h1")).toBeNull();
    await userEvent.click(screen.getByTestId("annot-n1"));
    expect(actions.select).toHaveBeenCalledWith("A", { kind: "new", id: "n1" });
    await userEvent.click(await screen.findByTestId("file-annot-0"));
    expect(actions.select).toHaveBeenLastCalledWith("A", { kind: "file", index: 0 });
    expect(screen.queryByTestId("file-annot-2")).toBeNull();
    expect(actions.placeNote).not.toHaveBeenCalled();
  });

  it("drags a note to move it; a press without a drag opens it", () => {
    const { actions } = setup({ edits });
    const hit = () => screen.getByTestId("annot-n1");
    const at = (x: number, y: number) => ({ clientX: x, clientY: y, pointerId: 2 });
    // Pressed at (55, 65) on a note whose corner is (50, 60): a 1 pt wobble is not a drag.
    fireEvent.pointerDown(hit(), { button: 0, ...at(55, 65) });
    fireEvent.pointerMove(hit(), at(56, 65));
    fireEvent.pointerUp(hit(), at(56, 65));
    expect(actions.select).toHaveBeenCalledWith("A", { kind: "new", id: "n1" });
    expect(actions.move).not.toHaveBeenCalled();

    fireEvent.pointerDown(hit(), { button: 0, ...at(55, 65) });
    fireEvent.pointerMove(hit(), at(155, 105));
    // While dragged, the note and its target follow the pointer.
    expect(hit()).toHaveAttribute("x", "150");
    expect(document.querySelector("[data-kind=note]")!.getAttribute("transform")).toContain("translate(150 100)");
    fireEvent.pointerUp(hit(), at(155, 105));
    expect(actions.move).toHaveBeenCalledWith("A", { kind: "new", id: "n1" }, { x: 150, y: 100 });
    expect(actions.select).toHaveBeenCalledTimes(1);
    // Right-button presses and a cancelled drag do nothing.
    fireEvent.pointerDown(hit(), { button: 2, ...at(55, 65) });
    fireEvent.pointerDown(hit(), { button: 0, ...at(55, 65) });
    fireEvent.pointerCancel(hit(), at(55, 65));
    fireEvent.pointerMove(hit(), at(155, 105));
    fireEvent.pointerUp(hit(), at(155, 105));
    expect(actions.move).toHaveBeenCalledTimes(1);
  });

  it("drags a note that is in the file, and draws it where it was moved", async () => {
    const { actions, rerenderWith } = setup({ annots: [annotInfo(0, { color: [0, 128, 255] })] });
    const hit = await screen.findByTestId("file-annot-0");
    expect(document.querySelector("[data-kind=note]")).toBeNull(); // the page image shows it
    fireEvent.pointerDown(hit, { button: 0, clientX: 105, clientY: 105, pointerId: 3 });
    fireEvent.pointerMove(hit, { clientX: 205, clientY: 305, pointerId: 3 });
    expect(document.querySelector("[data-kind=note]")).not.toBeNull(); // dragged: drawn here
    fireEvent.pointerUp(hit, { clientX: 205, clientY: 305, pointerId: 3 });
    expect(actions.move).toHaveBeenCalledWith("A", { kind: "file", index: 0 }, { x: 200, y: 300 });

    // Once moved, the page render leaves it out and the overlay draws it, at its new place.
    rerenderWith({ edits: { ...EMPTY_EDITS, changedAnnots: [{ index: 0, at: { x: 200, y: 300 }, date: "D:2026" }] } });
    const drawn = document.querySelector("[data-kind=note]")!;
    expect(drawn.getAttribute("transform")).toContain("translate(200 300)");
    expect(drawn.querySelector("path")).toHaveAttribute("fill", "rgb(0,128,255)");
    expect(screen.getByTestId("file-annot-0").style.left).toBe("200px");
  });

  it("Tab reaches every comment's target, and Enter or Space opens it", async () => {
    const { actions } = setup({ edits, annots: [annotInfo(0, { subtype: "Highlight" })] });
    const fileHit = await screen.findByRole("button", { name: "Highlight: Comment 0" });
    expect(fileHit).toHaveAttribute("tabindex", "0");
    fireEvent.keyDown(fileHit, { key: "Enter" });
    expect(actions.select).toHaveBeenCalledWith("A", { kind: "file", index: 0 });
    const noteHit = screen.getByTestId("annot-n1");
    expect(noteHit).toHaveAttribute("tabindex", "0");
    fireEvent.keyDown(noteHit, { key: " " });
    expect(actions.select).toHaveBeenLastCalledWith("A", { kind: "new", id: "n1" });
    fireEvent.keyDown(noteHit, { key: "a" });
    expect(actions.select).toHaveBeenCalledTimes(2);
  });

  it("marks highlights that carry a comment with a badge at their top-right corner", async () => {
    const annots = [
      annotInfo(0, { subtype: "Highlight", contents: "", rect: { x: 300, y: 400, width: 50, height: 10 } }),
      annotInfo(1, { subtype: "Highlight", contents: "  ", rect: { x: 300, y: 500, width: 50, height: 10 } }),
      annotInfo(2, { inReplyTo: 1, contents: "A reply" }),
      annotInfo(3, { subtype: "Underline", contents: "Said here" }),
    ];
    const marked = {
      ...EMPTY_EDITS,
      annotations: [newHighlight("h1", { contents: "Why?" }), newHighlight("h2"), newNote("n1", { contents: "Not markup" })],
    };
    const { rerenderWith } = setup({ edits: marked, annots });
    // h1 (its text), file 1 (a reply), file 3 (its text); not h2, file 0 or the note.
    await waitFor(() => expect(document.querySelectorAll("[data-kind=badge]")).toHaveLength(3));
    // h1 spans x 72..172 from y 90: its badge (10 pt) is centred on (172, 90).
    expect(document.querySelector("[data-kind=badge]")!.getAttribute("transform")).toContain("translate(167 85)");
    // Turned a quarter clockwise, the corner seen at the top-right is the highlight's
    // own top-left, (72, 90); the badge stays upright.
    rerenderWith({ rotation: 90 });
    expect(document.querySelector("[data-kind=badge]")!.getAttribute("transform")).toBe("translate(67 85) rotate(-90 5 5)");
  });

  it("in edit mode only shows them, dimmed, without loading anything", () => {
    setup({ edits, interactive: false, selected: { kind: "new", id: "h1" } });
    expect(document.querySelector(".annot-layer.dim")).not.toBeNull();
    expect(screen.queryByTestId("annot-capture")).toBeNull();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(tauriMock.calls("list_annotations")).toEqual([]);
  });
});

describe("AnnotationLayer: tools", () => {
  it("Note: places a note centred on the click, kept inside the page", () => {
    const { actions } = setup({ tool: "note" });
    down(100, 200);
    expect(actions.placeNote).toHaveBeenCalledWith("A", { x: 90, y: 190 });
    down(2, 790);
    expect(actions.placeNote).toHaveBeenLastCalledWith("A", { x: 0, y: 772 });
    // While a card is open, a click only closes it.
    actions.dismiss.mockReturnValueOnce(true);
    down(300, 300);
    expect(actions.placeNote).toHaveBeenCalledTimes(2);
  });

  it("the card's Save and Ctrl+Enter save and close; Cancel closes without saving", async () => {
    const { actions, rerenderWith } = setup({ edits: { ...EMPTY_EDITS, annotations: [newNote("n1")] }, selected: { kind: "new", id: "n1" } });
    const box = screen.getByRole("textbox", { name: "Comment text" });
    await userEvent.type(box, "One");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(actions.commitText).toHaveBeenCalledWith("A", { kind: "new", id: "n1" }, "One");
    expect(actions.cancel).toHaveBeenCalledTimes(1);

    await userEvent.type(box, " two{Control>}{Enter}{/Control}");
    expect(actions.commitText).toHaveBeenLastCalledWith("A", { kind: "new", id: "n1" }, "One two");
    expect(actions.cancel).toHaveBeenCalledTimes(2);

    await userEvent.type(box, " three");
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    rerenderWith({ selected: null });
    await act(async () => {});
    expect(actions.commitText).toHaveBeenCalledTimes(2);
  });

  it("Note: a new note's card is focused, and saves what was typed when it closes", async () => {
    const draft = newNote("d1");
    const { actions, rerenderWith } = setup({ tool: "note", draft });
    const box = screen.getByRole("textbox", { name: "Comment text" });
    expect(box).toHaveFocus();
    expect(screen.getByRole("dialog", { name: "New note" })).toBeInTheDocument();
    await userEvent.type(box, "Remember");
    rerenderWith({ draft: null });
    await act(async () => {});
    expect(actions.commitDraft).toHaveBeenCalledWith("A", draft, "Remember");
  });

  it("Note: StrictMode's extra unmount in development does not close a new note", async () => {
    tauriMock.handle("list_annotations", () => [{ pageIndex: 0, annots: [], more: 0 }]);
    const act$ = actions();
    render(
      <StrictMode>
        <AnnotationLayer
          page={page("A", 997, 0)}
          width={612}
          height={792}
          scale={1}
          rotation={0}
          edits={EMPTY_EDITS}
          interactive
          tool="note"
          style={DEFAULT_ANNOT_STYLE}
          author=""
          selected={null}
          draft={newNote("d3")}
          textSel={null}
          rank={0}
          actions={act$}
        />
      </StrictMode>,
    );
    await act(async () => {});
    expect(act$.commitDraft).not.toHaveBeenCalled();
    await userEvent.type(screen.getByRole("textbox", { name: "Comment text" }), "Kept");
    fireEvent.blur(screen.getByRole("textbox", { name: "Comment text" }));
    expect(act$.commitDraft).toHaveBeenCalledWith("A", expect.objectContaining({ id: "d3" }), "Kept");
  });

  it("Note: an untouched new note still reports its close, so it can be dropped", () => {
    const draft = newNote("d2");
    const { actions } = setup({ tool: "note", draft });
    fireEvent.blur(screen.getByRole("textbox", { name: "Comment text" }));
    expect(actions.commitDraft).toHaveBeenCalledWith("A", draft, "");
  });

  it("Ink: draws a pen stroke, skipping points that barely move", () => {
    const { actions } = setup({ tool: "ink" });
    down(10, 10);
    move(10.2, 10.2);
    move(20, 30);
    expect(document.querySelectorAll("polyline")).toHaveLength(1);
    up();
    const [pageId, annot, select] = actions.add.mock.calls[0];
    expect([pageId, select]).toEqual(["A", false]);
    expect(annot).toMatchObject({
      kind: "ink",
      strokes: [
        [
          { x: 10, y: 10 },
          { x: 20, y: 30 },
        ],
      ],
      width: 2,
      opacity: 1,
      color: DEFAULT_ANNOT_STYLE.ink,
      author: "Linh",
    });
  });

  it("Ink: the marker is wide and see-through in the highlight colour; a click makes a dot", () => {
    const { actions } = setup({ tool: "ink", marker: true });
    down(10, 10);
    expect(document.querySelector(".annot-layer.blend polyline")).not.toBeNull();
    up();
    expect(actions.add.mock.calls[0][1]).toMatchObject({
      width: 12,
      opacity: 0.4,
      color: DEFAULT_ANNOT_STYLE.highlight,
      strokes: [
        [
          { x: 10, y: 10 },
          { x: 10.5, y: 10 },
        ],
      ],
    });
    up(); // no stroke in progress: nothing
    fireEvent.pointerDown(capture(), { button: 2, clientX: 5, clientY: 5 });
    expect(actions.add).toHaveBeenCalledTimes(1);
  });

  it("Highlight: drag over text to highlight it, line by line", async () => {
    const { actions } = setup({ tool: "highlight" });
    await waitFor(() => expect(tauriMock.calls("text_chars")).toHaveLength(1));
    await act(async () => {});
    down(55, 105);
    move(95, 105);
    expect(document.querySelectorAll(".annot-layer.blend rect")).toHaveLength(1);
    up();
    expect(actions.add).toHaveBeenCalledWith(
      "A",
      expect.objectContaining({ kind: "highlight", rects: [{ x: 50, y: 100, width: 50, height: 12 }] }),
      true,
    );
  });

  it("Highlight: pressing where there is no text, or clicking without a drag, only closes what is open", async () => {
    const { actions } = setup({ tool: "highlight" });
    await waitFor(() => expect(tauriMock.calls("text_chars")).toHaveLength(1));
    await act(async () => {});
    down(400, 600);
    expect(actions.dismiss).toHaveBeenCalledTimes(1);
    up();
    down(55, 105); // on a letter, but no drag: no one-letter highlight
    up();
    expect(actions.dismiss).toHaveBeenCalledTimes(2);
    expect(actions.add).not.toHaveBeenCalled();
  });

  it("Select: drag selects text; a click without a drag clears it", async () => {
    const { actions, rerenderWith } = setup({ tool: "select" });
    await waitFor(() => expect(tauriMock.calls("text_chars")).toHaveLength(1));
    await act(async () => {});
    down(55, 105);
    move(55, 105); // same character: not a drag yet
    move(105, 105);
    up();
    const sel = actions.selectText.mock.calls[0][1] as TextSel;
    expect(sel.text).toBe("Hello ");
    expect(sel.rects).toEqual([{ x: 50, y: 100, width: 60, height: 12 }]);
    down(55, 105);
    up();
    expect(actions.dismiss).toHaveBeenCalled();
    expect(actions.selectText).toHaveBeenCalledTimes(1);

    rerenderWith({ textSel: sel });
    expect(document.querySelector(".text-sel")).not.toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /Copy/ }));
    await userEvent.click(screen.getByRole("button", { name: /Highlight/ }));
    expect(actions.copySelection).toHaveBeenCalled();
    expect(actions.highlightSelection).toHaveBeenCalled();
  });

  it("the selection bar sits below the selection's end, kept inside the page", () => {
    const sel = (x: number, y: number): TextSel => ({ a: 0, b: 1, text: "x", rects: [{ x, y, width: 20, height: 12 }] });
    const bar = () => screen.getByRole("toolbar", { name: "Selected text" });
    const { rerenderWith } = setup({ tool: "select", textSel: sel(100, 100) });
    expect(bar()).toHaveClass("text-sel-bar");
    expect(bar().style.left).toBe("116px");
    expect(bar().style.top).toBe("118px");
    // Near the right and bottom edges: pulled left, and placed above the selection.
    rerenderWith({ textSel: sel(580, 770) });
    expect(bar().style.left).toBe(`${612 - 190}px`);
    expect(bar().style.top).toBe(`${770 - 36 - 6}px`);
    // Turned a quarter: the page is 792 wide on screen.
    rerenderWith({ rotation: 90, textSel: sel(0, 0) });
    expect(parseFloat(bar().style.left)).toBeLessThanOrEqual(792 - 190);
  });

  it("maps clicks on a turned page back to the page as stored", () => {
    // A 612 × 792 page turned 90° shows as 792 × 612.
    const { actions } = setup({ tool: "note", rotation: 90 });
    down(792 - 210, 100);
    expect(actions.placeNote).toHaveBeenCalledWith("A", { x: 90, y: 200 });
    const layer = document.querySelector<HTMLElement>(".annot-layer")!;
    expect(layer.style.transform).toMatch(/^translate\(792px.*\) rotate\(90deg\)$/);
  });

  it("reports text that cannot be read", async () => {
    tauriMock.handle("list_annotations", () => [{ pageIndex: 0, annots: [], more: 0 }]);
    tauriMock.handle("text_chars", () => {
      throw new Error("bad page");
    });
    const act$ = actions();
    render(
      <AnnotationLayer
        page={page("A", 998, 0)}
        width={612}
        height={792}
        scale={1}
        rotation={0}
        edits={EMPTY_EDITS}
        interactive
        tool="select"
        style={DEFAULT_ANNOT_STYLE}
        author=""
        selected={null}
        draft={null}
        textSel={null}
        rank={2}
        actions={act$}
      />,
    );
    await waitFor(() => expect(act$.error).toHaveBeenCalledWith("Text on page 1: bad page"));
  });
});

describe("helpers", () => {
  it("places cards beside the comment, inside the page", () => {
    const page = { width: 600, height: 800 };
    expect(placeBeside({ x: 100, y: 100, width: 20, height: 20 }, 1, page, 260)).toEqual({ left: 128, top: 100 });
    // No room on the right: to the left of it.
    expect(placeBeside({ x: 500, y: 100, width: 20, height: 20 }, 1, page, 260)).toEqual({ left: 232, top: 100 });
    // Near the bottom: lifted so it is not cut off.
    expect(placeBeside({ x: 10, y: 790, width: 5, height: 5 }, 1, page, 260).top).toBe(600);
  });

  it("compares comment references", () => {
    expect(sameRef({ kind: "file", index: 1 }, { kind: "file", index: 1 })).toBe(true);
    expect(sameRef({ kind: "file", index: 1 }, { kind: "new", id: "1" })).toBe(false);
    expect(sameRef({ kind: "new", id: "a" }, { kind: "new", id: "a" })).toBe(true);
    expect(sameRef({ kind: "new", id: "a" }, { kind: "file", index: 0 })).toBe(false);
    expect(sameRef(null, { kind: "new", id: "a" })).toBe(false);
  });

  it("picks the colour a tool uses", () => {
    expect(styleSlot("note", false)).toBe("note");
    expect(styleSlot("ink", false)).toBe("ink");
    expect(styleSlot("ink", true)).toBe("highlight");
    expect(styleSlot("highlight", false)).toBe("highlight");
  });
});
