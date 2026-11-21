import type { Page } from "@playwright/test";
import { basename } from "node:path";
import { FIXTURES } from "./paths";
import { expect, statusBar, test, toast } from "./app";

test.use({ appOptions: { grants: [FIXTURES.sample, FIXTURES.second] } });

const thumb = (page: Page, n: number) => page.getByLabel(`Page ${n}`, { exact: true });

async function openOrganizer(app: { page: Page; drop(p: string[]): Promise<void> }, files: string[], pages: number) {
  // One at a time: a drop that arrives while another file is still opening replaces
  // it instead of merging (known race, see TESTING.md).
  for (const f of files) {
    await app.drop([f]);
    await expect(toast(app.page, `Opened ${basename(f)}`)).toBeVisible();
  }
  await expect(statusBar(app.page)).toContainText(`of ${pages}`);
  await app.page.getByRole("button", { name: /Page Organizer/ }).click();
  await expect(app.page.getByRole("navigation", { name: "Selection tools" })).toBeVisible();
}

test("thumbnails are real renders; rotate, delete and undo", async ({ app }) => {
  const { page } = app;
  await openOrganizer(app, [FIXTURES.sample], 3);

  for (let n = 1; n <= 3; n++) {
    const img = thumb(page, n).locator("img");
    await expect(img).toBeVisible();
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(100);
  }

  // The reader's current page comes in selected; Shift-click extends the range.
  await expect(statusBar(page)).toContainText("Selection: 1 page");
  await thumb(page, 2).click({ modifiers: ["Shift"] });
  await expect(statusBar(page)).toContainText("Selection: 2 pages");

  await page.keyboard.press("r");
  await expect(page.getByText("90° CW")).toHaveCount(2);
  await expect(statusBar(page)).toContainText("Unsaved changes");
  // Rotated thumbnails are re-rendered landscape.
  await expect(thumb(page, 1).getByText("Letter Landscape")).toBeVisible();

  await page.keyboard.press("Delete");
  await expect(statusBar(page)).toContainText("1 page");

  await page.keyboard.press("Control+z");
  await expect(statusBar(page)).toContainText("3 pages");
  await page.keyboard.press("Control+z");
  await expect(page.getByText("90° CW")).toHaveCount(0);
  await expect(statusBar(page)).not.toContainText("Unsaved changes");
  await page.keyboard.press("Control+y");
  await expect(page.getByText("90° CW")).toHaveCount(2);
});

test("select all, deselect, and open a page in the editor", async ({ app }) => {
  const { page } = app;
  await openOrganizer(app, [FIXTURES.sample], 3);
  await page.keyboard.press("Control+a");
  await expect(statusBar(page)).toContainText("Selection: 3 pages");
  await page.keyboard.press("Escape");
  await expect(statusBar(page)).toContainText("Selection: none");
  await thumb(page, 3).dblclick();
  await expect(page.getByRole("radiogroup", { name: "Edit tool" })).toBeVisible();
  await expect(statusBar(page)).toContainText("Page 3 of 3");
});

test("drag a page from the second file to the front", async ({ app }) => {
  const { page } = app;
  await openOrganizer(app, [FIXTURES.sample, FIXTURES.second], 5);
  await page.keyboard.press("Escape");
  await expect(thumb(page, 1).locator(".thumb-file")).toHaveText("sample.pdf");
  await expect(thumb(page, 5).locator(".thumb-file")).toHaveText("second.pdf");

  // dnd-kit starts a drag after 6 px of pointer movement.
  const from = (await thumb(page, 5).boundingBox())!;
  const to = (await thumb(page, 1).boundingBox())!;
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + from.width / 2 + 10, from.y + from.height / 2, { steps: 3 });
  await page.mouse.move(to.x + to.width / 3, to.y + to.height / 2, { steps: 15 });
  await page.mouse.up();

  await expect(thumb(page, 1).locator(".thumb-file")).toHaveText("second.pdf");
  await expect(thumb(page, 1).getByText("A4 Portrait")).toBeVisible();
  await expect(thumb(page, 2).locator(".thumb-file")).toHaveText("sample.pdf");
  await page.keyboard.press("Control+z");
  await expect(thumb(page, 1).locator(".thumb-file")).toHaveText("sample.pdf");
});

test("command palette drives the organizer", async ({ app }) => {
  const { page } = app;
  await openOrganizer(app, [FIXTURES.sample], 3);
  await page.keyboard.press("Control+k");
  await page.getByRole("textbox", { name: "Search commands" }).fill("rotate selected pages left");
  await page.keyboard.press("Enter");
  await expect(page.getByText("270° CW")).toHaveCount(1);
});
