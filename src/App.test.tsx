// Integration tests: the whole UI against a fake backend (src/test/tauri.ts).
// The real backend + PDFium is exercised by the E2E suite in e2e/.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "./App";
import { UPDATE_CHECK_INTERVAL_MS } from "./lib/autoUpdate";
import type { RecentView, WatermarkScan } from "./lib/types";
import { tauriMock } from "./test/tauri";
import { APP_NAME } from "./lib/brand";
import { JPEG_BYTES, doc, opened, pageText } from "./test/fixtures";

let nextDoc = 1;
function backend() {
  tauriMock.handle("list_fonts", () => ["Helvetica", "Times", "Courier", "Arial"]);
  tauriMock.handle("render_page", () => JPEG_BYTES);
  tauriMock.handle("extract_page", () => pageText());
  tauriMock.handle("close_document", () => null);
  tauriMock.handle("layout_text", () => ({ lineStarts: [0] }));
  tauriMock.handle("take_launch_files", () => []);
  tauriMock.handle("list_annotations", (a) =>
    Array.from({ length: a.count as number }, (_, i) => ({ pageIndex: (a.first as number) + i, annots: [], more: 0 })),
  );
  tauriMock.handle("text_chars", () => ({ codes: [], boxes: [] }));
  tauriMock.handle("list_recent", () => recentList);
}
/** What the fake backend reports as the recent files list. */
let recentList: RecentView = { enabled: true, items: [] };
const openReturns = (...docs: ReturnType<typeof doc>[]) =>
  tauriMock.handle("open_with_dialog", () => docs.map(opened));

const status = () => document.querySelector("footer.status")!;
/** A key press as the browser delivers it: on the focused element, bubbling to window. */
const press = (init: KeyboardEventInit) => fireEvent.keyDown(document.activeElement ?? document.body, init);
/** Switches the view with the Read | Organize | Edit control in the top bar. */
const nav = (name: "Read" | "Organize" | "Edit") =>
  userEvent.click(within(screen.getByRole("radiogroup", { name: "View" })).getByRole("radio", { name }));
const goLibrary = () => userEvent.click(screen.getByRole("button", { name: "Library" }));
/** Opens the settings popover (sanitize, theme) if it is closed. */
const openSettings = async () => {
  if (!screen.queryByRole("dialog", { name: "Settings" })) await userEvent.click(screen.getByRole("button", { name: "Settings" }));
};
const tabList = () => screen.queryByRole("tablist", { name: "Open documents" });
const docTab = (name: RegExp) => within(tabList()!).getByRole("tab", { name });
const tabNames = () => (tabList() ? within(tabList()!).queryAllByRole("tab") : []).map((t) => t.querySelector(".name")!.textContent);
const activeTabName = () => within(tabList()!).getByRole("tab", { selected: true }).querySelector(".name")!.textContent;

async function openDoc(pages = 3, name = "report.pdf") {
  const d = doc(nextDoc++, pages, name);
  openReturns(d);
  await userEvent.click(screen.getByRole("button", { name: /^Open$/ }));
  await screen.findByText(new RegExp(`Opened ${name.replace(".", "\\.")}`));
  return d;
}

beforeEach(() => {
  recentList = { enabled: true, items: [] };
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
    // Sanitize is on by default; the switch is in the settings popover.
    await openSettings();
    expect(screen.getByRole("checkbox", { name: "Sanitize on save" })).toBeChecked();
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
    expect((await screen.findByText("bad.pdf: This file is not a PDF.")).closest(".toast")).toHaveClass("error");
    expect(screen.getByText("Opened 2 files (3 pages)")).toBeInTheDocument();
    // Each file gets its own tab; the last one is in front.
    expect(tabNames()).toEqual(["good.pdf", "also.pdf"]);
    expect(activeTabName()).toBe("also.pdf");
    expect(status()).toHaveTextContent("Page 1 of 2");
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

  it("dropped files open in new tabs", async () => {
    render(<App />);
    tauriMock.handle("open_dropped", (a) =>
      (a.paths as string[]).map((p, i) => opened(doc(100 + i + nextDoc++, 2, p))),
    );
    await act(async () => tauriMock.emit("files-dropped", ["first.pdf"]));
    expect(await screen.findByText("Opened first.pdf (2 pages)")).toBeInTheDocument();
    await act(async () => tauriMock.emit("files-dropped", ["second.pdf"]));
    expect(await screen.findByText("Opened second.pdf (2 pages)")).toBeInTheDocument();
    expect(tabNames()).toEqual(["first.pdf", "second.pdf"]);
    expect(status()).toHaveTextContent("Page 1 of 2");
  });

  it("overlapping drops keep both files, even when the second opens first", async () => {
    render(<App />);
    const pending = new Map<string, () => void>();
    tauriMock.handle("open_dropped", (a) => {
      const [name] = a.paths as string[];
      const d = doc(200 + nextDoc++, name === "big.pdf" ? 3 : 2, name);
      return new Promise((resolve) => pending.set(name, () => resolve([opened(d)])));
    });
    await act(async () => tauriMock.emit("files-dropped", ["big.pdf"]));
    await act(async () => tauriMock.emit("files-dropped", ["small.pdf"]));
    await act(async () => pending.get("small.pdf")!());
    expect(screen.queryByText(/Opened small\.pdf/)).not.toBeInTheDocument(); // waits for big.pdf
    await act(async () => pending.get("big.pdf")!());
    expect(await screen.findByText("Opened small.pdf (2 pages)")).toBeInTheDocument();
    expect(tabNames()).toEqual(["big.pdf", "small.pdf"]); // drop order, not finish order
    expect(tauriMock.calls("close_document")).toEqual([]);
  });

  it("when the first of two overlapping drops fails, the second still opens", async () => {
    render(<App />);
    tauriMock.handle("open_dropped", (a) => {
      const [name] = a.paths as string[];
      return [name === "bad.pdf" ? { fileName: name, document: null, error: "This file is not a PDF." } : opened(doc(300 + nextDoc++, 2, name))];
    });
    await act(async () => {
      tauriMock.emit("files-dropped", ["bad.pdf"]);
      tauriMock.emit("files-dropped", ["good.pdf"]);
    });
    expect(await screen.findByText("bad.pdf: This file is not a PDF.")).toBeInTheDocument();
    expect(await screen.findByText("Opened good.pdf (2 pages)")).toBeInTheDocument();
    expect(tabNames()).toEqual(["good.pdf"]);
  });

  it("a failed drop shows an error", async () => {
    render(<App />);
    tauriMock.handle("open_dropped", () => {
      throw "This file was not dropped onto the window.";
    });
    await act(async () => tauriMock.emit("files-dropped", ["x.pdf"]));
    expect(await screen.findByText("This file was not dropped onto the window.")).toBeInTheDocument();
  });

  it("shows the drop overlay while files are dragged over the window", async () => {
    render(<App />);
    const overlay = () => screen.queryByText("Drop PDFs to open");
    expect(overlay()).not.toBeInTheDocument();
    await act(async () => tauriMock.emit("drag-hover", true));
    expect(overlay()).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveClass("drop-overlay");
    await act(async () => tauriMock.emit("drag-hover", false));
    expect(overlay()).not.toBeInTheDocument();
  });

  it("opens the file the app was launched with", async () => {
    tauriMock.handle("take_launch_files", () => ["C:\\docs\\clicked.pdf"]);
    tauriMock.handle("open_dropped", (a) => (a.paths as string[]).map(() => opened(doc(400 + nextDoc++, 2, "clicked.pdf"))));
    render(<App />);
    expect(await screen.findByText("Opened clicked.pdf (2 pages)")).toBeInTheDocument();
    expect(tauriMock.calls("open_dropped")).toEqual([{ paths: ["C:\\docs\\clicked.pdf"] }]);
    expect(tabNames()).toEqual(["clicked.pdf"]);
  });

  it("opens files a later launch hands to the running app", async () => {
    render(<App />);
    await waitFor(() => expect(tauriMock.calls("take_launch_files")).toHaveLength(1));
    expect(tauriMock.calls("open_dropped")).toEqual([]); // nothing queued at startup
    tauriMock.handle("take_launch_files", () => ["C:\\docs\\later.pdf"]);
    tauriMock.handle("open_dropped", () => [opened(doc(450 + nextDoc++, 1, "later.pdf"))]);
    await act(async () => tauriMock.emit("launch-files", null));
    expect(await screen.findByText("Opened later.pdf (1 page)")).toBeInTheDocument();
    expect(tabNames()).toEqual(["later.pdf"]);
  });

  it("a failure to fetch launch files shows an error", async () => {
    tauriMock.handle("take_launch_files", () => {
      throw "Backend gone";
    });
    render(<App />);
    expect(await screen.findByText("Backend gone")).toBeInTheDocument();
  });

  it("opening another file keeps the first one open in its tab", async () => {
    render(<App />);
    await openDoc(1, "a.pdf");
    await openDoc(3, "b.pdf");
    expect(tabNames()).toEqual(["a.pdf", "b.pdf"]);
    expect(tauriMock.calls("close_document")).toEqual([]);
    expect(status()).toHaveTextContent("Page 1 of 3");
    await userEvent.click(docTab(/a\.pdf/));
    expect(activeTabName()).toBe("a.pdf");
    expect(status()).toHaveTextContent("Page 1 of 1");
  });
});

describe("App: tabs", () => {
  it("opening a file that is already open switches to its tab", async () => {
    render(<App />);
    const a = await openDoc(2, "a.pdf");
    await openDoc(1, "b.pdf");
    openReturns(a); // the backend hands back the same document for the same file
    await userEvent.click(screen.getByRole("button", { name: /^Open$/ }));
    expect(await screen.findByText("a.pdf is already open")).toBeInTheDocument();
    expect(tabNames()).toEqual(["a.pdf", "b.pdf"]);
    expect(activeTabName()).toBe("a.pdf");
  });

  it("each tab keeps its own pages and undo history", async () => {
    render(<App />);
    await openDoc(3, "a.pdf");
    await nav("Organize");
    press({ key: "Delete" }); // the organizer selects the current page: page 1
    expect(status()).toHaveTextContent("2 pages");
    await openDoc(4, "b.pdf");
    expect(status()).toHaveTextContent("4 pages");
    expect(screen.getByRole("button", { name: "Undo" })).toBeDisabled();
    press({ key: "Tab", ctrlKey: true }); // wraps to a.pdf
    expect(activeTabName()).toBe("a.pdf");
    expect(status()).toHaveTextContent("2 pages");
    expect(screen.getByRole("button", { name: "Undo" })).toBeEnabled();
    press({ key: "Tab", ctrlKey: true, shiftKey: true });
    expect(activeTabName()).toBe("b.pdf");
  });

  it("merge appends files to the current tab only", async () => {
    render(<App />);
    await openDoc(2, "a.pdf");
    openReturns(doc(700, 3, "extra.pdf"));
    press({ key: "O", ctrlKey: true, shiftKey: true });
    expect(await screen.findByText("Merged extra.pdf (3 pages)")).toBeInTheDocument();
    expect(tabNames()).toEqual(["a.pdf"]);
    expect(docTab(/a\.pdf/)).toHaveTextContent("+1");
    expect(status()).toHaveTextContent("of 5");
    expect(status()).toHaveTextContent("2 files");
  });

  it("Merge PDFs with nothing open combines the files into one tab in the document view", async () => {
    render(<App />);
    openReturns(doc(701, 1, "one.pdf"), doc(702, 2, "two.pdf"));
    await userEvent.click(screen.getByRole("button", { name: /Merge PDFs/ }));
    expect(await screen.findByText("Merged 2 files (3 pages)")).toBeInTheDocument();
    expect(tabNames()).toEqual(["one.pdf"]);
    expect(docTab(/one\.pdf/)).toHaveTextContent("+1");
    expect(screen.getByRole("navigation", { name: "Reader tools" })).toBeInTheDocument();
    expect(status()).toHaveTextContent("Page 1 of 3");
    expect(status()).toHaveTextContent("2 files");
    // Opening one of the merged files on its own gives it its own tab.
    openReturns(doc(702, 2, "two.pdf"));
    await userEvent.click(screen.getByRole("button", { name: /^Open$/ }));
    expect(await screen.findByText("Opened two.pdf (2 pages)")).toBeInTheDocument();
    expect(tabNames()).toEqual(["one.pdf", "two.pdf"]);
  });

  it("Ctrl+Shift+O with nothing open merges into a new tab", async () => {
    render(<App />);
    openReturns(doc(703, 1, "solo.pdf"));
    press({ key: "O", ctrlKey: true, shiftKey: true });
    expect(await screen.findByText("Merged solo.pdf (1 page)")).toBeInTheDocument();
    expect(tabNames()).toEqual(["solo.pdf"]);
    expect(docTab(/solo\.pdf/)).not.toHaveTextContent("+");
  });

  it("Merge PDFs from the library appends to the current tab and shows the merged pages", async () => {
    render(<App />);
    await openDoc(2, "a.pdf");
    await goLibrary();
    openReturns(doc(704, 3, "extra.pdf"));
    await userEvent.click(screen.getByRole("button", { name: /Merge PDFs/ }));
    expect(await screen.findByText("Merged extra.pdf (3 pages)")).toBeInTheDocument();
    expect(tabNames()).toEqual(["a.pdf"]);
    expect(screen.getByRole("navigation", { name: "Reader tools" })).toBeInTheDocument();
    await waitFor(() => expect(status()).toHaveTextContent("Page 3 of 5"));
  });

  it("clicking a tab from the library opens its document", async () => {
    render(<App />);
    await openDoc(1, "a.pdf");
    await openDoc(2, "b.pdf");
    await goLibrary();
    expect(screen.queryByRole("navigation", { name: "Reader tools" })).not.toBeInTheDocument();
    await userEvent.click(docTab(/a\.pdf/));
    expect(activeTabName()).toBe("a.pdf");
    expect(screen.getByRole("navigation", { name: "Reader tools" })).toBeInTheDocument();
    expect(status()).toHaveTextContent("Page 1 of 1");
    // The Page Organizer stays where it is.
    await nav("Organize");
    await userEvent.click(docTab(/b\.pdf/));
    expect(activeTabName()).toBe("b.pdf");
    expect(screen.getByRole("navigation", { name: "Selection tools" })).toBeInTheDocument();
  });

  it("closing a tab frees documents no other tab uses", async () => {
    render(<App />);
    const a = await openDoc(2, "a.pdf");
    const b = await openDoc(1, "b.pdf");
    // Merge a.pdf's document into b.pdf's tab as well.
    openReturns(a);
    press({ key: "O", ctrlKey: true, shiftKey: true });
    await screen.findByText("Merged a.pdf (2 pages)");
    await userEvent.click(screen.getByRole("button", { name: "Close a.pdf" }));
    await waitFor(() => expect(tabNames()).toEqual(["b.pdf"]));
    expect(tauriMock.calls("close_document")).toEqual([]); // b.pdf's tab still uses it
    tauriMock.ask.mockResolvedValue(true); // the merge left b.pdf unsaved
    press({ key: "w", ctrlKey: true });
    await waitFor(() => expect(tabNames()).toEqual([]));
    expect(tauriMock.calls("close_document")).toEqual(
      expect.arrayContaining([{ docId: a.docId }, { docId: b.docId }]),
    );
    expect(screen.getByText("No document open")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Library" })).toBeInTheDocument();
  });

  it("middle-click closes a tab; other buttons do not", async () => {
    render(<App />);
    await openDoc(1, "a.pdf");
    await openDoc(1, "b.pdf");
    fireEvent(docTab(/a\.pdf/), new MouseEvent("auxclick", { bubbles: true, button: 1 }));
    await waitFor(() => expect(tabNames()).toEqual(["b.pdf"]));
    fireEvent(docTab(/b\.pdf/), new MouseEvent("auxclick", { bubbles: true, button: 2 }));
    expect(tabNames()).toEqual(["b.pdf"]);
  });

  it("tabs can be switched from the keyboard and the palette", async () => {
    render(<App />);
    await openDoc(1, "a.pdf");
    await openDoc(1, "b.pdf");
    fireEvent.keyDown(docTab(/a\.pdf/), { key: "Enter" });
    expect(activeTabName()).toBe("a.pdf");
    await userEvent.click(screen.getByRole("button", { name: /Commands/ }));
    await userEvent.click(screen.getByText("Next tab"));
    expect(activeTabName()).toBe("b.pdf");
    await userEvent.click(screen.getByRole("button", { name: /Commands/ }));
    await userEvent.click(screen.getByText("Close tab"));
    await waitFor(() => expect(tabNames()).toEqual(["a.pdf"]));
  });
});

describe("App: organize pages", () => {
  it("select, rotate, delete, undo and redo", async () => {
    render(<App />);
    await openDoc(4);
    await nav("Organize");
    expect(screen.getByRole("navigation", { name: "Selection tools" })).toBeInTheDocument();
    // The page shown in the reader (page 1) comes in selected.
    expect(status()).toHaveTextContent("Selection: 1 page");

    fireEvent.click(screen.getByLabelText("Page 3"), { shiftKey: true });
    expect(status()).toHaveTextContent("Selection: 3 pages");

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
    await nav("Organize");
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
    await nav("Organize");
    fireEvent.click(screen.getByLabelText("Page 3"), { ctrlKey: true });
    fireEvent.click(screen.getByLabelText("Page 1"), { ctrlKey: true });
    expect(status()).toHaveTextContent("Selection: 1 page");
    press({ key: "Enter" });
    expect(await screen.findByRole("radiogroup", { name: "Edit tool" })).toBeInTheDocument();
    expect(status()).toHaveTextContent("Page 3 of 3");

    await nav("Organize");
    await userEvent.click(within(screen.getByRole("navigation", { name: "Selection tools" })).getByRole("button", { name: /Edit page/ }));
    expect(await screen.findByRole("radiogroup", { name: "Edit tool" })).toBeInTheDocument();
  });

  it("toolbar: deselect all clears the selection and turns the tools off", async () => {
    render(<App />);
    await openDoc(2);
    await nav("Organize");
    const bar = screen.getByRole("navigation", { name: "Selection tools" });
    const deselect = within(bar).getByRole("button", { name: "Deselect all" });
    await userEvent.click(deselect);
    expect(status()).toHaveTextContent("Selection: none");
    expect(deselect).toBeDisabled();
    expect(within(bar).getByRole("button", { name: /Rotate \+90°/ })).toBeDisabled();
  });

  it("thumbnail size slider", async () => {
    render(<App />);
    await openDoc(1);
    await nav("Organize");
    fireEvent.change(screen.getByRole("slider"), { target: { value: "300" } });
    expect(screen.getByLabelText("Page 1")).toHaveStyle({ width: "300px" });
  });
});

describe("App: save", () => {
  it("sends the workspace to the backend and marks it saved", async () => {
    render(<App />);
    const d = await openDoc(2, "Report.PDF");
    await nav("Organize");
    await userEvent.click(screen.getByRole("button", { name: /Rotate \+90°/ }));
    tauriMock.handle("save_with_dialog", () => ({ path: "C:\\out\\Report-edited.pdf", warnings: ["Page 2 was copied without edits"] }));

    press({ key: "s", ctrlKey: true });
    expect(await screen.findByText("Saved C:\\out\\Report-edited.pdf")).toBeInTheDocument();
    expect(screen.getByText("Page 2 was copied without edits").closest(".toast")).toHaveClass("error");
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
    await nav("Organize");
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

  it("sanitize can be turned off in settings", async () => {
    render(<App />);
    await openDoc(1);
    await openSettings();
    await userEvent.click(screen.getByRole("checkbox", { name: "Sanitize on save" }));
    expect(screen.getByRole("checkbox", { name: "Sanitize on save" })).not.toBeChecked();
    tauriMock.handle("save_with_dialog", () => null);
    await userEvent.click(screen.getByRole("button", { name: /Save as/ }));
    await waitFor(() => expect(tauriMock.calls("save_with_dialog")[0].args).toMatchObject({ sanitize: false }));
  });
});

describe("App: views and find", () => {
  const view = () => screen.queryByRole("radiogroup", { name: "View" });
  const checked = () => within(view()!).getByRole("radio", { checked: true });
  const findBox = () => screen.queryByRole("textbox", { name: "Find in document" });

  it("the view switch appears with a document and follows the view", async () => {
    render(<App />);
    expect(view()).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Library" })).toHaveAttribute("aria-current", "page");
    await openDoc(2);
    expect(checked()).toHaveAccessibleName("Read");
    await nav("Organize");
    expect(checked()).toHaveAccessibleName("Organize");
    await nav("Edit");
    expect(await screen.findByRole("radiogroup", { name: "Edit tool" })).toBeInTheDocument();
    expect(checked()).toHaveAccessibleName("Edit");
    // The Library is home: no view is checked there, and the document stays open.
    await goLibrary();
    expect(within(view()!).queryByRole("radio", { checked: true })).not.toBeInTheDocument();
    expect(tabNames()).toEqual(["report.pdf"]);
  });

  it("Ctrl+F opens find in the read view, from any view, and Esc closes it", async () => {
    render(<App />);
    // Nothing to search with no document.
    press({ key: "f", ctrlKey: true });
    expect(findBox()).not.toBeInTheDocument();

    await openDoc(2);
    await nav("Organize");
    press({ key: "f", ctrlKey: true });
    expect(checked()).toHaveAccessibleName("Read");
    expect(findBox()).toHaveFocus();
    expect(screen.getByRole("button", { name: "Find" })).toHaveAttribute("aria-pressed", "true");

    fireEvent.keyDown(findBox()!, { key: "Escape" });
    expect(findBox()).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Find" })).toHaveAttribute("aria-pressed", "false");

    // The toolbar button and the palette open it too.
    await userEvent.click(screen.getByRole("button", { name: "Find" }));
    expect(findBox()).toHaveFocus();
    await userEvent.click(screen.getByRole("button", { name: "Close find" }));
    press({ key: "k", ctrlKey: true });
    await userEvent.type(await screen.findByRole("textbox", { name: "Search commands" }), "find in document");
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Search commands" }), { key: "Enter" });
    expect(findBox()).toBeInTheDocument();
  });
});

describe("App: recent files", () => {
  const item = (id: number, fileName: string) => ({ id, fileName, folder: "C:\\docs", openedAt: Date.now() });
  const recentRows = () => within(screen.getByRole("list")).queryAllByRole("listitem");

  it("the Library shows the list from Rust and opens an entry by id in a new tab", async () => {
    recentList = { enabled: true, items: [item(4, "report.pdf"), item(2, "old.pdf")] };
    render(<App />);
    await waitFor(() => expect(recentRows()).toHaveLength(2));
    tauriMock.handle("open_recent", (a) => opened(doc(nextDoc++, 3, a.id === 4 ? "report.pdf" : "old.pdf")));
    await userEvent.click(screen.getByRole("button", { name: /^report\.pdf/ }));
    expect(await screen.findByText("Opened report.pdf (3 pages)")).toBeInTheDocument();
    expect(tauriMock.calls("open_recent")).toEqual([{ id: 4 }]);
    expect(tabNames()).toEqual(["report.pdf"]);
    // The list is asked for again after an open: Rust moved the file to the top.
    expect(tauriMock.calls("list_recent").length).toBeGreaterThanOrEqual(2);
  });

  it("a file that was moved or deleted is reported, and the list is refreshed", async () => {
    recentList = { enabled: true, items: [item(5, "gone.pdf")] };
    render(<App />);
    await waitFor(() => expect(recentRows()).toHaveLength(1));
    tauriMock.handle("open_recent", () => {
      recentList = { enabled: true, items: [] };
      return { fileName: "gone.pdf", document: null, error: "This file was moved or deleted, so it was taken off the recent list." };
    });
    await userEvent.click(screen.getByRole("button", { name: /^gone\.pdf/ }));
    expect(await screen.findByText(/gone\.pdf: This file was moved or deleted/)).toBeInTheDocument();
    expect(await screen.findByText("No recent files")).toBeInTheDocument();
    expect(tabList()).not.toBeInTheDocument();
  });

  it("remove, clear and the settings switch use the list Rust hands back", async () => {
    recentList = { enabled: true, items: [item(1, "a.pdf"), item(2, "b.pdf")] };
    render(<App />);
    await waitFor(() => expect(recentRows()).toHaveLength(2));
    tauriMock.handle("remove_recent", () => ({ enabled: true, items: [item(2, "b.pdf")] }));
    await userEvent.click(screen.getByRole("button", { name: "Remove a.pdf from the list" }));
    expect(tauriMock.calls("remove_recent")).toEqual([{ id: 1 }]);
    await waitFor(() => expect(recentRows()).toHaveLength(1));

    tauriMock.handle("clear_recent", () => ({ enabled: true, items: [] }));
    await userEvent.click(screen.getByRole("button", { name: "Clear list" }));
    expect(await screen.findByText("No recent files")).toBeInTheDocument();

    tauriMock.handle("set_recent_enabled", (a) => ({ enabled: a.enabled as boolean, items: [] }));
    await openSettings();
    const remember = screen.getByRole("checkbox", { name: "Remember recent files" });
    expect(remember).toBeChecked();
    await userEvent.click(remember);
    expect(tauriMock.calls("set_recent_enabled")).toEqual([{ enabled: false }]);
    await waitFor(() => expect(remember).not.toBeChecked());
    expect(screen.queryByRole("heading", { name: "Recent" })).not.toBeInTheDocument();
  });

  it("a change Rust refuses is reported; a list that cannot be read is simply not shown", async () => {
    tauriMock.handle("list_recent", () => {
      throw "unreadable";
    });
    render(<App />);
    await waitFor(() => expect(tauriMock.calls("list_recent")).toHaveLength(1));
    expect(screen.queryByRole("heading", { name: "Recent" })).not.toBeInTheDocument();
    tauriMock.handle("set_recent_enabled", () => {
      throw "Could not change the setting.";
    });
    await openSettings();
    await userEvent.click(screen.getByRole("checkbox", { name: "Remember recent files" }));
    expect(await screen.findByText("Could not change the setting.")).toBeInTheDocument();
  });

  it("an open that fails outright is reported", async () => {
    recentList = { enabled: true, items: [item(9, "x.pdf")] };
    render(<App />);
    await waitFor(() => expect(recentRows()).toHaveLength(1));
    tauriMock.handle("open_recent", () => {
      throw "Worker crashed.";
    });
    await userEvent.click(screen.getByRole("button", { name: /^x\.pdf/ }));
    expect(await screen.findByText("Worker crashed.")).toBeInTheDocument();
  });
});

describe("App: password-protected files", () => {
  const lockedOutcome = (fileName: string, locked: number, error: string | null = null) => ({
    fileName,
    document: null,
    error,
    locked,
  });
  const dialog = () => screen.queryByRole("dialog", { name: "Enter password" });
  const passwordBox = () => screen.getByLabelText("Password");

  it("asks for the password, retries a wrong one, then opens the file with a lock on its tab", async () => {
    tauriMock.handle("open_with_dialog", () => [lockedOutcome("secret.pdf", 7)]);
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: /^Open$/ }));
    expect(await screen.findByRole("dialog", { name: "Enter password" })).toHaveTextContent("secret.pdf");
    // A locked file is not an error.
    expect(document.querySelector(".toast.error")).toBeNull();

    tauriMock.handle("unlock_file", (a) =>
      a.password === "right"
        ? { ...opened({ ...doc(901, 2, "secret.pdf"), protected: true }) }
        : lockedOutcome("secret.pdf", 7, "Wrong password. Try again."),
    );
    await userEvent.type(passwordBox(), "wrong{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("Wrong password. Try again.");
    expect(tabList()).not.toBeInTheDocument();

    await userEvent.type(passwordBox(), "right{Enter}");
    expect(await screen.findByText("Opened secret.pdf (2 pages)")).toBeInTheDocument();
    expect(dialog()).not.toBeInTheDocument();
    expect(tauriMock.calls("unlock_file")).toEqual([
      { lockedId: 7, password: "wrong" },
      { lockedId: 7, password: "right" },
    ]);
    expect(within(docTab(/secret\.pdf/)).getByLabelText("Password-protected")).toBeInTheDocument();
  });

  it("several protected files are asked for one after another; Cancel skips one", async () => {
    tauriMock.handle("open_with_dialog", () => [lockedOutcome("a.pdf", 1), opened(doc(902, 1, "plain.pdf")), lockedOutcome("b.pdf", 2)]);
    tauriMock.handle("discard_locked", () => null);
    tauriMock.handle("unlock_file", () => opened({ ...doc(903, 3, "b.pdf"), protected: true }));
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: /^Open$/ }));
    // The plain file opens at once.
    expect(await screen.findByText("Opened plain.pdf (1 page)")).toBeInTheDocument();
    expect(dialog()).toHaveTextContent("a.pdf");
    expect(dialog()).toHaveTextContent("1 more file waiting");

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(tauriMock.calls("discard_locked")).toEqual([{ lockedId: 1 }]);
    expect(dialog()).toHaveTextContent("b.pdf");
    await userEvent.type(passwordBox(), "pw{Enter}");
    expect(await screen.findByText("Opened b.pdf (3 pages)")).toBeInTheDocument();
    expect(tabNames()).toEqual(["plain.pdf", "b.pdf"]);
  });

  it("app shortcuts are off while the prompt is open", async () => {
    tauriMock.handle("open_with_dialog", () => [lockedOutcome("a.pdf", 1)]);
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: /^Open$/ }));
    await screen.findByRole("dialog", { name: "Enter password" });
    press({ key: "k", ctrlKey: true });
    press({ key: "o", ctrlKey: true });
    expect(screen.queryByRole("dialog", { name: "Command palette" })).not.toBeInTheDocument();
    expect(tauriMock.calls("open_with_dialog")).toHaveLength(1);
  });

  it("a file that fails for another reason, or an unlock that throws, is reported and the prompt moves on", async () => {
    tauriMock.handle("open_with_dialog", () => [lockedOutcome("a.pdf", 1), lockedOutcome("b.pdf", 2)]);
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: /^Open$/ }));
    tauriMock.handle("unlock_file", () => ({ fileName: "a.pdf", document: null, error: "This file is damaged." }));
    await userEvent.type(await screen.findByLabelText("Password"), "pw{Enter}");
    expect(await screen.findByText("a.pdf: This file is damaged.")).toBeInTheDocument();
    expect(dialog()).toHaveTextContent("b.pdf");

    tauriMock.handle("unlock_file", () => {
      throw "Worker crashed.";
    });
    await userEvent.type(passwordBox(), "pw{Enter}");
    expect(await screen.findByText("b.pdf: Worker crashed.")).toBeInTheDocument();
    expect(dialog()).not.toBeInTheDocument();
  });

  it("merging a protected file appends it once unlocked", async () => {
    render(<App />);
    await openDoc(2, "main.pdf");
    tauriMock.handle("open_with_dialog", () => [lockedOutcome("extra.pdf", 4)]);
    press({ key: "o", ctrlKey: true, shiftKey: true });
    await screen.findByRole("dialog", { name: "Enter password" });
    tauriMock.handle("unlock_file", () => opened({ ...doc(904, 3, "extra.pdf"), protected: true }));
    await userEvent.type(passwordBox(), "pw{Enter}");
    expect(await screen.findByText("Merged extra.pdf (3 pages)")).toBeInTheDocument();
    expect(tabNames()).toEqual(["main.pdf"]);
  });

  it("a save of a protected document says it keeps the password", async () => {
    tauriMock.handle("open_with_dialog", () => [lockedOutcome("secret.pdf", 7)]);
    tauriMock.handle("unlock_file", () => opened({ ...doc(905, 1, "secret.pdf"), protected: true }));
    tauriMock.handle("save_with_dialog", () => ({ path: "C:\\out\\secret-edited.pdf", warnings: [], protected: true }));
    render(<App />);
    await userEvent.click(screen.getByRole("button", { name: /^Open$/ }));
    await userEvent.type(await screen.findByLabelText("Password"), "pw{Enter}");
    await screen.findByText("Opened secret.pdf (1 page)");
    await userEvent.click(screen.getByRole("button", { name: /Save as/ }));
    expect(await screen.findByText("Saved C:\\out\\secret-edited.pdf. It opens with the same password.")).toBeInTheDocument();
  });
});

describe("App: unsaved-changes guards", () => {
  async function dirtyApp() {
    render(<App />);
    await openDoc(2, "a.pdf");
    await nav("Organize");
    press({ key: "Delete" });
  }

  it("opening another file never asks: the unsaved tab stays open", async () => {
    await dirtyApp();
    openReturns(doc(900, 1, "other.pdf"));
    await userEvent.click(screen.getByRole("button", { name: /^Open$/ }));
    await screen.findByText("Opened other.pdf (1 page)");
    expect(tauriMock.ask).not.toHaveBeenCalled();
    expect(tabNames()).toEqual(["a.pdf", "other.pdf"]);
  });

  it("asks before closing a tab with unsaved changes; No keeps it", async () => {
    await dirtyApp();
    tauriMock.ask.mockResolvedValue(false);
    press({ key: "w", ctrlKey: true });
    await waitFor(() =>
      expect(tauriMock.ask).toHaveBeenCalledWith("a.pdf has unsaved changes. Close it anyway?", expect.anything()),
    );
    expect(tabNames()).toEqual(["a.pdf"]);
    expect(tauriMock.calls("close_document")).toEqual([]);
    tauriMock.ask.mockResolvedValue(true);
    press({ key: "w", ctrlKey: true });
    await waitFor(() => expect(tabNames()).toEqual([]));
  });

  it("counts every unsaved tab when quitting", async () => {
    await dirtyApp();
    await openDoc(2, "b.pdf"); // stays in the organizer; switching tabs clears the selection
    fireEvent.click(screen.getByLabelText("Page 1"));
    press({ key: "Delete" });
    tauriMock.ask.mockResolvedValue(false);
    expect(await tauriMock.requestClose()).toBe(true);
    expect(tauriMock.ask).toHaveBeenCalledWith("2 documents have unsaved changes. Quit anyway?", expect.anything());
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

describe("App: updates", () => {
  const status = (s: Partial<{ configured: boolean; available: boolean; version: string | null; downloaded: boolean }>) => ({
    currentVersion: "0.1.0",
    configured: true,
    available: false,
    version: null,
    notes: null,
    downloaded: false,
    ...s,
  });
  const found = status({ available: true, version: "0.2.0" });
  const willInstall =
    `${APP_NAME} 0.2.0 will install when you quit. To install it now, choose "Restart to install" in the command palette.`;
  const manual = () => localStorage.setItem("novapdf.autoUpdate", "0");
  async function runCommand(text: string) {
    press({ key: "k", ctrlKey: true });
    const box = await screen.findByRole("textbox", { name: "Search commands" });
    await userEvent.type(box, text);
    fireEvent.keyDown(box, { key: "Enter" });
  }

  describe("automatic (the default)", () => {
    it("downloads an update found at launch to install on quit; Restart installs it now", async () => {
      tauriMock.handle("check_update", () => found);
      tauriMock.handle("download_update", () => null);
      tauriMock.handle("install_update", () => null);
      render(<App />);
      await screen.findByText(willInstall);
      expect(tauriMock.calls("download_update")).toHaveLength(1);
      await runCommand(`restart to install ${APP_NAME.toLowerCase()} 0.2.0`);
      await waitFor(() => expect(tauriMock.calls("install_update")).toHaveLength(1));
    });

    it("re-checks periodically and announces a version only once", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        tauriMock.handle("check_update", () => found);
        tauriMock.handle("download_update", () => null);
        render(<App />);
        await vi.waitFor(() => expect(screen.getByText(willInstall)).toBeInTheDocument());
        tauriMock.handle("check_update", () => ({ ...found, downloaded: true }));
        // Long enough for the first toast to expire, so any toast now is a repeat.
        await act(async () => {
          await vi.advanceTimersByTimeAsync(UPDATE_CHECK_INTERVAL_MS);
        });
        expect(tauriMock.calls("check_update")).toHaveLength(2);
        expect(tauriMock.calls("download_update")).toHaveLength(1);
        expect(screen.queryByText(willInstall)).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("stops checking in a build that can't update itself", async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      try {
        tauriMock.handle("check_update", () => status({ configured: false }));
        render(<App />);
        await waitFor(() => expect(tauriMock.calls("check_update")).toHaveLength(1));
        await act(async () => {
          await vi.advanceTimersByTimeAsync(2 * UPDATE_CHECK_INTERVAL_MS);
        });
        expect(tauriMock.calls("check_update")).toHaveLength(1);
        expect(document.querySelector(".toast")).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    });

    it("a failed background download stays quiet and leaves the update to install by hand", async () => {
      tauriMock.handle("check_update", () => found);
      render(<App />); // download_update has no handler, so it fails
      await screen.findByText(`${APP_NAME} 0.2.0 is available. Install it from the command palette.`);
      expect(document.querySelector(".toast.error")).toBeNull();
      // A check the user asks for reports the failure.
      await runCommand("check for updates");
      await screen.findByText(new RegExp(`Couldn.t download ${APP_NAME} 0\\.2\\.0: Unexpected Tauri command`));
    });

    it("turning it off discards the download; turning it on downloads again", async () => {
      tauriMock.handle("check_update", () => found);
      tauriMock.handle("download_update", () => null);
      tauriMock.handle("discard_update", () => null);
      render(<App />);
      await screen.findByText(willInstall);

      await runCommand("turn off automatic updates");
      await screen.findByText("Automatic updates are off. Check for updates from the command palette.");
      await waitFor(() => expect(tauriMock.calls("discard_update")).toHaveLength(1));
      expect(localStorage.getItem("novapdf.autoUpdate")).toBe("0");
      press({ key: "k", ctrlKey: true });
      await userEvent.type(await screen.findByRole("textbox", { name: "Search commands" }), `install ${APP_NAME.toLowerCase()}`);
      expect(screen.getByRole("option", { name: new RegExp(`^Install ${APP_NAME} 0\\.2\\.0`) })).not.toHaveAttribute("aria-disabled", "true");
      press({ key: "Escape" });

      await runCommand("turn on automatic updates");
      await screen.findByText(/Automatic updates are on/);
      await waitFor(() => expect(tauriMock.calls("download_update")).toHaveLength(2));
      expect(await screen.findAllByText(willInstall)).toHaveLength(2);
    });
  });

  describe("manual", () => {
    it("reports an update found at launch and installs it from the palette", async () => {
      manual();
      tauriMock.handle("check_update", () => found);
      tauriMock.handle("install_update", () => null);
      render(<App />);
      await screen.findByText(`${APP_NAME} 0.2.0 is available. Install it from the command palette.`);
      expect(tauriMock.calls("download_update")).toHaveLength(0);
      await runCommand(`install ${APP_NAME.toLowerCase()} 0.2.0`);
      await waitFor(() => expect(tauriMock.calls("install_update")).toHaveLength(1));
      expect(tauriMock.ask).not.toHaveBeenCalled();
    });

    it("stays quiet at launch when the check fails, and offers no install", async () => {
      render(<App />);
      await waitFor(() => expect(tauriMock.calls("check_update")).toHaveLength(1));
      expect(document.querySelector(".toast")).toBeNull();
      press({ key: "k", ctrlKey: true });
      await userEvent.type(await screen.findByRole("textbox", { name: "Search commands" }), `install ${APP_NAME.toLowerCase()}`);
      expect(screen.getByRole("option", { name: new RegExp(`Install ${APP_NAME} update`) })).toHaveAttribute("aria-disabled", "true");
    });

    it("Check for updates reports each outcome", async () => {
      manual();
      tauriMock.handle("check_update", () => status({ configured: false }));
      render(<App />);
      await waitFor(() => expect(tauriMock.calls("check_update")).toHaveLength(1));
      await runCommand("check for updates");
      await screen.findByText(/This build can't update itself/);

      tauriMock.handle("check_update", () => status({}));
      await runCommand("check for updates");
      await screen.findByText(`${APP_NAME} is up to date (version 0.1.0).`);

      tauriMock.handle("check_update", () => found);
      await runCommand("check for updates");
      await screen.findByText(`${APP_NAME} 0.2.0 is available. Install it from the command palette.`);

      tauriMock.handle("check_update", () => {
        throw new Error("offline");
      });
      await runCommand("check for updates");
      await screen.findByText("Couldn't check for updates: offline");
    });

    it("asks before installing over unsaved changes, and reports a failed install", async () => {
      manual();
      tauriMock.handle("check_update", () => found);
      tauriMock.handle("install_update", () => {
        throw new Error("bad signature");
      });
      render(<App />);
      await openDoc(2, "a.pdf");
      await nav("Organize");
      press({ key: "Delete" });

      tauriMock.ask.mockResolvedValue(false);
      await runCommand(`install ${APP_NAME.toLowerCase()} 0.2.0`);
      await waitFor(() =>
        expect(tauriMock.ask).toHaveBeenCalledWith(
          `You have unsaved changes. ${APP_NAME} restarts to install the update. Continue?`,
          expect.anything(),
        ),
      );
      expect(tauriMock.calls("install_update")).toHaveLength(0);

      tauriMock.ask.mockResolvedValue(true);
      await runCommand(`install ${APP_NAME.toLowerCase()} 0.2.0`);
      await screen.findByText("Couldn't install the update: bad signature");
      expect(tauriMock.calls("install_update")).toHaveLength(1);
    });
  });
});

describe("App: navigation and command palette", () => {
  it("a document with every page deleted says so, and the Library is one click away", async () => {
    render(<App />);
    await openDoc(1);
    await nav("Organize");
    press({ key: "Delete" });
    expect(screen.getByRole("heading", { name: "No pages to show" })).toBeInTheDocument();
    await goLibrary();
    expect(screen.getByRole("heading", { name: "Library" })).toBeInTheDocument();
    // Nothing unbuilt is offered anywhere in the shell.
    expect(screen.queryByText(/coming soon/i)).not.toBeInTheDocument();
  });

  it("Ctrl+K opens the palette; running a command closes it", async () => {
    render(<App />);
    await openDoc(2);
    press({ key: "k", ctrlKey: true });
    const box = await screen.findByRole("textbox", { name: "Search commands" });
    await userEvent.type(box, "organize pages");
    fireEvent.keyDown(box, { key: "Enter" });
    expect(screen.queryByRole("dialog", { name: "Command palette" })).not.toBeInTheDocument();
    expect(screen.getByRole("navigation", { name: "Selection tools" })).toBeInTheDocument();

    // Palette commands that act on the selection.
    await userEvent.click(screen.getByRole("button", { name: /Commands/ }));
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

  it("read toolbar: comment tools stay in read view, with colours for the drawing tools", async () => {
    render(<App />);
    await openDoc(1);
    const tools = screen.getByRole("navigation", { name: "Reader tools" });
    const tool = (name: string) => within(tools).getByRole("button", { name: new RegExp(`^${name}$`) });
    expect(tool("Hand")).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(tool("Select"));
    expect(tool("Select")).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("radiogroup", { name: "Edit tool" })).not.toBeInTheDocument();
    expect(screen.queryByRole("radiogroup", { name: "Colour" })).not.toBeInTheDocument();

    await userEvent.click(tool("Highlight"));
    const colours = screen.getByRole("radiogroup", { name: "Colour" });
    expect(within(colours).getByRole("radio", { name: "Yellow" })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(within(colours).getByRole("radio", { name: "Green" }));
    expect(within(colours).getByRole("radio", { name: "Green" })).toHaveAttribute("aria-checked", "true");

    // Ink has its own colour, and the marker uses the highlight colour.
    await userEvent.click(tool("Draw"));
    expect(within(screen.getByRole("radiogroup", { name: "Colour" })).getByRole("radio", { name: "Red" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await userEvent.click(screen.getByRole("button", { name: "Marker" }));
    expect(screen.getByRole("button", { name: "Marker" })).toHaveAttribute("aria-pressed", "true");
    expect(within(screen.getByRole("radiogroup", { name: "Colour" })).getByRole("radio", { name: "Green" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    await userEvent.click(tool("Note"));
    expect(screen.queryByRole("button", { name: "Marker" })).not.toBeInTheDocument();

    // Esc in the document goes back to the hand.
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(tool("Hand")).toHaveAttribute("aria-pressed", "true");
  });
});

describe("App: watermarks", () => {
  it("applies a watermark from the Watermark tool and sends it on save", async () => {
    render(<App />);
    await openDoc(1);
    await userEvent.click(screen.getByRole("button", { name: /^Watermark$/ }));
    await userEvent.click(await screen.findByRole("button", { name: /Apply to all pages/ }));
    expect(screen.queryByRole("dialog", { name: "Watermark" })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^Watermark$/ })).toHaveClass("active");
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
    await userEvent.click(screen.getByRole("button", { name: /Remove watermarks/ }));
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
