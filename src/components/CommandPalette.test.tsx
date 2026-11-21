import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { type Command, CommandPalette } from "./CommandPalette";

const cmds = (): Command[] => [
  { id: "soon", title: "Redact content", description: "Not available yet", icon: "redact", tag: "Soon" },
  { id: "open", title: "Open PDF", description: "Replace the workspace", icon: "folderOpen", tag: "Action", shortcut: "Ctrl O", run: vi.fn() },
  { id: "save", title: "Save as new PDF", description: "Write a new file", icon: "save", tag: "Action", shortcut: "Ctrl S", run: vi.fn() },
  { id: "wm", title: "Watermark Studio", description: "Text stamp", icon: "stamp", tag: "Tool", run: vi.fn() },
];

const options = () => screen.getAllByRole("option");

describe("CommandPalette", () => {
  it("lists runnable commands first and shows the count", () => {
    render(<CommandPalette commands={cmds()} onClose={vi.fn()} />);
    expect(options().map((o) => o.textContent)).toEqual([
      expect.stringContaining("Open PDF"),
      expect.stringContaining("Save as new PDF"),
      expect.stringContaining("Watermark Studio"),
      expect.stringContaining("Redact content"),
    ]);
    expect(screen.getByText(/\(4\)/)).toBeInTheDocument();
    expect(options()[3]).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByRole("textbox", { name: "Search commands" })).toHaveFocus();
  });

  it("filters by title or description and highlights the match", async () => {
    render(<CommandPalette commands={cmds()} onClose={vi.fn()} />);
    await userEvent.type(screen.getByRole("textbox"), "new pdf");
    expect(options()).toHaveLength(1);
    expect(within(options()[0]).getByText("new PDF", { selector: "mark" })).toBeInTheDocument();
    await userEvent.clear(screen.getByRole("textbox"));
    await userEvent.type(screen.getByRole("textbox"), "stamp");
    expect(options()[0]).toHaveTextContent("Watermark Studio"); // matched on description
    await userEvent.type(screen.getByRole("textbox"), "zzz");
    expect(screen.getByText("No matching commands.")).toBeInTheDocument();
  });

  it("navigates with arrows and runs with Enter, closing first", async () => {
    const list = cmds();
    const onClose = vi.fn();
    render(<CommandPalette commands={list} onClose={onClose} />);
    const box = screen.getByRole("textbox");
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.keyDown(box, { key: "ArrowDown" }); // clamps at the end
    fireEvent.keyDown(box, { key: "ArrowUp" });
    expect(options()[2]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onClose).toHaveBeenCalled();
    expect(list[3].run).toHaveBeenCalled();
  });

  it("ArrowUp stops at the first item", () => {
    render(<CommandPalette commands={cmds()} onClose={vi.fn()} />);
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "ArrowUp" });
    expect(options()[0]).toHaveAttribute("aria-selected", "true");
  });

  it("does not run disabled commands", async () => {
    const onClose = vi.fn();
    render(<CommandPalette commands={cmds()} onClose={onClose} />);
    await userEvent.click(screen.getByText("Redact content"));
    expect(onClose).not.toHaveBeenCalled();
    // The click also hovered it, so it is active; Enter must not run it either.
    expect(options()[3]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("runs on click and highlights on hover", async () => {
    const list = cmds();
    render(<CommandPalette commands={list} onClose={vi.fn()} />);
    fireEvent.mouseMove(screen.getByText("Save as new PDF"));
    expect(options()[1]).toHaveAttribute("aria-selected", "true");
    expect(within(options()[1]).getByText("Return")).toBeInTheDocument();
    expect(within(options()[0]).getByText("Ctrl O")).toBeInTheDocument();
    await userEvent.click(screen.getByText("Save as new PDF"));
    expect(list[2].run).toHaveBeenCalled();
  });

  it("closes on Escape, Ctrl+K and a backdrop click (not a click inside)", async () => {
    const onClose = vi.fn();
    const { container } = render(<CommandPalette commands={cmds()} onClose={onClose} />);
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "k", ctrlKey: true });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "x" });
    fireEvent.mouseDown(screen.getByRole("dialog"));
    expect(onClose).toHaveBeenCalledTimes(2);
    fireEvent.mouseDown(container.querySelector(".modal-backdrop")!);
    expect(onClose).toHaveBeenCalledTimes(3);
  });
});
