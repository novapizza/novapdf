import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { FIXTURES, WORK_DIR } from "./paths";
import { expect, launchApp, statusBar, test, toast, showView } from "./app";

const saved = (() => {
  mkdirSync(join(WORK_DIR, "saved"), { recursive: true });
  return join(WORK_DIR, "saved", `watermarked-${Date.now()}.pdf`);
})();

test.use({ appOptions: { grants: [FIXTURES.sample, FIXTURES.specWatermark], saveTo: saved } });

async function scan(page: Page, text = "") {
  await page.getByRole("button", { name: /Remove watermarks/ }).click();
  const dialog = page.getByRole("dialog", { name: "Remove watermarks" });
  if (text) await dialog.getByRole("textbox").fill(text);
  await dialog.getByRole("button", { name: "Scan" }).click();
  return dialog;
}

test("finds tagged watermarks, removes them, stamps a new one, and the saved file has only the new one", async ({ app }) => {
  const { page } = app;
  await app.drop([FIXTURES.sample]);
  await expect(statusBar(page)).toContainText("of 3");

  // The fixture tags "SAMPLE" as /Artifact /Watermark on every page.
  const dialog = await scan(page);
  await expect(dialog).toContainText("Found 3 items on 3 pages: 3 tagged, 0 annotations, 0 matching text.");
  await dialog.getByRole("button", { name: "Remove 3" }).click();
  await expect(toast(page, "Removed 3 watermark items from 3 pages")).toBeVisible();

  // Watermark dialog: live PDFium preview, then apply.
  await page.getByRole("button", { name: /^Watermark$/ }).click();
  const studio = page.getByRole("dialog", { name: "Watermark", exact: true });
  await studio.getByRole("button", { name: "DRAFT", exact: true }).click();
  const preview = studio.getByAltText("Watermark preview");
  await expect(preview).toBeVisible();
  await expect.poll(() => preview.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(420);
  await studio.getByRole("button", { name: /Apply to all pages/ }).click();
  await expect(page.getByRole("button", { name: /^Watermark$/ })).toHaveClass(/active/);

  await page.getByRole("button", { name: /Save as/ }).click();
  await expect(toast(page, `Saved ${saved}`)).toBeVisible();

  const fresh = await launchApp({ grants: [saved] });
  try {
    await fresh.drop([saved]);
    await expect(statusBar(fresh.page)).toContainText("of 3");
    const d = await scan(fresh.page, "SAMPLE");
    // Only the new stamp is tagged; the old one is gone (no matching text either).
    await expect(d).toContainText("Found 3 items on 3 pages: 3 tagged, 0 annotations, 0 matching text.");
    // And it is the DRAFT stamp: the editor shows it as tagged watermark text.
    await d.getByRole("button", { name: "Close" }).click();
    await showView(fresh.page, "Edit");
    await fresh.page.locator('.page-surface[data-page="1"] .ov-loose').first().click();
    await expect(fresh.page.locator(".inspector .quote")).toHaveText("DRAFT");
    await expect(fresh.page.getByText("tagged as watermark")).toBeVisible();
  } finally {
    await fresh.close();
  }
});

test("untagged watermark text can be found by its text", async ({ app }) => {
  const { page } = app;
  await app.drop([FIXTURES.sample]);
  await expect(statusBar(page)).toContainText("of 3");
  // Body text never matches: "the" appears on every page but is upright and opaque.
  const dialog = await scan(page, "the");
  await expect(dialog).toContainText("3 tagged, 0 annotations, 0 matching text.");
});

// KNOWN BUG (worker/extract.rs has_watermark_mark, worker/edit.rs draw_watermark):
// /Artifact /Subtype is a *name* in the PDF spec (Acrobat writes /Watermark), but the
// app only reads it as a string, and writes it as the string (Watermark). So tagged
// watermarks from other tools are not found. `test.fail` passes while the bug exists;
// when it is fixed this goes red: change it to `test`.
test.fail("finds watermarks tagged the way the PDF spec and Acrobat do", async ({ app }) => {
  const { page } = app;
  await app.drop([FIXTURES.specWatermark]);
  await expect(statusBar(page)).toContainText("Page 1 of 1");
  const dialog = await scan(page);
  await expect(dialog).toContainText("Found 1 item on 1 page: 1 tagged", { timeout: 8_000 });
});
