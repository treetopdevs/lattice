import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "township_action_handoff.spec.ts",
  outputDir: "./output/playwright/township-action-handoff-test-results",
  fullyParallel: false,
  workers: 1,
  timeout: 180_000,
  expect: { timeout: 10_000 },
  reporter: [
    ["list"],
    ["html", { outputFolder: "output/playwright/township-action-handoff-html-report", open: "never" }],
  ],
  use: {
    browserName: "chromium",
    headless: true,
    viewport: { width: 1440, height: 960 },
    screenshot: "on",
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
});
