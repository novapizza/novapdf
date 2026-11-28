import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { PasswordDialog } from "./PasswordDialog";

const props = (over: Partial<Parameters<typeof PasswordDialog>[0]> = {}) => ({
  fileName: "budget.pdf",
  error: null,
  busy: false,
  waiting: 0,
  onSubmit: vi.fn(),
  onCancel: vi.fn(),
  ...over,
});
const box = () => screen.getByLabelText("Password") as HTMLInputElement;
const open = () => screen.getByRole("button", { name: /Open/ });

describe("PasswordDialog", () => {
  it("names the file, starts focused and hidden, and sends what was typed", async () => {
    const p = props();
    render(<PasswordDialog {...p} />);
    expect(screen.getByRole("dialog", { name: "Enter password" })).toHaveTextContent("budget.pdf is protected with a password.");
    expect(box()).toHaveFocus();
    expect(box()).toHaveAttribute("type", "password");
    // Nothing to send yet.
    expect(open()).toBeDisabled();
    await userEvent.type(box(), "s3cret");
    await userEvent.click(open());
    expect(p.onSubmit).toHaveBeenCalledWith("s3cret");
  });

  it("Enter sends; an empty box sends nothing", async () => {
    const p = props();
    render(<PasswordDialog {...p} />);
    fireEvent.submit(box().closest("form")!);
    expect(p.onSubmit).not.toHaveBeenCalled();
    await userEvent.type(box(), "pw{Enter}");
    expect(p.onSubmit).toHaveBeenCalledWith("pw");
  });

  it("can show the password", async () => {
    render(<PasswordDialog {...props()} />);
    await userEvent.click(screen.getByRole("checkbox", { name: "Show password" }));
    expect(box()).toHaveAttribute("type", "text");
  });

  it("a wrong password is reported, and the box is emptied and focused again", async () => {
    const p = props();
    const { rerender } = render(<PasswordDialog {...p} />);
    await userEvent.type(box(), "nope");
    rerender(<PasswordDialog {...p} error="Wrong password. Try again." />);
    expect(screen.getByRole("alert")).toHaveTextContent("Wrong password. Try again.");
    expect(box()).toHaveValue("");
    expect(box()).toHaveFocus();
    expect(box()).toHaveAttribute("aria-invalid", "true");
  });

  it("while busy nothing can be sent or cancelled", async () => {
    const p = props({ busy: true });
    render(<PasswordDialog {...p} />);
    expect(box()).toBeDisabled();
    expect(open()).toBeDisabled();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
    fireEvent.submit(box().closest("form")!);
    expect(p.onSubmit).not.toHaveBeenCalled();
  });

  it("Cancel and Esc give up; other keys do not", async () => {
    const p = props();
    render(<PasswordDialog {...p} />);
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.keyDown(box(), { key: "a" });
    fireEvent.keyDown(box(), { key: "Escape" });
    expect(p.onCancel).toHaveBeenCalledTimes(2);
  });

  it("says how many more files are waiting", () => {
    const { rerender } = render(<PasswordDialog {...props({ waiting: 1 })} />);
    expect(screen.getByText("1 more file waiting")).toBeInTheDocument();
    rerender(<PasswordDialog {...props({ waiting: 3 })} />);
    expect(screen.getByText("3 more files waiting")).toBeInTheDocument();
  });
});
