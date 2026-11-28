import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { FindBar } from "./FindBar";

const props = (over: Partial<Parameters<typeof FindBar>[0]> = {}) => ({
  query: "",
  onQuery: vi.fn(),
  count: 0,
  index: 0,
  searching: false,
  capped: false,
  onNext: vi.fn(),
  onPrev: vi.fn(),
  onClose: vi.fn(),
  request: 1,
  ...over,
});
const box = () => screen.getByRole("textbox", { name: "Find in document" });
const status = () => document.querySelector(".find-status")!;

describe("FindBar", () => {
  it("takes the focus when asked for, and again on the next request", () => {
    const p = props({ query: "soil" });
    const { rerender } = render(<FindBar {...p} />);
    expect(box()).toHaveFocus();
    (document.activeElement as HTMLElement).blur();
    rerender(<FindBar {...p} request={2} />);
    expect(box()).toHaveFocus();
  });

  it("says where the search stands", () => {
    const { rerender } = render(<FindBar {...props()} />);
    expect(status()).toHaveTextContent("");
    rerender(<FindBar {...props({ query: "soil", searching: true })} />);
    expect(status()).toHaveTextContent("Searching…");
    rerender(<FindBar {...props({ query: "soil" })} />);
    expect(status()).toHaveTextContent("No results");
    rerender(<FindBar {...props({ query: "soil", count: 12, index: 2, searching: true })} />);
    expect(status()).toHaveTextContent("3 of 12");
    rerender(<FindBar {...props({ query: "soil", count: 2000, index: 0, capped: true })} />);
    expect(status()).toHaveTextContent("1 of 2000+");
  });

  it("typing, Enter, Shift+Enter and Esc", async () => {
    const p = props({ query: "soi", count: 3 });
    render(<FindBar {...p} />);
    await userEvent.type(box(), "l");
    expect(p.onQuery).toHaveBeenCalledWith("soil");
    fireEvent.keyDown(box(), { key: "Enter" });
    expect(p.onNext).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(box(), { key: "Enter", shiftKey: true });
    expect(p.onPrev).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(box(), { key: "a" });
    fireEvent.keyDown(box(), { key: "Escape" });
    expect(p.onClose).toHaveBeenCalledTimes(1);
  });

  it("buttons step through matches and close; stepping is off with no match", async () => {
    const p = props({ query: "soil", count: 2 });
    const { rerender } = render(<FindBar {...p} />);
    await userEvent.click(screen.getByRole("button", { name: "Next match" }));
    await userEvent.click(screen.getByRole("button", { name: "Previous match" }));
    await userEvent.click(screen.getByRole("button", { name: "Close find" }));
    expect(p.onNext).toHaveBeenCalledTimes(1);
    expect(p.onPrev).toHaveBeenCalledTimes(1);
    expect(p.onClose).toHaveBeenCalledTimes(1);
    rerender(<FindBar {...p} count={0} />);
    expect(screen.getByRole("button", { name: "Next match" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Previous match" })).toBeDisabled();
  });
});
