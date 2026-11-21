import { FIXTURES } from "./paths";
import type { Page } from "@playwright/test";
import { expect, statusBar, test, toast } from "./app";

const docTabs = (page: Page) => page.getByRole("tablist", { name: "Open documents" }).getByRole("tab");

test.use({ appOptions: { grants: [FIXTURES.sample, FIXTURES.second, FIXTURES.notPdf] } });

test("starts in the library with the sandboxed engine", async ({ app }) => {
  const { page } = app;
  await expect(page).toHaveTitle("NovaPDF");
  await expect(page.getByRole("heading", { name: /Document Library/ })).toBeVisible();
  await expect(page.getByText("No document open")).toBeVisible();
  await expect(statusBar(page)).toContainText("PDFium · sandboxed");
  // Real backend: the font list comes from the system.
  await page.getByRole("button", { name: /Search tools and actions/ }).click();
  await expect(page.getByRole("dialog", { name: "Command palette" })).toBeVisible();
  await page.keyboard.press("Escape");
});

test("opens a dropped PDF and renders its pages with PDFium", async ({ app }) => {
  const { page } = app;
  await app.drop([FIXTURES.sample]);
  await expect(toast(page, "Opened sample.pdf (3 pages)")).toBeVisible();
  await expect(statusBar(page)).toContainText("Page 1 of 3");
  await expect(statusBar(page)).toContainText("Letter Portrait");
  const img = page.getByAltText("Page 1");
  await expect(img).toBeVisible();
  // A real decoded image, not a placeholder.
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(400);
  await expect(page.getByRole("button", { name: "Go to page 3" })).toBeVisible();
});

test("each opened file gets its own tab with its own pages", async ({ app }) => {
  const { page } = app;
  await app.drop([FIXTURES.sample]);
  await expect(statusBar(page)).toContainText("of 3");
  await app.drop([FIXTURES.second]);
  await expect(toast(page, "Opened second.pdf (2 pages)")).toBeVisible();
  await expect(docTabs(page)).toHaveText([/sample\.pdf/, /second\.pdf/]);
  await expect(statusBar(page)).toContainText("Page 1 of 2");
  await expect(statusBar(page)).toContainText("A4 Portrait");

  await docTabs(page).filter({ hasText: "sample.pdf" }).click();
  await expect(statusBar(page)).toContainText("Page 1 of 3");
  await expect(statusBar(page)).toContainText("Letter Portrait");
  await page.keyboard.press("Control+Tab");
  await expect(statusBar(page)).toContainText("Page 1 of 2");

  await page.keyboard.press("Control+W");
  await expect(docTabs(page)).toHaveText([/sample\.pdf/]);
  await expect(statusBar(page)).toContainText("Page 1 of 3");
  await expect(page.getByAltText("Page 1")).toBeVisible();
});

test("Open picks files into new tabs; opening one again switches to its tab", async ({ app }) => {
  const { page } = app;
  app.pick([FIXTURES.sample, FIXTURES.second]);
  await page.getByRole("button", { name: /^Open$/ }).click();
  await expect(toast(page, "Opened 2 files (5 pages)")).toBeVisible();
  await expect(docTabs(page)).toHaveText([/sample\.pdf/, /second\.pdf/]);
  // The backend recognises the same unchanged file and hands back its document.
  app.pick([FIXTURES.sample]);
  await page.keyboard.press("Control+O");
  await expect(toast(page, "sample.pdf is already open")).toBeVisible();
  await expect(docTabs(page)).toHaveCount(2);
  await expect(docTabs(page).and(page.locator("[aria-selected=true]"))).toContainText("sample.pdf");
});

test("Merge appends another file to the current tab", async ({ app }) => {
  const { page } = app;
  await app.drop([FIXTURES.sample]);
  await expect(statusBar(page)).toContainText("of 3");
  app.pick([FIXTURES.second]);
  await page.getByRole("button", { name: /Search tools and actions/ }).click();
  await page.getByText("Merge PDFs into this document").click();
  await expect(toast(page, "Merged second.pdf (2 pages)")).toBeVisible();
  await expect(statusBar(page)).toContainText("of 5");
  await expect(statusBar(page)).toContainText("2 files");
  await expect(docTabs(page)).toHaveCount(1);
  await expect(page.locator(".doc-tab .count")).toHaveText("+1");
});

test("Merge PDFs from the library combines the picked files into one tab", async ({ app }) => {
  const { page } = app;
  app.pick([FIXTURES.sample, FIXTURES.second]);
  await page.getByRole("button", { name: /Merge PDFs/ }).click();
  await expect(toast(page, "Merged 2 files (5 pages)")).toBeVisible();
  // Straight into the document workspace, one tab holding both files.
  await expect(page.getByRole("navigation", { name: "Reader tools" })).toBeVisible();
  await expect(docTabs(page)).toHaveCount(1);
  await expect(page.locator(".doc-tab .count")).toHaveText("+1");
  await expect(statusBar(page)).toContainText("Page 1 of 5");
  await expect(statusBar(page)).toContainText("2 files");
  // Jumping to a page from the other file renders it.
  await page.getByRole("button", { name: "Go to page 5" }).click();
  await expect(statusBar(page)).toContainText("Page 5 of 5");
  const img = page.getByAltText("Page 5");
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBeGreaterThan(400);
});

test("clicking a tab from the library opens its document", async ({ app }) => {
  const { page } = app;
  app.pick([FIXTURES.sample, FIXTURES.second]);
  await page.getByRole("button", { name: /^Open$/ }).click();
  await expect(docTabs(page)).toHaveCount(2);
  await page.getByRole("navigation", { name: "Workspaces" }).getByRole("button", { name: /Library/ }).click();
  await expect(page.getByRole("heading", { name: /Document Library/ })).toBeVisible();
  await docTabs(page).filter({ hasText: "sample.pdf" }).click();
  await expect(page.getByRole("navigation", { name: "Reader tools" })).toBeVisible();
  await expect(statusBar(page)).toContainText("Page 1 of 3");
  await expect(page.getByAltText("Page 1")).toBeVisible();
});

test("rejects a file that is not a PDF", async ({ app }) => {
  const { page } = app;
  await app.drop([FIXTURES.notPdf]);
  await expect(toast(page, "not-a.pdf: This file is not a PDF.")).toBeVisible();
  await expect(page.getByText("No document open")).toBeVisible();
});

test("refuses paths the user never dropped (UI cannot read arbitrary files)", async ({ app }) => {
  const { page } = app;
  // A real PDF, but not granted by the native drop handler.
  const outcome = await page.evaluate(async () => {
    const internals = (window as unknown as { __TAURI_INTERNALS__: { invoke: (c: string, a: unknown) => Promise<unknown> } })
      .__TAURI_INTERNALS__;
    return internals.invoke("open_dropped", { paths: ["C:\\Windows\\System32\\drivers\\etc\\hosts.pdf"] });
  });
  expect(outcome).toEqual([
    { fileName: "hosts.pdf", document: null, error: "This file was not dropped onto the window." },
  ]);
  // A grant is single-use.
  await app.drop([FIXTURES.sample]);
  await expect(statusBar(page)).toContainText("of 3");
  await app.drop([FIXTURES.sample]);
  await expect(toast(page, "This file was not dropped onto the window.")).toBeVisible();
});

// Overlapping drops are applied in drop order (App.tsx "files-dropped" handler).
test("a second drop while the first file is still opening opens both, in order", async ({ app }) => {
  const { page } = app;
  await app.drop([FIXTURES.sample]);
  await app.drop([FIXTURES.second]); // immediately, before sample.pdf has opened
  await expect(docTabs(page)).toHaveText([/sample\.pdf/, /second\.pdf/], { timeout: 8_000 });
});
