import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { CleanDialog } from "./CleanDialog";
import type { WatermarkScan } from "../lib/types";
import { tauriMock } from "../test/tauri";
import { doc } from "../test/fixtures";

const scan = (extra: Partial<WatermarkScan> = {}): WatermarkScan => ({
  pages: [],
  markedObjects: 0,
  annotations: 0,
  matchingText: 0,
  ...extra,
});

describe("CleanDialog", () => {
  it("scans every document with the trimmed text and offers to remove what it found", async () => {
    tauriMock.handle("find_watermarks", (a) =>
      a.docId === 1
        ? scan({ pages: [{ pageIndex: 0, objects: [3], annots: [] }], markedObjects: 1 })
        : scan({ pages: [{ pageIndex: 2, objects: [], annots: [1] }], annotations: 1, matchingText: 2 }),
    );
    const onApply = vi.fn();
    render(<CleanDialog docs={[doc(1, 1), doc(2, 3)]} initialText="" onApply={onApply} onClose={vi.fn()} />);

    await userEvent.type(screen.getByRole("textbox"), "  DRAFT  ");
    await userEvent.click(screen.getByRole("button", { name: "Scan" }));

    expect(await screen.findByText(/Found/)).toHaveTextContent(
      "Found 4 items on 2 pages: 1 tagged, 1 annotation, 2 matching text.",
    );
    expect(tauriMock.calls("find_watermarks")).toEqual([
      { docId: 1, text: "DRAFT" },
      { docId: 2, text: "DRAFT" },
    ]);
    await userEvent.click(screen.getByRole("button", { name: "Remove 4" }));
    expect(onApply).toHaveBeenCalledWith([
      { docId: 1, scan: expect.objectContaining({ markedObjects: 1 }) },
      { docId: 2, scan: expect.objectContaining({ annotations: 1 }) },
    ]);
  });

  it("sends null text when the box is empty and says when nothing is found", async () => {
    tauriMock.handle("find_watermarks", () => scan());
    render(<CleanDialog docs={[doc(1, 1)]} initialText="" onApply={vi.fn()} onClose={vi.fn()} />);
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(await screen.findByText("No watermarks found.")).toBeInTheDocument();
    expect(tauriMock.calls("find_watermarks")).toEqual([{ docId: 1, text: null }]);
    expect(screen.getByRole("button", { name: "Scan" })).toBeEnabled();
  });

  it("uses singular wording for one item", async () => {
    tauriMock.handle("find_watermarks", () =>
      scan({ pages: [{ pageIndex: 0, objects: [1], annots: [] }], markedObjects: 1 }),
    );
    render(<CleanDialog docs={[doc(1, 1)]} initialText="X" onApply={vi.fn()} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Scan" }));
    expect(await screen.findByText(/Found/)).toHaveTextContent("Found 1 item on 1 page: 1 tagged, 0 annotations");
  });

  it("editing the text discards the previous result", async () => {
    tauriMock.handle("find_watermarks", () => scan({ markedObjects: 1, pages: [{ pageIndex: 0, objects: [1], annots: [] }] }));
    render(<CleanDialog docs={[doc(1, 1)]} initialText="A" onApply={vi.fn()} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Scan" }));
    await screen.findByRole("button", { name: "Remove 1" });
    await userEvent.type(screen.getByRole("textbox"), "B");
    expect(screen.getByRole("button", { name: "Scan" })).toBeInTheDocument();
  });

  it("shows errors and stays usable", async () => {
    tauriMock.handle("find_watermarks", () => {
      throw "Document is not open";
    });
    render(<CleanDialog docs={[doc(1, 1)]} initialText="" onApply={vi.fn()} onClose={vi.fn()} />);
    await userEvent.click(screen.getByRole("button", { name: "Scan" }));
    expect(await screen.findByText("Document is not open")).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole("button", { name: "Scan" })).toBeEnabled());
  });

  it("closes from the button and the backdrop only", async () => {
    const onClose = vi.fn();
    const { container } = render(<CleanDialog docs={[]} initialText="" onApply={vi.fn()} onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    fireEvent.mouseDown(screen.getByRole("dialog"));
    fireEvent.mouseDown(container.querySelector(".modal-backdrop")!);
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
