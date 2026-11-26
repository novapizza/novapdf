// The Outline tab: bookmarks read from the file by the sandboxed worker, shown as a
// tree, and going to their page (and the spot on it) when clicked.
import { FIXTURES } from "./paths";
import { expect, statusBar, test } from "./app";

test.use({ appOptions: { grants: [FIXTURES.outlined] } });

test("lists the file's bookmarks and goes to them", async ({ app }) => {
  const { page } = app;
  await app.drop([FIXTURES.outlined]);
  await expect(statusBar(page)).toContainText("Page 1 of 4");

  // Exact: the document's own tab, "outlined.pdf", also contains the word.
  await page.getByRole("tab", { name: "Outline", exact: true }).click();
  const tree = page.getByRole("tree", { name: "Bookmarks" });
  // "Introduction" is open in the file, "Methods" is closed.
  await expect(tree.getByRole("treeitem")).toHaveText(["Introduction1", "Scope2", "Methods3", "Website"]);
  await expect(tree.getByRole("button", { name: "Website" })).toBeDisabled();

  // "Scope" goes 392 pt down page 2 (y = 400 from the bottom of a 792 pt page): that
  // spot lands near the top of the view.
  await tree.getByRole("button", { name: /^Scope/ }).click();
  await expect(statusBar(page)).toContainText("Page 2 of 4");
  const scroll = (await page.locator(".doc-scroll").boundingBox())!;
  const page2 = (await page.locator('.page-surface[data-page="2"]').boundingBox())!;
  const scale = page2.width / 612;
  expect(Math.abs(page2.y - scroll.y - (12 - 392 * scale))).toBeLessThan(3);
  await expect(tree.getByRole("treeitem", { selected: true })).toHaveText("Scope2");

  await tree.getByRole("button", { name: "Expand Methods" }).click();
  await expect(tree.getByRole("treeitem")).toHaveText(["Introduction1", "Scope2", "Methods3", "Sampling4", "Website"]);
  await tree.getByRole("button", { name: /^Methods/ }).click();
  await expect(statusBar(page)).toContainText("Page 3 of 4");
  await expect(tree.getByRole("treeitem", { selected: true })).toHaveText("Methods3");
});
