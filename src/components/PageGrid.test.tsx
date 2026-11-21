import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { PageGrid, thumbRequest } from "./PageGrid";
import { EMPTY_EDITS } from "../lib/types";
import { tauriMock } from "../test/tauri";
import { JPEG_BYTES, block, doc, page } from "../test/fixtures";

const props = (extra: Partial<Omit<Parameters<typeof PageGrid>[0], "onSelect">> = {}) => ({
  pages: [page("a", 1, 0), page("b", 1, 1, { rotation: 90 as const }), page("c", 2, 0)],
  docs: new Map([
    [1, doc(1, 2, "one.pdf")],
    [2, doc(2, 1, "two.pdf")],
  ]),
  watermark: null,
  selection: new Set<string>(),
  thumbWidth: 170,
  onSelect: vi.fn(),
  onMove: vi.fn(),
  onOpenEditor: vi.fn(),
  ...extra,
});

describe("thumbRequest", () => {
  it("buckets the width for cache hits and drops empty edits", () => {
    const r = thumbRequest(page("a"), 170, null);
    expect(r).toMatchObject({ width: 180, format: "jpeg", priority: "thumb", edits: null });
    expect(thumbRequest(page("a"), 5000, null).width).toBe(1200);
    const edits = { ...EMPTY_EDITS, blocks: [block("x")] };
    expect(thumbRequest(page("a", 1, 0, { edits }), 170, null).edits).toBe(edits);
  });
});

describe("PageGrid", () => {
  it("renders numbered thumbnails with badges, sizes and file names", async () => {
    tauriMock.handle("render_page", () => JPEG_BYTES);
    const p = props({ pages: [page("a", 1, 0, { edits: { ...EMPTY_EDITS, removedObjects: [1] } }), ...props().pages.slice(1)] });
    const { container } = render(<PageGrid {...p} />);
    expect(screen.getByLabelText("Page 1")).toBeInTheDocument();
    expect(screen.getByText("Edited")).toBeInTheDocument();
    expect(screen.getByText("90° CW")).toBeInTheDocument();
    expect(screen.getByText("Letter Landscape")).toBeInTheDocument();
    expect(screen.getAllByText("one.pdf")).toHaveLength(2); // several docs: file names shown
    await waitFor(() => expect(container.querySelectorAll("img")).toHaveLength(3));
    expect(tauriMock.calls("render_page")).toHaveLength(3);
  });

  it("hides file names for a single document and shows render failures", async () => {
    tauriMock.handle("render_page", () => {
      throw "boom";
    });
    render(<PageGrid {...props({ pages: [page("a")], docs: new Map([[1, doc(1, 1, "solo.pdf")]]) })} />);
    expect(screen.queryByText("solo.pdf")).not.toBeInTheDocument();
    expect(await screen.findByText("Render failed")).toBeInTheDocument();
  });

  it("click selects; ctrl toggles; shift ranges; checkbox toggles; double-click opens", () => {
    tauriMock.handle("render_page", () => JPEG_BYTES);
    const p = props({ selection: new Set(["b"]) });
    render(<PageGrid {...p} />);
    fireEvent.click(screen.getByLabelText("Page 1"));
    fireEvent.click(screen.getByLabelText("Page 2"), { ctrlKey: true });
    fireEvent.click(screen.getByLabelText("Page 3"), { shiftKey: true });
    fireEvent.click(screen.getByRole("checkbox", { name: "Select page 1" }));
    fireEvent.doubleClick(screen.getByLabelText("Page 3"));
    expect(p.onSelect.mock.calls).toEqual([
      ["a", "single"],
      ["b", "toggle"],
      ["c", "range"],
      ["a", "toggle"],
    ]);
    expect(p.onOpenEditor).toHaveBeenCalledWith("c");
    expect(screen.getByRole("checkbox", { name: "Select page 2" })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText("Selected")).toBeInTheDocument();
  });

  it("falls back to Letter size for pages of unknown documents", () => {
    tauriMock.handle("render_page", () => JPEG_BYTES);
    render(<PageGrid {...props({ pages: [page("z", 99, 0)], docs: new Map() })} />);
    expect(screen.getByText("Letter Portrait")).toBeInTheDocument();
  });
});
