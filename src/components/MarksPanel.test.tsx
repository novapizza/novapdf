import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MarksPanel } from "./MarksPanel";
import { clearAnnotCache } from "../lib/annotations";
import type { AnnotInfo, PageAnnots } from "../lib/types";
import { EMPTY_EDITS } from "../lib/types";
import { tauriMock } from "../test/tauri";
import { annotInfo, doc, newHighlight, page } from "../test/fixtures";

afterEach(() => clearAnnotCache());

function serve(perPage: Record<number, AnnotInfo[]>, more: Record<number, number> = {}) {
  tauriMock.handle("list_annotations", (a) =>
    Array.from({ length: a.count as number }, (_, i): PageAnnots => {
      const pageIndex = (a.first as number) + i;
      return { pageIndex, annots: perPage[pageIndex] ?? [], more: more[pageIndex] ?? 0 };
    }),
  );
}

function setup(pages = [page("A", 1, 0), page("B", 1, 1)], docs = new Map([[1, doc(1, 2)]])) {
  const onOpen = vi.fn();
  const onAuthor = vi.fn();
  const utils = render(<MarksPanel pages={pages} docs={docs} author="Linh" onAuthor={onAuthor} onOpen={onOpen} />);
  return { ...utils, onOpen, onAuthor };
}

describe("MarksPanel", () => {
  it("lists the file's comments and new ones by page, and opens one", async () => {
    serve({
      0: [annotInfo(0, { contents: "First", author: "Ann" }), annotInfo(1, { inReplyTo: 0 }), annotInfo(2, { inReplyTo: 0 })],
      1: [annotInfo(0, { subtype: "Highlight", contents: "" })],
    });
    const hl = newHighlight("h1", { contents: "Mine", author: "Linh" });
    const pages = [page("A", 1, 0), page("B", 1, 1, { edits: { ...EMPTY_EDITS, annotations: [hl] } })];
    const { onOpen } = setup(pages);
    const list = await screen.findByRole("list", { name: "Comments" });
    await waitFor(() => expect(within(list).getAllByRole("button")).toHaveLength(3));
    expect(within(list).getByText("Page 1")).toBeInTheDocument();
    expect(within(list).getByText("Page 2")).toBeInTheDocument();
    const first = within(list).getByRole("button", { name: /First/ });
    expect(first).toHaveTextContent("2 replies");
    expect(within(list).getByRole("button", { name: /Mine/ })).toHaveTextContent("unsaved");
    await userEvent.click(first);
    expect(onOpen).toHaveBeenCalledWith("A", { kind: "file", index: 0 }, annotInfo(0).rect);
    await userEvent.click(within(list).getByRole("button", { name: /Mine/ }));
    expect(onOpen).toHaveBeenLastCalledWith("B", { kind: "new", id: "h1" }, { x: 72, y: 90, width: 100, height: 14 });
  });

  it("filters by text or author, and hides removed comments", async () => {
    serve({ 0: [annotInfo(0, { contents: "Budget", author: "Ann" }), annotInfo(1, { contents: "Typo", author: "Bo" })] });
    const pages = [page("A", 1, 0, { edits: { ...EMPTY_EDITS, removedAnnots: [5] } })];
    setup(pages, new Map([[1, doc(1, 1)]]));
    const list = await screen.findByRole("list", { name: "Comments" });
    await waitFor(() => expect(within(list).getAllByRole("button")).toHaveLength(2));
    await userEvent.type(screen.getByRole("searchbox", { name: "Filter comments" }), "bo");
    expect(within(screen.getByRole("list", { name: "Comments" })).getAllByRole("button")).toHaveLength(1);
    await userEvent.type(screen.getByRole("searchbox", { name: "Filter comments" }), "zz");
    expect(screen.getByText("No matching comments")).toBeInTheDocument();
  });

  it("shows progress while scanning, then the empty state", async () => {
    let release: () => void = () => {};
    tauriMock.handle(
      "list_annotations",
      (a) =>
        new Promise((resolve) => {
          release = () => resolve([{ pageIndex: a.first, annots: [], more: 3 }, { pageIndex: (a.first as number) + 1, annots: [], more: 0 }]);
        }),
    );
    setup();
    expect(await screen.findByRole("status")).toHaveTextContent("Looking for comments… 0 / 2 pages");
    release();
    expect(await screen.findByText("No comments yet")).toBeInTheDocument();
    expect(screen.getByText("3 more comments not shown (too many on one page)")).toBeInTheDocument();
  });

  it("reports a scan that fails", async () => {
    tauriMock.handle("list_annotations", () => {
      throw new Error("worker gone");
    });
    setup();
    expect(await screen.findByText("Comments could not be read: worker gone")).toBeInTheDocument();
  });

  it("edits the author name", async () => {
    serve({});
    const { onAuthor } = setup([page("A", 1, 0)], new Map());
    const input = screen.getByRole("textbox", { name: "Your name on new comments" });
    expect(input).toHaveValue("Linh");
    await userEvent.type(input, "!");
    expect(onAuthor).toHaveBeenCalledWith("Linh!");
  });
});
