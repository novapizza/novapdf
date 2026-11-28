import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { EmptyNote, Library, ModeSwitch, SettingsMenu, paperName } from "./Shell";
import { Toasts } from "./Toasts";
import { Icon } from "./Icon";
import { doc } from "../test/fixtures";
import type { RecentView } from "../lib/types";

describe("paperName", () => {
  it.each([
    [595, 842, "A4 Portrait"],
    [842, 595, "A4 Landscape"],
    [612, 792, "Letter Portrait"],
    [612, 1008, "Legal Portrait"],
    [420, 595, "A5 Portrait"],
    [842, 1191, "A3 Portrait"],
    [597, 840, "A4 Portrait"], // within tolerance
    [500, 500.4, "500×500 pt Portrait"],
    [700, 300, "700×300 pt Landscape"],
  ])("%s × %s → %s", (w, h, name) => {
    expect(paperName(w, h)).toBe(name);
  });
});

describe("ModeSwitch", () => {
  it("marks the view in use and asks for another", async () => {
    const onNavigate = vi.fn();
    const { rerender } = render(<ModeSwitch section="read" onNavigate={onNavigate} />);
    const view = screen.getByRole("radiogroup", { name: "View" });
    expect(within(view).getByRole("radio", { name: "Read" })).toHaveAttribute("aria-checked", "true");
    expect(within(view).getByRole("radio", { name: "Organize" })).toHaveAttribute("aria-checked", "false");
    await userEvent.click(within(view).getByRole("radio", { name: "Organize" }));
    expect(onNavigate).toHaveBeenCalledWith("grid");
    await userEvent.click(within(view).getByRole("radio", { name: "Edit" }));
    expect(onNavigate).toHaveBeenCalledWith("edit");
    // In the Library no view is checked.
    rerender(<ModeSwitch section="library" onNavigate={onNavigate} />);
    expect(within(view).queryByRole("radio", { checked: true })).not.toBeInTheDocument();
  });
});

describe("SettingsMenu", () => {
  const props = () => ({
    sanitize: true,
    onSanitize: vi.fn(),
    recentEnabled: true,
    onRecentEnabled: vi.fn(),
    theme: "system" as const,
    onTheme: vi.fn(),
  });
  const sanitize = () => screen.getByRole("checkbox", { name: "Sanitize on save" });
  const button = () => screen.getByRole("button", { name: "Settings" });
  const popover = () => screen.queryByRole("dialog", { name: "Settings" });

  it("opens from the button: sanitize switch and theme", async () => {
    const p = props();
    render(<SettingsMenu {...p} />);
    expect(popover()).not.toBeInTheDocument();
    expect(button()).toHaveAttribute("aria-expanded", "false");
    await userEvent.click(button());
    expect(button()).toHaveAttribute("aria-expanded", "true");
    expect(sanitize()).toBeChecked();
    await userEvent.click(sanitize());
    expect(p.onSanitize).toHaveBeenCalledWith(false);
    const remember = screen.getByRole("checkbox", { name: "Remember recent files" });
    expect(remember).toBeChecked();
    await userEvent.click(remember);
    expect(p.onRecentEnabled).toHaveBeenCalledWith(false);
    expect(screen.getByRole("radio", { name: "System" })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(screen.getByRole("radio", { name: "Dark" }));
    expect(p.onTheme).toHaveBeenCalledWith("dark");
    // Using a control inside does not close it; the button does.
    expect(popover()).toBeInTheDocument();
    await userEvent.click(button());
    expect(popover()).not.toBeInTheDocument();
  });

  it("closes on Esc and on a click outside", async () => {
    render(
      <div>
        <SettingsMenu {...props()} />
        <p>elsewhere</p>
      </div>,
    );
    await userEvent.click(button());
    fireEvent.keyDown(document.body, { key: "a" });
    expect(popover()).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: "Escape" });
    expect(popover()).not.toBeInTheDocument();
    await userEvent.click(button());
    await userEvent.click(screen.getByText("elsewhere"));
    expect(popover()).not.toBeInTheDocument();
  });
});

describe("EmptyNote", () => {
  it("EmptyNote renders optional body", () => {
    const { rerender } = render(<EmptyNote icon="clock" title="Nothing" />);
    expect(screen.getByText("Nothing")).toBeInTheDocument();
    rerender(<EmptyNote icon="clock" title="Nothing">More</EmptyNote>);
    expect(screen.getByText("More")).toBeInTheDocument();
  });
});

describe("Library", () => {
  const handlers = () => ({
    onOpen: vi.fn(),
    onAdd: vi.fn(),
    onShow: vi.fn(),
    onWatermark: vi.fn(),
    onClean: vi.fn(),
    onOpenRecent: vi.fn(),
    onRemoveRecent: vi.fn(),
    onClearRecent: vi.fn(),
    recent: null as RecentView | null,
  });

  it("with nothing open: offers to open, tools that need a document are disabled", async () => {
    const h = handlers();
    render(<Library docs={[]} pageCount={0} dirty={false} {...h} />);
    expect(screen.getByText(/Nothing open/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Add watermark/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Remove watermarks/ })).toBeDisabled();
    // Nothing unbuilt is offered.
    expect(screen.queryByText(/coming soon/i)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: /Open a PDF to start/ }));
    expect(h.onOpen).toHaveBeenCalledTimes(1);
    // Merging needs nothing open: the picked files become one new document.
    await userEvent.click(screen.getByRole("button", { name: /Merge PDFs/ }));
    expect(h.onAdd).toHaveBeenCalledTimes(1);
  });

  it("with documents: lists them and wires the actions", async () => {
    const h = handlers();
    render(<Library docs={[doc(1, 3, "a.pdf"), doc(2, 1, "b.pdf")]} pageCount={4} dirty {...h} />);
    expect(screen.getByText("2 open", { exact: false })).toBeInTheDocument();
    expect(screen.getByText("4 pages from 2 files")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "a.pdf" })).toBeInTheDocument();
    expect(screen.getByText("3 pages")).toBeInTheDocument();
    expect(screen.getByText("1 page")).toBeInTheDocument();
    expect(screen.getAllByText("Unsaved")).toHaveLength(2);
    expect(screen.getAllByText("Letter Portrait")).toHaveLength(2);

    await userEvent.click(screen.getByRole("button", { name: /Merge PDFs/ }));
    await userEvent.click(screen.getByRole("button", { name: /Append PDFs/ }));
    expect(h.onAdd).toHaveBeenCalledTimes(2);
    await userEvent.click(screen.getByRole("button", { name: /Add watermark/ }));
    expect(h.onWatermark).toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /Remove watermarks/ }));
    expect(h.onClean).toHaveBeenCalled();
    await userEvent.click(screen.getAllByRole("button", { name: "Organize" })[0]);
    expect(h.onShow).toHaveBeenCalledWith("grid");
    await userEvent.click(screen.getAllByRole("button", { name: "Open" })[1]);
    expect(h.onShow).toHaveBeenCalledWith("read");
  });

  describe("recent files", () => {
    const item = (id: number, fileName: string, openedAt = Date.now()) => ({
      id,
      fileName,
      folder: "C:\\Users\\me\\Documents",
      openedAt,
    });
    const list = () => screen.getByRole("list");

    it("lists them newest first; a click opens one, the cross removes one", async () => {
      const h = handlers();
      const recent: RecentView = { enabled: true, items: [item(7, "report.pdf"), item(3, "contract.pdf", Date.now() - 86_400_000)] };
      render(<Library docs={[]} pageCount={0} dirty={false} {...h} recent={recent} />);
      expect(screen.getByRole("heading", { name: "Recent" })).toBeInTheDocument();
      const rows = within(list()).getAllByRole("listitem");
      expect(rows[0]).toHaveTextContent("report.pdf");
      expect(rows[0]).toHaveTextContent("C:\\Users\\me\\Documents");
      expect(rows[0]).toHaveTextContent("Today");
      expect(rows[1]).toHaveTextContent("Yesterday");

      await userEvent.click(within(rows[1]).getByRole("button", { name: /^contract\.pdf/ }));
      expect(h.onOpenRecent).toHaveBeenCalledWith(3);
      await userEvent.click(within(rows[0]).getByRole("button", { name: "Remove report.pdf from the list" }));
      expect(h.onRemoveRecent).toHaveBeenCalledWith(7);
      await userEvent.click(screen.getByRole("button", { name: "Clear list" }));
      expect(h.onClearRecent).toHaveBeenCalledTimes(1);
    });

    it("an empty list says what will appear; no Clear button", () => {
      render(<Library docs={[]} pageCount={0} dirty={false} {...handlers()} recent={{ enabled: true, items: [] }} />);
      expect(screen.getByText("No recent files")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: "Clear list" })).not.toBeInTheDocument();
    });

    it("turned off, or not loaded yet, the section is not shown", () => {
      const { rerender } = render(<Library docs={[]} pageCount={0} dirty={false} {...handlers()} recent={{ enabled: false, items: [] }} />);
      expect(screen.queryByRole("heading", { name: "Recent" })).not.toBeInTheDocument();
      rerender(<Library docs={[]} pageCount={0} dirty={false} {...handlers()} recent={null} />);
      expect(screen.queryByRole("heading", { name: "Recent" })).not.toBeInTheDocument();
    });
  });

  it("singular wording for one file and page", () => {
    render(<Library docs={[doc(1, 1)]} pageCount={1} dirty={false} {...handlers()} />);
    expect(screen.getByText("1 page from 1 file")).toBeInTheDocument();
  });
});

describe("Toasts", () => {
  it("shows messages by kind and dismisses on click", async () => {
    const onDismiss = vi.fn();
    render(
      <Toasts
        toasts={[
          { id: 1, message: "Saved", kind: "info" },
          { id: 2, message: "Failed", kind: "error" },
        ]}
        onDismiss={onDismiss}
      />,
    );
    expect(screen.getByRole("alert")).toHaveClass("toast", "error");
    expect(screen.getByRole("alert")).toHaveTextContent("Failed");
    await userEvent.click(screen.getByText("Saved"));
    expect(onDismiss).toHaveBeenCalledWith(1);
    // The close button is how the keyboard dismisses one.
    await userEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Dismiss" }));
    expect(onDismiss).toHaveBeenLastCalledWith(2);
  });
});

describe("Icon", () => {
  it("renders an aria-hidden svg with one path per segment", () => {
    const { container } = render(<Icon name="save" size={20} className="x" />);
    const svg = container.querySelector("svg")!;
    expect(svg).toHaveAttribute("aria-hidden", "true");
    expect(svg).toHaveAttribute("width", "20");
    expect(svg.querySelectorAll("path").length).toBe(3);
  });
});
