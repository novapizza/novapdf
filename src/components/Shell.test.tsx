import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ComingSoon, EmptyNote, Library, SECTION_INFO, Sidebar, paperName } from "./Shell";
import { Toasts } from "./Toasts";
import { Icon } from "./Icon";
import { doc } from "../test/fixtures";

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

describe("Sidebar", () => {
  const props = () => ({
    section: "library" as const,
    onNavigate: vi.fn(),
    sanitize: true,
    onSanitize: vi.fn(),
    theme: "system" as const,
    onTheme: vi.fn(),
  });

  it("marks the current section and navigates", async () => {
    const p = props();
    render(<Sidebar {...p} />);
    expect(screen.getByRole("button", { name: /Library & Recent/ })).toHaveAttribute("aria-current", "page");
    await userEvent.click(screen.getByRole("button", { name: /Page Organizer/ }));
    expect(p.onNavigate).toHaveBeenCalledWith("grid");
  });

  it("toggles sanitize and picks a theme", async () => {
    const p = props();
    render(<Sidebar {...p} />);
    await userEvent.click(screen.getByRole("checkbox"));
    expect(p.onSanitize).toHaveBeenCalledWith(false);
    expect(screen.getByRole("radio", { name: "Match system" })).toHaveAttribute("aria-checked", "true");
    await userEvent.click(screen.getByRole("radio", { name: "Dark" }));
    expect(p.onTheme).toHaveBeenCalledWith("dark");
  });
});

describe("ComingSoon / EmptyNote", () => {
  it("shows the section label", () => {
    render(<ComingSoon section="ocr" />);
    expect(screen.getByRole("heading", { name: SECTION_INFO.ocr.label })).toBeInTheDocument();
    expect(screen.getByText("Coming soon")).toBeInTheDocument();
  });

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
  });

  it("with nothing open: offers to open, tools that need a document are disabled", async () => {
    const h = handlers();
    render(<Library docs={[]} pageCount={0} dirty={false} {...h} />);
    expect(screen.getByText(/Nothing open/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Watermark/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Remove watermarks/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Compress/ })).toBeDisabled();
    await userEvent.click(screen.getByRole("button", { name: /Merge PDFs/ }));
    await userEvent.click(screen.getByRole("button", { name: /Open a PDF to start/ }));
    expect(h.onOpen).toHaveBeenCalledTimes(2);
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
    await userEvent.click(screen.getByRole("button", { name: /^Watermark/ }));
    expect(h.onWatermark).toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /Remove watermarks/ }));
    expect(h.onClean).toHaveBeenCalled();
    await userEvent.click(screen.getAllByRole("button", { name: "Organize" })[0]);
    expect(h.onShow).toHaveBeenCalledWith("grid");
    await userEvent.click(screen.getAllByRole("button", { name: "Open" })[1]);
    expect(h.onShow).toHaveBeenCalledWith("read");
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
    expect(screen.getByText("Failed")).toHaveClass("toast", "error");
    await userEvent.click(screen.getByText("Saved"));
    expect(onDismiss).toHaveBeenCalledWith(1);
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
