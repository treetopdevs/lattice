import { defineConfig } from "@playwright/test";

const channel = process.env.PLAYWRIGHT_CHANNEL;

export default defineConfig({
  testDir: "./tests/e2e",
  outputDir: "./output/playwright/test-results",
  fullyParallel: false,
  workers: 1,
  timeout: 45_000,
  expect: {
    timeout: 5_000,
  },
  reporter: [
    ["list"],
    ["html", { outputFolder: "output/playwright/html-report", open: "never" }],
  ],
  use: {
    browserName: "chromium",
    ...(channel ? { channel } : {}),
    headless: true,
    viewport: { width: 1440, height: 960 },
    video: {
      mode: "on",
      size: { width: 1440, height: 960 },
    },
    screenshot: "on",
    trace: "retain-on-failure",
  },
});
