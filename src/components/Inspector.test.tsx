import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Inspector, LinkEditor } from "./Inspector";
import type { LooseText } from "../lib/types";
import { block, paragraph } from "../test/fixtures";

const base = () => ({
  fonts: ["Helvetica", "Times"],
  pageNumber: 3,
  block: null,
  linked: null,
  paragraph: null,
  loose: null,
  hasEdits: false,
  onUpdateBlock: vi.fn(),
  onEditBlock: vi.fn(),
  onEditParagraph: vi.fn(),
  onDelete: vi.fn(),
  onUnlink: vi.fn(),
  onLinkNext: null as (() => void) | null,
  onLinkPrev: null as (() => void) | null,
  onRemoveEverywhere: vi.fn(),
  onRestorePage: vi.fn(),
});

/** Types a value into a NumberField and commits it with Enter. */
async function commit(label: string, value: string) {
  const input = screen.getByLabelText(label);
  await userEvent.clear(input);
  if (value) await userEvent.type(input, value);
  fireEvent.keyDown(input, { key: "Enter" });
  fireEvent.blur(input);
}

describe("Inspector: nothing selected", () => {
  it("shows help, and a restore button only when the page has edits", async () => {
    const p = base();
    const { rerender } = render(<Inspector {...p} />);
    expect(screen.getByRole("heading", { name: "Edit" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Restore/ })).not.toBeInTheDocument();
    rerender(<Inspector {...p} hasEdits />);
    await userEvent.click(screen.getByRole("button", { name: "Restore page 3 to original" }));
    expect(p.onRestorePage).toHaveBeenCalled();
  });
});

describe("Inspector: text block", () => {
  it("updates style properties", async () => {
    const p = base();
    const b = block("b1", { font: { family: "Custom", bold: false, italic: false } });
    render(<Inspector {...p} block={b} />);
    expect(screen.getByRole("heading", { name: "Text box" })).toBeInTheDocument();
    expect(screen.getByRole("combobox")).toHaveValue("Custom");

    await userEvent.selectOptions(screen.getByRole("combobox"), "Times");
    expect(p.onUpdateBlock).toHaveBeenLastCalledWith({ ...b, font: { ...b.font, family: "Times" } });
    await userEvent.click(screen.getByRole("button", { name: "Bold" }));
    expect(p.onUpdateBlock).toHaveBeenLastCalledWith({ ...b, font: { ...b.font, bold: true } });
    await userEvent.click(screen.getByRole("button", { name: "Italic" }));
    expect(p.onUpdateBlock).toHaveBeenLastCalledWith({ ...b, font: { ...b.font, italic: true } });
    await userEvent.click(screen.getByRole("button", { name: "Align justify" }));
    expect(p.onUpdateBlock).toHaveBeenLastCalledWith({ ...b, align: "justify" });
    fireEvent.change(screen.getByLabelText("Color"), { target: { value: "#102030" } });
    expect(p.onUpdateBlock).toHaveBeenLastCalledWith({ ...b, color: [16, 32, 48] });
  });

  it("number fields commit clamped values on Enter/blur, not while typing", async () => {
    const p = base();
    const b = block("b1");
    render(<Inspector {...p} block={b} />);
    const size = screen.getByLabelText("Size");
    await userEvent.clear(size);
    await userEvent.type(size, "9999");
    expect(p.onUpdateBlock).not.toHaveBeenCalled();
    fireEvent.keyDown(size, { key: "Enter" });
    fireEvent.blur(size);
    expect(p.onUpdateBlock).toHaveBeenLastCalledWith({ ...b, size: 500 });

    await commit("Line height", "1.5");
    expect(p.onUpdateBlock).toHaveBeenLastCalledWith({ ...b, lineHeight: 1.5 });
    await commit("First-line indent", "12");
    expect(p.onUpdateBlock).toHaveBeenLastCalledWith({ ...b, indent: 12 });
    await commit("Letter width %", "90");
    expect(p.onUpdateBlock).toHaveBeenLastCalledWith({ ...b, hScale: 0.9 });
    await commit("X (pt)", "10");
    expect(p.onUpdateBlock).toHaveBeenLastCalledWith({ ...b, x: 10 });
    await commit("Baseline (pt)", "20");
    expect(p.onUpdateBlock).toHaveBeenLastCalledWith({ ...b, baseline: 20 });
  });

  it("wrap width: empty means no wrapping; unchanged values do not commit", async () => {
    const p = base();
    const b = block("b1", { width: 200 });
    render(<Inspector {...p} block={b} />);
    await commit("Wrap width (pt)", "");
    expect(p.onUpdateBlock).toHaveBeenLastCalledWith({ ...b, width: null });
    p.onUpdateBlock.mockClear();
    await commit("Size", "12");
    expect(p.onUpdateBlock).not.toHaveBeenCalled();
  });

  // KNOWN BUG: Number("") is 0, which clamps to the minimum, so clearing Size and
  // leaving the field shrinks the text to 1 pt. It should revert to the current size.
  // `it.fails` passes while the bug exists; when it is fixed this goes red: change it to `it`.
  it.fails("clearing Size reverts instead of setting 1 pt", () => {
    const p = base();
    render(<Inspector {...p} block={block("b1")} />);
    const size = screen.getByLabelText("Size") as HTMLInputElement;
    fireEvent.change(size, { target: { value: "" } });
    fireEvent.blur(size);
    expect(p.onUpdateBlock).not.toHaveBeenCalled();
  });

  it("text-box actions", async () => {
    const p = base();
    render(<Inspector {...p} block={block("b1")} />);
    await userEvent.click(screen.getByRole("button", { name: "Edit text" }));
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(p.onEditBlock).toHaveBeenCalled();
    expect(p.onDelete).toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Unlink" })).not.toBeInTheDocument();
  });

  it("linked paragraph: explains the link and offers unlink", async () => {
    const p = base();
    render(<Inspector {...p} block={block("b1")} linked={{ pageA: 2, pageB: 3 }} />);
    expect(screen.getByRole("heading", { name: "Linked paragraph · pages 2–3" })).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Unlink" }));
    expect(p.onUnlink).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Delete paragraph" })).toBeInTheDocument();
  });
});

describe("Inspector: paragraph", () => {
  it("shows source facts and wires actions", async () => {
    const p = { ...base(), onLinkNext: vi.fn(), onLinkPrev: null };
    const para = paragraph(1, { text: "x".repeat(400), mixedStyles: true, font: { family: "Times", bold: true, italic: true } });
    render(<Inspector {...p} paragraph={para} />);
    expect(screen.getByText(/^x+…$/)).toBeInTheDocument();
    expect(screen.getByText("ABCDEF+Helvetica")).toBeInTheDocument();
    expect(screen.getByText(/Times Bold Italic · 12.0 pt/)).toBeInTheDocument();
    expect(screen.getByText(/mixes fonts/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Edit text" }));
    expect(p.onEditParagraph).toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Continues on next page…" }));
    expect(p.onLinkNext).toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Continued from previous…" })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    expect(p.onDelete).toHaveBeenCalled();
  });

  it("unknown source font", () => {
    render(<Inspector {...base()} paragraph={paragraph(1, { sourceFont: "" })} />);
    expect(screen.getByText("unknown")).toBeInTheDocument();
  });
});

describe("Inspector: loose text", () => {
  const loose = (extra: Partial<LooseText> = {}): LooseText => ({
    objectIndex: 1,
    bounds: { x: 0, y: 0, width: 1, height: 1 },
    text: "DRAFT",
    rotated: true,
    transparent: true,
    watermarkMark: true,
    ...extra,
  });

  it("shows tags and can remove everywhere", async () => {
    const p = base();
    render(<Inspector {...p} loose={loose()} />);
    expect(screen.getByRole("heading", { name: "Watermark" })).toBeInTheDocument();
    expect(screen.getByText("tagged as watermark")).toBeInTheDocument();
    expect(screen.getByText("rotated")).toBeInTheDocument();
    expect(screen.getByText("transparent")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Remove on all pages…" }));
    expect(p.onRemoveEverywhere).toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Delete here" }));
    expect(p.onDelete).toHaveBeenCalled();
  });

  it("text-less objects cannot be removed everywhere", () => {
    render(<Inspector {...base()} loose={loose({ text: "", watermarkMark: false, rotated: false, transparent: false })} />);
    expect(screen.getByRole("heading", { name: "Text object" })).toBeInTheDocument();
    expect(screen.getByText("(no text)")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /all pages/ })).not.toBeInTheDocument();
  });
});

describe("LinkEditor", () => {
  const props = () => ({
    pageA: 4,
    pageB: 5,
    text: "Some text",
    split: { partA: "Some", partB: "text", linesA: 1, linesB: 1, overflow: 0 },
    capacityA: 1,
    capacityB: 3,
    busy: false,
    error: null as string | null,
    isNew: true,
    onChange: vi.fn(),
    onDone: vi.fn(),
    onCancel: vi.fn(),
  });

  it("shows the flow meter and applies", async () => {
    const p = props();
    render(<LinkEditor {...p} />);
    expect(screen.getByRole("textbox")).toHaveFocus();
    expect(screen.getByText("Page 4: 1 / 1 lines")).toBeInTheDocument();
    expect(screen.getByText("Page 5: 1 / 3 lines")).toBeInTheDocument();
    await userEvent.type(screen.getByRole("textbox"), "!");
    expect(p.onChange).toHaveBeenCalledWith("Some text!");
    await userEvent.click(screen.getByRole("button", { name: "Link and apply" }));
    expect(p.onDone).toHaveBeenCalled();
  });

  it("keyboard: Ctrl+Enter applies, Escape cancels", () => {
    const p = props();
    render(<LinkEditor {...p} isNew={false} />);
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter", ctrlKey: true });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(p.onDone).toHaveBeenCalledTimes(1);
    expect(p.onCancel).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("button", { name: "Apply" })).toBeInTheDocument();
  });

  it("blocks apply on overflow, while measuring, and before the first split", () => {
    const p = props();
    const { rerender } = render(<LinkEditor {...p} split={{ ...p.split, linesB: 5, overflow: 2 }} />);
    expect(screen.getByText(/2 lines too long/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Link and apply" })).toBeDisabled();
    rerender(<LinkEditor {...p} busy />);
    expect(screen.getByLabelText("Measuring")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Link and apply" })).toBeDisabled();
    rerender(<LinkEditor {...p} split={null} error="layout failed" />);
    expect(screen.getByText("Page 4: … / 1 lines")).toBeInTheDocument();
    expect(screen.getByText("layout failed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Link and apply" })).toBeDisabled();
    rerender(<LinkEditor {...p} split={{ ...p.split, overflow: 1 }} />);
    expect(screen.getByText(/1 line too long/)).toBeInTheDocument();
  });

  it("cancel button", async () => {
    const p = props();
    render(<LinkEditor {...p} capacityA={2} />);
    expect(screen.getByText(/keeps its 2 lines/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(p.onCancel).toHaveBeenCalled();
  });
});
