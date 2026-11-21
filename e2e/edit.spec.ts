// Editing round trips: edit in the app, save a real PDF, open it in a fresh app
// instance and check what PDFium reads back.
import type { Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { FIXTURES, WORK_DIR } from "./paths";
import { type App, expect, launchApp, statusBar, test, toast } from "./app";
// @ts-expect-error plain .mjs helper without types
import { SAMPLE } from "./fixtures/make-pdfs.mjs";

const PARA1: string = (SAMPLE.para1 as string[]).join(" ");

function outPath(name: string) {
  mkdirSync(join(WORK_DIR, "saved"), { recursive: true });
  return join(WORK_DIR, "saved", `${name}-${Date.now()}.pdf`);
}

async function openInEditor(app: App, file: string, pages: number) {
  await app.drop([file]);
  await expect(statusBar(app.page)).toContainText(`of ${pages}`);
  await app.page.getByRole("button", { name: /Advanced Editor/ }).click();
  await expect(app.page.getByRole("radiogroup", { name: "Edit tool" })).toBeVisible();
}

const surface = (page: Page, n: number) => page.locator(`.page-surface[data-page="${n}"]`);
const inlineEditor = (page: Page) => page.locator("textarea.inline-editor");

/** Texts of every editable paragraph on a page, as the app's extractor sees them. */
async function paragraphTexts(page: Page, n: number): Promise<string[]> {
  const overlays = surface(page, n).locator(".ov-para");
  await expect(overlays.first()).toBeVisible();
  const texts: string[] = [];
  for (let i = 0; i < (await overlays.count()); i++) {
    await overlays.nth(i).click();
    texts.push(await inlineEditor(page).inputValue());
    await inlineEditor(page).press("Escape");
  }
  return texts;
}

/** Opens the inline editor on the paragraph whose text starts with `start`. */
async function editParagraph(page: Page, n: number, start: string) {
  const overlays = surface(page, n).locator(".ov-para");
  await expect(overlays.first()).toBeVisible();
  for (let i = 0; i < (await overlays.count()); i++) {
    await overlays.nth(i).click();
    if ((await inlineEditor(page).inputValue()).startsWith(start)) return;
    await inlineEditor(page).press("Escape");
  }
  throw new Error(`No paragraph starting with "${start}" on page ${n}`);
}

async function saveAs(app: App, expectedPath: string) {
  await app.page.getByRole("button", { name: /Save as/ }).click();
  await expect(toast(app.page, `Saved ${expectedPath}`)).toBeVisible();
  await expect(statusBar(app.page)).not.toContainText("Unsaved changes");
}

async function reopen(file: string, fn: (app: App) => Promise<void>) {
  const app = await launchApp({ grants: [file] });
  try {
    await fn(app);
  } finally {
    await app.close();
  }
}

test.describe("text editing", () => {
  const saved = outPath("edited-paragraph");
  test.use({ appOptions: { grants: [FIXTURES.sample], saveTo: saved } });

  test("extracts wrapped lines as one paragraph, edits it, and the saved PDF has the new text", async ({ app }) => {
    const { page } = app;
    await openInEditor(app, FIXTURES.sample, 3);

    const before = await paragraphTexts(page, 1);
    expect(before).toEqual(expect.arrayContaining([SAMPLE.heading, PARA1]));

    await editParagraph(page, 1, "The survey team");
    await expect(inlineEditor(page)).toHaveValue(PARA1);
    await inlineEditor(page).fill("Edited by the end-to-end test.");
    const img = surface(page, 1).locator("img.page-image");
    const oldSrc = await img.getAttribute("src");
    await inlineEditor(page).press("Control+Enter");
    await expect(page.getByRole("heading", { name: "Text box" })).toBeVisible();
    // The page is re-rendered by PDFium with the edit applied.
    await expect(img).not.toHaveAttribute("src", oldSrc!);
    await expect(statusBar(page)).toContainText("Unsaved changes");

    await saveAs(app, saved);

    await reopen(saved, async (fresh) => {
      await openInEditor(fresh, saved, 3);
      const after = await paragraphTexts(fresh.page, 1);
      expect(after).toContain("Edited by the end-to-end test.");
      expect(after).toContain(SAMPLE.heading);
      expect(after.join("\n")).not.toContain("survey team");
    });
  });
});

test.describe("text boxes", () => {
  const saved = outPath("text-box");
  test.use({ appOptions: { grants: [FIXTURES.sample], saveTo: saved } });

  test("adds a text box with the T tool and it survives saving", async ({ app }) => {
    const { page } = app;
    await openInEditor(app, FIXTURES.sample, 3);
    await expect(surface(page, 1).locator(".ov-para").first()).toBeVisible();

    await page.keyboard.press("t");
    const box = (await surface(page, 1).boundingBox())!;
    // Lower part of page 1 is empty in the fixture.
    await page.mouse.click(box.x + box.width * 0.15, box.y + box.height * 0.85);
    await inlineEditor(page).fill("Added note");
    await inlineEditor(page).press("Control+Enter");
    await expect(page.getByRole("heading", { name: "Text box" })).toBeVisible();

    // Make it bold from the inspector.
    await page.getByRole("button", { name: "Bold" }).click();
    await expect(page.getByRole("button", { name: "Bold" })).toHaveAttribute("aria-pressed", "true");

    await saveAs(app, saved);
    await reopen(saved, async (fresh) => {
      await openInEditor(fresh, saved, 3);
      expect(await paragraphTexts(fresh.page, 1)).toContain("Added note");
    });
  });
});

test.describe("rotation and page order", () => {
  const saved = outPath("organized");
  test.use({ appOptions: { grants: [FIXTURES.sample, FIXTURES.second], saveTo: saved } });

  test("merged, reordered and rotated pages are saved as shown", async ({ app }) => {
    const { page } = app;
    await app.drop([FIXTURES.sample]);
    await expect(toast(page, "Opened sample.pdf")).toBeVisible();
    await app.drop([FIXTURES.second]);
    await expect(statusBar(page)).toContainText("of 5");
    await page.getByRole("button", { name: /Page Organizer/ }).click();
    // Delete sample pages 2-3, rotate the first second.pdf page.
    await page.getByLabel("Page 2", { exact: true }).click();
    await page.getByLabel("Page 3", { exact: true }).click({ modifiers: ["Shift"] });
    await page.keyboard.press("Delete");
    await page.getByLabel("Page 2", { exact: true }).click();
    await page.keyboard.press("r");
    await expect(statusBar(page)).toContainText("3 pages");

    await saveAs(app, saved);
    await reopen(saved, async (fresh) => {
      await fresh.drop([saved]);
      await expect(statusBar(fresh.page)).toContainText("of 3");
      await fresh.page.getByRole("button", { name: /Page Organizer/ }).click();
      await expect(fresh.page.getByLabel("Page 1", { exact: true }).getByText("Letter Portrait")).toBeVisible();
      // Rotation is baked into the saved page: A4 shown landscape with no app rotation.
      await expect(fresh.page.getByLabel("Page 2", { exact: true }).getByText("A4 Landscape")).toBeVisible();
      await expect(fresh.page.getByText("90° CW")).toHaveCount(0);
      await expect(fresh.page.getByLabel("Page 3", { exact: true }).getByText("A4 Portrait")).toBeVisible();
    });
  });
});

test.describe("paragraph across a page break", () => {
  test.use({ appOptions: { grants: [FIXTURES.sample] } });

  test("links a paragraph on page 1 with one on page 2 and re-flows it with the real fonts", async ({ app }) => {
    const { page } = app;
    await openInEditor(app, FIXTURES.sample, 3);
    await editParagraph(page, 1, "Results will be shared");
    await inlineEditor(page).press("Escape");
    await page.getByRole("button", { name: "Continues on next page…" }).click();
    await expect(page.getByText(/Click the paragraph on page 2 where this text continues/)).toBeVisible();
    await surface(page, 2).locator(".ov-para").first().click();

    await expect(page.getByRole("heading", { name: "Paragraph across pages 1–2" })).toBeVisible();
    const text = page.locator("textarea.link-text");
    await expect(text).toHaveValue(/before the end of the next quarter\. This is page 2 of the sample\./);
    // Real line measurement from the worker.
    await expect(page.getByText(/Page 1: \d+ \/ 2 lines/)).toBeVisible();
    await page.getByRole("button", { name: "Link and apply" }).click();
    await expect(statusBar(page)).toContainText("1 linked paragraph");
    await expect(page.getByRole("heading", { name: "Linked paragraph · pages 1–2" })).toBeVisible();
  });
});
