import { defineConfig } from "@playwright/test";

// E2E: the real app (Rust + sandboxed PDFium workers + WebView2) driven over the
// Chrome DevTools Protocol. Windows only (WebView2). See TESTING.md and e2e/app.ts.
export default defineConfig({
  testDir: "e2e",
  globalSetup: "./e2e/global-setup.ts",
  // One app at a time: each test launches its own instance on its own debug port,
  // but they share the Vite dev server and the WebView2 runtime.
  workers: 1,
  fullyParallel: false,
  timeout: 90_000,
  expect: { timeout: 15_000 },
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"], ["html", { open: "never", outputFolder: "e2e/.out/report" }]],
  outputDir: "e2e/.out/results",
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  // The debug app loads its UI from the dev server (tauri.conf.json devUrl).
  webServer: {
    command: "npm run dev",
    url: "http://localhost:1420",
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
