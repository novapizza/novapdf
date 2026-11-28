// Password-protected PDFs: the app asks for the password, opens the file with the real
// PDFium, and a save keeps the password (checked by opening the saved file in a fresh app).
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { FIXTURES, WORK_DIR } from "./paths";
import { expect, launchApp, statusBar, test, toast } from "./app";
// @ts-expect-error plain .mjs helper without types
import { PROTECTED } from "./fixtures/make-pdfs.mjs";

const password: string = PROTECTED.password;
const saved = (() => {
  mkdirSync(join(WORK_DIR, "saved"), { recursive: true });
  return join(WORK_DIR, "saved", `protected-${Date.now()}.pdf`);
})();

test.use({ appOptions: { grants: [FIXTURES.protected], saveTo: saved } });

test("asks for the password, opens the file, and a save keeps the password", async ({ app }) => {
  const { page } = app;
  await app.drop([FIXTURES.protected]);
  const prompt = page.getByRole("dialog", { name: "Enter password" });
  await expect(prompt).toContainText("protected.pdf");
  const box = prompt.getByLabel("Password", { exact: true });
  await expect(box).toBeFocused();

  await box.fill("not the password");
  await page.keyboard.press("Enter");
  await expect(prompt.getByRole("alert")).toHaveText("Wrong password. Try again.");
  await expect(box).toHaveValue("");

  await box.fill(password);
  await page.keyboard.press("Enter");
  await expect(prompt).toHaveCount(0);
  await expect(toast(page, "Opened protected.pdf (1 page)")).toBeVisible();
  await expect(page.getByRole("tab", { name: /protected\.pdf/ }).getByLabel("Password-protected")).toBeVisible();
  // Rendered and searchable: PDFium decrypted it.
  await expect.poll(() => page.getByAltText("Page 1").evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(100);
  await page.keyboard.press("Control+F");
  await page.getByRole("textbox", { name: "Find in document" }).fill(PROTECTED.heading);
  await expect(page.locator(".find-status")).toHaveText("1 of 1");
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: /Save as/ }).click();
  await expect(toast(page, `Saved ${saved}. It opens with the same password.`)).toBeVisible();

  // The saved file needs the same password.
  const fresh = await launchApp({ grants: [saved] });
  try {
    await fresh.drop([saved]);
    const again = fresh.page.getByRole("dialog", { name: "Enter password" });
    await expect(again).toBeVisible();
    await again.getByLabel("Password", { exact: true }).fill(password);
    await fresh.page.keyboard.press("Enter");
    await expect(statusBar(fresh.page)).toContainText("Page 1 of 1");
    await expect(fresh.page.getByAltText("Page 1")).toBeVisible();
  } finally {
    await fresh.close();
  }
});

test("Cancel leaves the file closed", async ({ app }) => {
  const { page } = app;
  await app.drop([FIXTURES.protected]);
  const prompt = page.getByRole("dialog", { name: "Enter password" });
  await expect(prompt).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(prompt).toHaveCount(0);
  await expect(page.getByRole("tablist", { name: "Open documents" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Library", exact: true })).toBeVisible();
});
