// Comments in read view: add a note and a highlight, save a real PDF, then open it in
// a fresh app instance and check the comments are read back from the file.
import type { Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { FIXTURES, WORK_DIR } from "./paths";
import { type App, expect, launchApp, statusBar, test, toast } from "./app";

function outPath(name: string) {
  mkdirSync(join(WORK_DIR, "saved"), { recursive: true });
  return join(WORK_DIR, "saved", `${name}-${Date.now()}.pdf`);
}

const surface = (page: Page, n: number) => page.locator(`.page-surface[data-page="${n}"]`);
const tool = (page: Page, name: string) =>
  page.getByRole("navigation", { name: "Reader tools" }).getByRole("button", { name: new RegExp(`^${name}$`) });

async function openInReader(app: App, file: string, pages: number) {
  await app.drop([file]);
  await expect(statusBar(app.page)).toContainText(`of ${pages}`);
  await expect(tool(app.page, "Hand")).toHaveAttribute("aria-pressed", "true");
}

/** Viewport position of a point on page `n`, given in PDF points from its top-left. */
async function at(page: Page, n: number, x: number, y: number) {
  const box = (await surface(page, n).boundingBox())!;
  const s = box.width / 612;
  return { x: box.x + x * s, y: box.y + y * s };
}

/** Scrolls so `y` (PDF points from the top of page `n`) is in the middle of the view:
 *  raw mouse clicks do not scroll, and how much of a page fits depends on the window. */
async function show(page: Page, n: number, y: number) {
  const box = (await surface(page, n).boundingBox())!;
  const target = box.y + y * (box.width / 612);
  await page.locator(".doc-scroll").evaluate((el, t) => {
    const r = el.getBoundingClientRect();
    el.scrollTop += t - (r.top + r.height / 2);
  }, target);
}

async function marks(page: Page) {
  await page.getByRole("tab", { name: "Marks" }).click();
  return page.getByRole("list", { name: "Comments" });
}

test.describe("comments", () => {
  const saved = outPath("comments");
  test.use({ appOptions: { grants: [FIXTURES.sample], saveTo: saved } });

  test("adds a note and a highlight in read view, and the saved PDF has them", async ({ app }) => {
    const { page } = app;
    await openInReader(app, FIXTURES.sample, 3);

    // A sticky note in the empty lower half of page 1.
    await tool(page, "Note").click();
    await show(page, 1, 420);
    const spot = await at(page, 1, 120, 400);
    await page.mouse.click(spot.x, spot.y);
    const text = page.getByRole("textbox", { name: "Comment text" });
    await expect(text).toBeFocused();
    await text.fill("Checked by the end-to-end test");
    // Clicking elsewhere with the Note tool still on closes the card and keeps the
    // note; it does not open a second note.
    const elsewhere = await at(page, 1, 400, 300);
    await page.mouse.click(elsewhere.x, elsewhere.y);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(statusBar(page)).toContainText("Unsaved changes");

    // With the Note tool still on, clicking the note reopens it for editing.
    await page.getByTestId(/^annot-nova-note-/).click();
    await expect(text).toHaveValue("Checked by the end-to-end test");
    await text.fill("Checked by the end-to-end test, edited");
    await page.getByRole("dialog", { name: "Note" }).getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // Drag it 200 pt right and 60 pt down: its corner goes from (110, 390) to (310, 450).
    const grab = await at(page, 1, 120, 400);
    const drop = await at(page, 1, 320, 460);
    await page.mouse.move(grab.x, grab.y);
    await page.mouse.down();
    await page.mouse.move(drop.x, drop.y, { steps: 6 });
    await page.mouse.up();
    await expect(page.getByRole("dialog")).toHaveCount(0);

    // Highlight the heading (baseline 72 pt from the top, 20 pt type).
    await page.locator(".doc-scroll").evaluate((el) => (el.scrollTop = 0));
    await tool(page, "Highlight").click();
    const from = await at(page, 1, 74, 64);
    const to = await at(page, 1, 260, 64);
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 8 });
    await page.mouse.up();
    // A comment on the highlight marks it with a badge.
    const hlCard = page.getByRole("dialog", { name: "Highlight" });
    await expect(hlCard).toBeVisible();
    await expect(page.locator("[data-kind=badge]")).toHaveCount(0);
    await text.fill("Heading");
    await hlCard.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.locator("[data-kind=badge]")).toHaveCount(1);

    const list = await marks(page);
    await expect(list.getByRole("button")).toHaveCount(2);
    await expect(list.getByRole("button", { name: /edited/ })).toContainText("unsaved");

    await page.getByRole("button", { name: /Save as/ }).click();
    await expect(toast(page, `Saved ${saved}`)).toBeVisible();

    const fresh = await launchApp({ grants: [saved] });
    try {
      await openInReader(fresh, saved, 3);
      const again = await marks(fresh.page);
      const note = again.getByRole("button", { name: /Checked by the end-to-end test, edited/ });
      await expect(note).toBeVisible();
      await expect(note).not.toContainText("unsaved");
      await expect(again.getByRole("button", { name: /Highlight/ })).toBeVisible();
      // The highlight's comment is in the file, so it has its badge here too.
      await expect(fresh.page.locator("[data-kind=badge]")).toHaveCount(1);

      // The note is where it was dragged to.
      const hit = fresh.page.locator('[data-testid^="file-annot-"][title^="Checked by"]');
      const box = (await hit.boundingBox())!;
      const corner = await at(fresh.page, 1, 310, 450);
      expect(Math.abs(box.x - corner.x)).toBeLessThan(3);
      expect(Math.abs(box.y - corner.y)).toBeLessThan(3);

      // Comments read from the file open in a card, and can be deleted.
      await note.click();
      await expect(fresh.page.getByRole("textbox", { name: "Comment text" })).toHaveValue("Checked by the end-to-end test, edited");
      await fresh.page.getByRole("button", { name: "Delete comment" }).click();
      await expect(again.getByRole("button")).toHaveCount(1);
      await expect(statusBar(fresh.page)).toContainText("Unsaved changes");
    } finally {
      await fresh.close();
    }
  });
});
