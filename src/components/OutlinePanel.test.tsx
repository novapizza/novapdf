import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { OutlinePanel } from "./OutlinePanel";
import { clearOutlineCache } from "../lib/outline";
import type { Outline } from "../lib/types";
import type { PageItem } from "../state/workspace";
import { tauriMock } from "../test/tauri";
import { doc, outlineItem as item, page } from "../test/fixtures";

afterEach(clearOutlineCache);

const OUTLINE: Outline = {
  items: [
    item("Intro", 0, 0, { open: true, y: 120 }),
    item("Background", 1, 1),
    item("Design", 0, 2),
    item("Detail", 1, 3),
    item("Elsewhere", 0, null),
    item("", 0, 2),
  ],
  truncated: false,
};

const docs = new Map([
  [1, doc(1, 4, "report.pdf")],
  [2, doc(2, 2, "notes.pdf")],
]);

function setup(opts: { pages?: PageItem[]; current?: number; outlines?: Record<number, Outline | Error> } = {}) {
  const outlines = opts.outlines ?? { 1: OUTLINE };
  tauriMock.handle("get_outline", ({ docId }) => {
    const o = outlines[docId as number];
    if (o instanceof Error) throw o;
    return o ?? { items: [], truncated: false };
  });
  const pages = opts.pages ?? [0, 1, 2, 3].map((i) => page(`p${i}`, 1, i));
  const onJump = vi.fn();
  const view = render(<OutlinePanel pages={pages} docs={docs} current={opts.current ?? 0} onJump={onJump} />);
  return { onJump, pages, ...view };
}

const row = (name: RegExp | string) => screen.getByRole("button", { name });

describe("OutlinePanel", () => {
  it("says so while loading, and when a document has no bookmarks", async () => {
    setup({ outlines: {} });
    expect(screen.getByRole("status")).toHaveTextContent("Reading the outline…");
    expect(await screen.findByText("No outline")).toBeInTheDocument();
  });

  it("shows the tree, collapsed where the file says, and goes to a bookmark's page", async () => {
    const { onJump } = setup();
    const tree = await screen.findByRole("tree", { name: "Bookmarks" });
    expect(within(tree).getAllByRole("treeitem").map((r) => r.textContent)).toEqual([
      "Intro1",
      "Background2",
      "Design3",
      "Elsewhere",
      "Untitled3",
    ]);
    expect(screen.queryByText("Detail")).not.toBeInTheDocument();

    await userEvent.click(row("Expand Design"));
    expect(row(/^Detail/)).toBeInTheDocument();
    await userEvent.click(row("Collapse Intro"));
    expect(screen.queryByText("Background")).not.toBeInTheDocument();
    expect(screen.getAllByRole("treeitem")[0]).toHaveAttribute("aria-expanded", "false");

    await userEvent.click(row(/^Intro/));
    expect(onJump).toHaveBeenCalledWith(0, 120);
    await userEvent.click(row(/^Detail/));
    expect(onJump).toHaveBeenLastCalledWith(3, null);
  });

  it("follows pages that moved, and disables bookmarks that go nowhere here", async () => {
    // Page 2 was moved to the front and page 1 was removed.
    const { onJump } = setup({ pages: [page("p2", 1, 2), page("p0", 1, 0), page("p3", 1, 3)] });
    await userEvent.click(await screen.findByRole("button", { name: /^Design/ }));
    expect(onJump).toHaveBeenCalledWith(0, null);
    expect(row(/^Intro/)).toHaveTextContent("Intro2");
    expect(row("Background")).toBeDisabled();
    expect(row("Background")).toHaveAttribute("title", "This page was removed from the document");
    expect(row("Elsewhere")).toBeDisabled();
    expect(row("Elsewhere")).toHaveAttribute("title", "This bookmark does not go to a page in this file");
    await userEvent.click(row("Elsewhere"));
    expect(onJump).toHaveBeenCalledTimes(1);
  });

  it("marks the section being read, or its shown parent", async () => {
    const { rerender, pages, onJump } = setup({ current: 1 });
    await screen.findByRole("tree");
    const selected = () => screen.getAllByRole("treeitem").filter((r) => r.getAttribute("aria-selected") === "true");
    expect(selected().map((r) => r.textContent)).toEqual(["Background2"]);
    await userEvent.click(row("Collapse Intro"));
    expect(selected().map((r) => r.textContent)).toEqual(["Intro1"]);
    // On page 4, "Detail" is current but hidden inside "Design".
    rerender(<OutlinePanel pages={pages} docs={docs} current={3} onJump={onJump} />);
    expect(selected().map((r) => r.textContent)).toEqual(["Design3"]);
  });

  it("groups by file when the tab holds several; skips files without bookmarks; shows errors", async () => {
    setup({
      pages: [page("a", 1, 0), page("b", 2, 0), page("c", 3, 0)],
      outlines: { 1: OUTLINE, 2: new Error("worker crashed") },
    });
    const report = await screen.findByRole("region", { name: "Outline of report.pdf" });
    expect(within(report).getByText("report.pdf")).toBeInTheDocument();
    expect(await screen.findByText("The outline could not be read: worker crashed")).toBeInTheDocument();
    expect(screen.getByRole("region", { name: "Outline of notes.pdf" })).toBeInTheDocument();
    expect(screen.queryByRole("region", { name: /doc3/ })).not.toBeInTheDocument();
  });

  it("keeps showing what loaded while another file is still being read", async () => {
    let finish: (o: Outline) => void = () => {};
    tauriMock.handle("get_outline", ({ docId }) =>
      docId === 1 ? OUTLINE : new Promise<Outline>((r) => (finish = r)),
    );
    render(
      <OutlinePanel pages={[page("a", 1, 0), page("b", 2, 0)]} docs={docs} current={0} onJump={() => {}} />,
    );
    expect(await screen.findByRole("tree", { name: "Bookmarks of report.pdf" })).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Reading the outline…");
    finish({ items: [], truncated: false });
    await vi.waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
  });

  it("says when bookmarks were left out, and shows a cached outline at once", async () => {
    const { unmount } = setup({ outlines: { 1: { ...OUTLINE, truncated: true } } });
    expect(await screen.findByText(/Some bookmarks are not shown/)).toBeInTheDocument();
    unmount();
    render(<OutlinePanel pages={[page("a", 1, 0)]} docs={docs} current={0} onJump={() => {}} />);
    expect(screen.getByRole("tree")).toBeInTheDocument();
    expect(tauriMock.calls("get_outline")).toHaveLength(1);
  });
});
