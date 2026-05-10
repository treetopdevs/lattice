#!/usr/bin/env node
import { spawn } from "node:child_process";

const root = new URL("..", import.meta.url).pathname;

const test = spawn(
  "npx",
  ["--no-install", "playwright", "test", "tests/e2e/flagship.spec.mjs", "--config", "playwright.config.mjs"],
  {
    cwd: root,
    stdio: "inherit",
  },
);

const testStatus = await exitCode(test);

if (testStatus === 0) {
  const evaluator = spawn("node", ["scripts/evaluate_flagship_video.mjs"], {
    cwd: root,
    stdio: "inherit",
  });

  process.exitCode = await exitCode(evaluator);
} else {
  process.exitCode = testStatus;
}

function exitCode(child) {
  return new Promise((resolve) => {
    child.on("close", (code) => resolve(code ?? 1));
  });
}
