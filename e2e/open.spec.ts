import { FIXTURES } from "./paths";
import { expect, statusBar, test, toast } from "./app";

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

test("dropping more files while a document is open merges them", async ({ app }) => {
  const { page } = app;
  await app.drop([FIXTURES.sample]);
  await expect(statusBar(page)).toContainText("of 3");
  await app.drop([FIXTURES.second]);
  await expect(toast(page, "Opened second.pdf (2 pages)")).toBeVisible();
  await expect(statusBar(page)).toContainText("of 5");
  await expect(statusBar(page)).toContainText("2 files");
  await expect(page.locator(".doc-tab .count")).toHaveText("+1");
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

// Overlapping drops form one burst (App.tsx "files-dropped" handler): only the first
// document opened into an empty window replaces it, the rest append.
test("a second drop while the first file is still opening merges both", async ({ app }) => {
  const { page } = app;
  await app.drop([FIXTURES.sample]);
  await app.drop([FIXTURES.second]); // immediately, before sample.pdf has opened
  await expect(statusBar(page)).toContainText("of 5", { timeout: 8_000 });
});
