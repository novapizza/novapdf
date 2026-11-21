// Integration tests: the whole UI against a fake backend (src/test/tauri.ts).
// The real backend + PDFium is exercised by the E2E suite in e2e/.
import { beforeEach, describe, expect, it } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import type { WatermarkScan } from "./lib/types";
import { tauriMock } from "./test/tauri";
import { JPEG_BYTES, doc, opened, pageText } from "./test/fixtures";

let nextDoc = 1;
function backend() {
  tauriMock.handle("list_fonts", () => ["Helvetica", "Times", "Courier", "Arial"]);
  tauriMock.handle("render_page", () => JPEG_BYTES);
  tauriMock.handle("extract_page", () => pageText());
  tauriMock.handle("close_document", () => null);
  tauriMock.handle("layout_text", () => ({ lineStarts: [0] }));
}
const openReturns = (...docs: ReturnType<typeof doc>[]) =>
  tauriMock.handle("open_with_dialog", () => docs.map(opened));

const status = () => document.querySelector("footer.status")!;
/** A key press as the browser delivers it: on the focused element, bubbling to window. */
const press = (init: KeyboardEventInit) => fireEvent.keyDown(document.activeElement ?? document.body, init);
const nav = (name: RegExp) => userEvent.click(screen.getByRole("button", { name }));

async function openDoc(pages = 3, name = "report.pdf") {
  const d = doc(nextDoc++, pages, name);
  openReturns(d);
  await userEvent.click(screen.getByRole("button", { name: /^Open$/ }));
  await screen.findByText(new RegExp(`Opened ${name.replace(".", "\\.")}`));
  return d;
}

beforeEach(() => {
  backend();
});

describe("App: start and open", () => {
  it("starts in the library with nothing open", async () => {
    render(<App />);
    expect(screen.getByText("No document open")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Save as/ })).toBeDisabled();
    expect(status()).toHaveTextContent("0 pages");
    await waitFor(() => expect(tauriMock.calls("list_fonts")).toHaveLength(1));
  });

  it("opening a PDF shows it in the document workspace", async () => {
    render(<App />);
    await openDoc(3, "report.pdf");
    expect(screen.getByText("Opened report.pdf (3 pages)")).toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Reader tools" })).toBeInTheDocument();
    expect(status()).toHaveTextContent("Page 1 of 3");
    expect(status()).toHaveTextContent("Letter Portrait");
    expect(status()).toHaveTextContent("Sanitize on");
    expect(document.querySelector(".doc-tab .name")).toHaveTextContent("report.pdf");
  });

  it("reports files that failed to open, and opens the rest", async () => {
    render(<App />);
    tauriMock.handle("open_with_dialog", () => [
      { fileName: "bad.pdf", document: null, error: "This file is not a PDF." },
      opened(doc(50, 1, "good.pdf")),
      opened(doc(51, 2, "also.pdf")),
    ]);
    await userEvent.click(screen.getByRole("button", { name: /^Open$/ }));
    expect(await screen.findByText("bad.pdf: This file is not a PDF.")).toHaveClass("error");
    expect(screen.getByText("Opened 2 files (3 pages)")).toBeInTheDocument();
    expect(status()).toHaveTextContent("2 files");
  });

  it("an empty pick or a failing dialog changes nothing", async () => {
    render(<App />);
    openReturns();
    await userEvent.click(screen.getByRole("button", { name: /^Open$/ }));
    expect(screen.getByText("No document open")).toBeInTheDocument();
    tauriMock.handle("open_with_dialog", () => {
      throw "Dialog failed";
    });
    await userEvent.click(screen.getByRole("button", { name: /^Open$/ }));
    expect(await screen.findByText("Dialog failed")).toBeInTheDocument();
  });

  it("files dropped on an empty window replace, and on an open one append", async () => {
    render(<App />);
    tauriMock.handle("open_dropped", (a) =>
      (a.paths as string[]).map((p, i) => opened(doc(100 + i + nextDoc++, 2, p))),
    );
    await act(async () => tauriMock.emit("files-dropped", ["first.pdf"]));
    expect(await screen.findByText("Opened first.pdf (2 pages)")).toBeInTheDocument();
    await act(async () => tauriMock.emit("files-dropped", ["second.pdf"]));
    expect(await screen.findByText("Opened second.pdf (2 pages)")).toBeInTheDocument();
    expect(status()).toHaveTextContent("of 4");
    expect(status()).toHaveTextContent("2 files");
  });

  it("a failed drop shows an error", async () => {
    render(<App />);
    tauriMock.handle("open_dropped", () => {
      throw "This file was not dropped onto the window.";
    });
    await act(async () => tauriMock.emit("files-dropped", ["x.pdf"]));
    expect(await screen.findByText("This file was not dropped onto the window.")).toBeInTheDocument();
  });

  it("re-opening closes the previous documents in the backend", async () => {
    render(<App />);
    const first = await openDoc(1, "a.pdf");
    await openDoc(1, "b.pdf");
    expect(tauriMock.calls("close_document")).toEqual([{ docId: first.docId }]);
  });
});

describe("App: organize pages", () => {
  it("select, rotate, delete, undo and redo", async () => {
    render(<App />);
    await openDoc(4);
    await nav(/Page Organizer/);
    expect(screen.getByRole("navigation", { name: "Selection tools" })).toBeInTheDocument();
    // The page shown in the reader (page 1) comes in selected.
    expect(status()).toHaveTextContent("Selection: 1 page");

    fireEvent.click(screen.getByLabelText("Page 3"), { shiftKey: true });
    expect(status()).toHaveTextContent("Selection: 3 pages");
    expect(screen.getByRole("region", { name: "Selection" })).toHaveTextContent("Pages: 1, 2, 3");

    await userEvent.click(screen.getByRole("button", { name: /Rotate \+90°/ }));
    expect(screen.getAllByText("90° CW")).toHaveLength(3);
    expect(status()).toHaveTextContent("Unsaved changes");

    await userEvent.click(screen.getByRole("button", { name: /Delete \(3\)/ }));
    expect(status()).toHaveTextContent("1 page");
    expect(status()).toHaveTextContent("Selection: none");

    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(status()).toHaveTextContent("4 pages");
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(screen.queryByText("90° CW")).not.toBeInTheDocument();
    expect(status()).not.toHaveTextContent("Unsaved changes");
    await userEvent.click(screen.getByRole("button", { name: "Redo" }));
    expect(screen.getAllByText("90° CW")).toHaveLength(3);
  });

  it("keyboard shortcuts in the organizer", async () => {
    render(<App />);
    await openDoc(3);
    await nav(/Page Organizer/);
    press({ key: "a", ctrlKey: true });
    expect(status()).toHaveTextContent("Selection: 3 pages");
    press({ key: "r" });
    expect(screen.getAllByText("90° CW")).toHaveLength(3);
    press({ key: "R", shiftKey: true });
    expect(screen.queryByText("90° CW")).not.toBeInTheDocument();
    press({ key: "Escape" });
    expect(status()).toHaveTextContent("Selection: none");
    fireEvent.click(screen.getByLabelText("Page 2"));
    press({ key: "Delete" });
    expect(status()).toHaveTextContent("2 pages");
    press({ key: "z", ctrlKey: true });
    expect(status()).toHaveTextContent("3 pages");
    press({ key: "y", ctrlKey: true });
    expect(status()).toHaveTextContent("2 pages");
    press({ key: "z", ctrlKey: true });
    press({ key: "Z", ctrlKey: true, shiftKey: true });
    expect(status()).toHaveTextContent("2 pages");
  });

  it("ctrl-click toggles, Enter and Edit page open the editor on that page", async () => {
    render(<App />);
    await openDoc(3);
    await nav(/Page Organizer/);
    fireEvent.click(screen.getByLabelText("Page 3"), { ctrlKey: true });
    fireEvent.click(screen.getByLabelText("Page 1"), { ctrlKey: true });
    expect(status()).toHaveTextContent("Selection: 1 page");
    press({ key: "Enter" });
    expect(await screen.findByRole("radiogroup", { name: "Edit tool" })).toBeInTheDocument();
    expect(status()).toHaveTextContent("Page 3 of 3");

    await nav(/Page Organizer/);
    await userEvent.click(within(screen.getByRole("region", { name: "Selection" })).getByRole("button", { name: /Edit page/ }));
    expect(await screen.findByRole("radiogroup", { name: "Edit tool" })).toBeInTheDocument();
  });

  it("selection bar: rotate and deselect", async () => {
    render(<App />);
    await openDoc(2);
    await nav(/Page Organizer/);
    const bar = screen.getByRole("region", { name: "Selection" });
    await userEvent.click(within(bar).getByRole("button", { name: /Rotate/ }));
    expect(screen.getByText("90° CW")).toBeInTheDocument();
    await userEvent.click(within(bar).getByRole("button", { name: "Deselect all" }));
    expect(screen.queryByRole("region", { name: "Selection" })).not.toBeInTheDocument();
  });

  it("thumbnail size slider", async () => {
    render(<App />);
    await openDoc(1);
    await nav(/Page Organizer/);
    fireEvent.change(screen.getByRole("slider"), { target: { value: "300" } });
    expect(screen.getByLabelText("Page 1")).toHaveStyle({ width: "300px" });
  });
});

describe("App: save", () => {
  it("sends the workspace to the backend and marks it saved", async () => {
    render(<App />);
    const d = await openDoc(2, "Report.PDF");
    await nav(/Page Organizer/);
    await userEvent.click(screen.getByRole("button", { name: /Rotate \+90°/ }));
    tauriMock.handle("save_with_dialog", () => ({ path: "C:\\out\\Report-edited.pdf", warnings: ["Page 2 was copied without edits"] }));

    press({ key: "s", ctrlKey: true });
    expect(await screen.findByText("Saved C:\\out\\Report-edited.pdf")).toBeInTheDocument();
    expect(screen.getByText("Page 2 was copied without edits")).toHaveClass("error");
    expect(tauriMock.calls("save_with_dialog")).toEqual([
      {
        args: {
          pages: [
            { docId: d.docId, pageIndex: 0, rotation: 90, edits: null },
            { docId: d.docId, pageIndex: 1, rotation: 0, edits: null },
          ],
          watermark: null,
          sanitize: true,
          suggestedName: "Report-edited.pdf",
        },
      },
    ]);
    expect(status()).not.toHaveTextContent("Unsaved changes");
  });

  it("a cancelled save keeps the changes unsaved; an error is shown", async () => {
    render(<App />);
    await openDoc(1);
    await nav(/Page Organizer/);
    press({ key: "r" });
    tauriMock.handle("save_with_dialog", () => null);
    await userEvent.click(screen.getByRole("button", { name: /Save as/ }));
    await waitFor(() => expect(tauriMock.calls("save_with_dialog")).toHaveLength(1));
    expect(status()).toHaveTextContent("Unsaved changes");
    tauriMock.handle("save_with_dialog", () => {
      throw "Disk full";
    });
    await userEvent.click(screen.getByRole("button", { name: /Save as/ }));
    expect(await screen.findByText("Disk full")).toBeInTheDocument();
  });

  it("sanitize can be turned off from the sidebar", async () => {
    render(<App />);
    await openDoc(1);
    await userEvent.click(screen.getByRole("checkbox"));
    expect(status()).not.toHaveTextContent("Sanitize on");
    tauriMock.handle("save_with_dialog", () => null);
    await userEvent.click(screen.getByRole("button", { name: /Save as/ }));
    await waitFor(() => expect(tauriMock.calls("save_with_dialog")[0].args).toMatchObject({ sanitize: false }));
  });
});

describe("App: unsaved-changes guards", () => {
  async function dirtyApp() {
    render(<App />);
    await openDoc(2, "a.pdf");
    await nav(/Page Organizer/);
    press({ key: "Delete" });
  }

  it("asks before discarding on open; No keeps the workspace", async () => {
    await dirtyApp();
    tauriMock.ask.mockResolvedValue(false);
    openReturns(doc(900, 1, "other.pdf"));
    await userEvent.click(screen.getByRole("button", { name: /^Open$/ }));
    await waitFor(() => expect(tauriMock.ask).toHaveBeenCalled());
    expect(tauriMock.calls("open_with_dialog")).toHaveLength(1); // only the first open
    expect(document.querySelector(".doc-tab .name")).toHaveTextContent("a.pdf");
  });

  it("asks before quitting with unsaved changes", async () => {
    await dirtyApp();
    tauriMock.ask.mockResolvedValue(false);
    expect(await tauriMock.requestClose()).toBe(true);
    tauriMock.ask.mockResolvedValue(true);
    expect(await tauriMock.requestClose()).toBe(false);
  });

  it("quits without asking when there is nothing unsaved", async () => {
    render(<App />);
    await openDoc(1);
    expect(await tauriMock.requestClose()).toBe(false);
    expect(tauriMock.ask).not.toHaveBeenCalled();
  });
});

describe("App: navigation and command palette", () => {
  it("coming-soon sections and placeholders", async () => {
    render(<App />);
    await nav(/OCR & Export/);
    expect(screen.getByText("Coming soon")).toBeInTheDocument();
    await nav(/Document Workspace/);
    expect(screen.getByText(/Open a PDF to start/)).toBeInTheDocument();
    await nav(/Library & Recent/);
    expect(screen.getByRole("heading", { name: /Document Library/ })).toBeInTheDocument();
  });

  it("Ctrl+K opens the palette; running a command closes it", async () => {
    render(<App />);
    await openDoc(2);
    press({ key: "k", ctrlKey: true });
    const box = await screen.findByRole("textbox", { name: "Search commands" });
    await userEvent.type(box, "page organizer");
    fireEvent.keyDown(box, { key: "Enter" });
    expect(screen.queryByRole("dialog", { name: "Command palette" })).not.toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Selection tools" })).toBeInTheDocument();

    // Palette commands that act on the selection.
    await userEvent.click(screen.getByRole("button", { name: /Search tools and actions/ }));
    await userEvent.type(screen.getByRole("textbox", { name: "Search commands" }), "rotate selected pages right");
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Search commands" }), { key: "Enter" });
    expect(screen.getByText("90° CW")).toBeInTheDocument();

    press({ key: "k", ctrlKey: true });
    await userEvent.type(screen.getByRole("textbox", { name: "Search commands" }), "dark theme");
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Search commands" }), { key: "Enter" });
    expect(document.documentElement.dataset.theme).toBe("dark");
  });

  it("palette commands that need a document are disabled without one", async () => {
    render(<App />);
    press({ key: "k", ctrlKey: true });
    await userEvent.type(await screen.findByRole("textbox", { name: "Search commands" }), "save as");
    expect(screen.getByRole("option", { name: /Save as new PDF/ })).toHaveAttribute("aria-disabled", "true");
  });

  it("global shortcuts are ignored while a dialog is open", async () => {
    render(<App />);
    await openDoc(1);
    press({ key: "k", ctrlKey: true });
    await screen.findByRole("dialog", { name: "Command palette" });
    press({ key: "s", ctrlKey: true });
    expect(tauriMock.calls("save_with_dialog")).toHaveLength(0);
  });

  it("read toolbar Select switches to the editor", async () => {
    render(<App />);
    await openDoc(1);
    await userEvent.click(screen.getByRole("button", { name: /Select/ }));
    expect(await screen.findByRole("radiogroup", { name: "Edit tool" })).toBeInTheDocument();
  });
});

describe("App: watermarks", () => {
  it("applies a watermark from the Stamp tool and sends it on save", async () => {
    render(<App />);
    await openDoc(1);
    await userEvent.click(screen.getByRole("button", { name: /Stamp/ }));
    await userEvent.click(await screen.findByRole("button", { name: /Apply to all pages/ }));
    expect(screen.queryByRole("dialog", { name: "Watermark Studio" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Stamp/ })).toHaveClass("active");
    tauriMock.handle("save_with_dialog", () => null);
    press({ key: "s", ctrlKey: true });
    await waitFor(() =>
      expect(tauriMock.calls("save_with_dialog")[0].args).toMatchObject({ watermark: { text: "CONFIDENTIAL" } }),
    );
  });

  it("removes found watermarks as page edits", async () => {
    render(<App />);
    const d = await openDoc(3);
    const scan: WatermarkScan = {
      pages: [
        { pageIndex: 0, objects: [4, 5], annots: [] },
        { pageIndex: 2, objects: [], annots: [1] },
      ],
      markedObjects: 2,
      annotations: 1,
      matchingText: 0,
    };
    tauriMock.handle("find_watermarks", () => scan);
    await userEvent.click(screen.getByRole("button", { name: /Remove stamps/ }));
    await userEvent.click(await screen.findByRole("button", { name: "Scan" }));
    await userEvent.click(await screen.findByRole("button", { name: "Remove 3" }));
    expect(await screen.findByText("Removed 3 watermark items from 2 pages")).toBeInTheDocument();

    tauriMock.handle("save_with_dialog", () => null);
    press({ key: "s", ctrlKey: true });
    await waitFor(() => expect(tauriMock.calls("save_with_dialog")).toHaveLength(1));
    const pages = (tauriMock.calls("save_with_dialog")[0].args as { pages: unknown[] }).pages;
    expect(pages).toEqual([
      { docId: d.docId, pageIndex: 0, rotation: 0, edits: { removedObjects: [4, 5], removedAnnots: [], blocks: [] } },
      { docId: d.docId, pageIndex: 1, rotation: 0, edits: null },
      { docId: d.docId, pageIndex: 2, rotation: 0, edits: { removedObjects: [], removedAnnots: [1], blocks: [] } },
    ]);
  });
});
