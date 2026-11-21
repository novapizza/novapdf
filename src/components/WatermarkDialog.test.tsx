import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { WatermarkDialog } from "./WatermarkDialog";
import type { Watermark } from "../lib/types";
import { tauriMock } from "../test/tauri";
import { JPEG_BYTES, block, page } from "../test/fixtures";

const props = (extra: Partial<Parameters<typeof WatermarkDialog>[0]> = {}) => ({
  current: null,
  fonts: ["Helvetica", "Times", "Courier"],
  previewPage: null,
  pageCount: 5,
  onApply: vi.fn(),
  onClose: vi.fn(),
  ...extra,
});

const EXISTING: Watermark = {
  text: "OLD",
  font: { family: "Fancy Font", bold: false, italic: true },
  size: 30,
  color: [1, 2, 3],
  opacity: 0.5,
  angle: 10,
};

describe("WatermarkDialog", () => {
  it("starts from the default stamp and applies the edited settings", async () => {
    const p = props();
    render(<WatermarkDialog {...p} />);
    const input = screen.getByPlaceholderText("Watermark text");
    expect(input).toHaveValue("CONFIDENTIAL");
    expect(screen.getByText("Scope: all pages (1–5)", { exact: false })).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: "DRAFT" }));
    await userEvent.click(screen.getByRole("button", { name: "Italic" }));
    await userEvent.click(screen.getByRole("button", { name: "Bold" })); // default is bold → off
    await userEvent.click(screen.getByRole("button", { name: "Archive blue" }));
    await userEvent.selectOptions(screen.getByRole("combobox"), "Times");
    const [size, angle, opacity] = screen.getAllByRole("slider");
    fireEvent.change(size, { target: { value: "100" } });
    fireEvent.change(angle, { target: { value: "-30" } });
    fireEvent.change(opacity, { target: { value: "50" } });
    expect(screen.getByText("100pt")).toBeInTheDocument();

    await userEvent.click(screen.getByRole("button", { name: /Apply to all pages/ }));
    expect(p.onApply).toHaveBeenCalledWith({
      text: "DRAFT",
      font: { family: "Times", bold: false, italic: true },
      size: 100,
      color: [9, 76, 178],
      opacity: 0.5,
      angle: -30,
    });
  });

  it("cannot apply empty text", async () => {
    render(<WatermarkDialog {...props()} />);
    await userEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(screen.getByRole("button", { name: /Apply to all pages/ })).toBeDisabled();
    await userEvent.type(screen.getByPlaceholderText("Watermark text"), "   ");
    expect(screen.getByRole("button", { name: /Apply to all pages/ })).toBeDisabled();
  });

  it("edits an existing watermark: keeps its unknown font, custom colour, and can remove it", async () => {
    const p = props({ current: EXISTING });
    render(<WatermarkDialog {...p} />);
    expect(screen.getByRole("combobox")).toHaveValue("Fancy Font");
    expect(screen.getByLabelText("Custom colour")).toHaveValue("#010203");
    fireEvent.change(screen.getByLabelText("Custom colour"), { target: { value: "#ff8000" } });
    await userEvent.click(screen.getByRole("button", { name: /Apply/ }));
    expect(p.onApply).toHaveBeenLastCalledWith(expect.objectContaining({ color: [255, 128, 0] }));
    await userEvent.click(screen.getByRole("button", { name: /Remove watermark/ }));
    expect(p.onApply).toHaveBeenLastCalledWith(null);
  });

  it("renders a live PDFium preview of the selected page", async () => {
    tauriMock.handle("render_page", () => JPEG_BYTES);
    const pg = page("p1", 4, 2, { rotation: 90, edits: { removedObjects: [], removedAnnots: [], blocks: [block("b")] } });
    render(<WatermarkDialog {...props({ previewPage: pg })} />);
    expect(await screen.findByAltText("Watermark preview")).toHaveAttribute("src", expect.stringMatching(/^blob:/));
    const args = tauriMock.calls("render_page")[0].args as Record<string, unknown>;
    expect(args).toMatchObject({ docId: 4, pageIndex: 2, rotation: 90, width: 420, priority: "view" });
    expect(args.watermark).toMatchObject({ text: "CONFIDENTIAL" });
  });

  it("shows a preview error", async () => {
    tauriMock.handle("render_page", () => {
      throw "engine restarted";
    });
    render(<WatermarkDialog {...props({ previewPage: page("p1", 9, 0) })} />);
    expect(await screen.findByText("engine restarted")).toBeInTheDocument();
  });

  it("closes with Escape, the X, Cancel and the backdrop", async () => {
    const p = props();
    const { container } = render(<WatermarkDialog {...p} />);
    fireEvent.keyDown(window, { key: "Escape" });
    fireEvent.keyDown(window, { key: "a" });
    await userEvent.click(screen.getByRole("button", { name: "Close" }));
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.mouseDown(screen.getByRole("dialog"));
    fireEvent.mouseDown(container.querySelector(".modal-backdrop")!);
    expect(p.onClose).toHaveBeenCalledTimes(4);
  });
});
