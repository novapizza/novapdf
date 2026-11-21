import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// Unit + component tests (jsdom, Tauri mocked). E2E tests live in e2e/ and run
// with Playwright against the real app: see TESTING.md.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    setupFiles: ["src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
    restoreMocks: true,
    coverage: {
      provider: "v8",
      // Every source file counts, tested or not, so a new untested file drags the
      // numbers down and fails the gate instead of being silently ignored.
      include: ["src/**/*.{ts,tsx}"],
      exclude: ["src/test/**", "src/**/*.test.{ts,tsx}", "src/main.tsx", "src/vite-env.d.ts"],
      reporter: ["text", "html", "json-summary"],
      reportsDirectory: "coverage",
      // Checked PER FILE, so a new untested function fails the run and names its file
      // instead of hiding in the average. Ratchet: set a little below what the suite
      // achieves today; raise them when coverage goes up, never lower them to make a
      // change pass. See TESTING.md.
      thresholds: {
        perFile: true,
        // Every UI file.
        lines: 85,
        statements: 80,
        functions: 65,
        branches: 74,
        // Pure logic: everything here must be tested.
        "src/lib/**": { perFile: true, lines: 98, statements: 98, functions: 98, branches: 90 },
        "src/state/**": { perFile: true, lines: 98, statements: 95, functions: 98, branches: 90 },
      },
    },
  },
});
