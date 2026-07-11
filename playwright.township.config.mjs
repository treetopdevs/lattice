import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "township_instrument.spec.mjs",
  outputDir: "./output/playwright/township-test-results",
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: { timeout: 5_000 },
  reporter: [
    ["list"],
    ["html", { outputFolder: "output/playwright/township-html-report", open: "never" }],
  ],
  use: {
    browserName: "chromium",
    headless: true,
    viewport: { width: 1440, height: 960 },
    screenshot: "on",
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    command: "scripts/township_instrument_server.sh",
    url: "http://localhost:4113/township",
    reuseExistingServer: false,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
  },
});
