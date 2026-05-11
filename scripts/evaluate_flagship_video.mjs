#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdir, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

const root = new URL("..", import.meta.url).pathname;
const resultDir = path.join(root, "output/playwright/test-results");
const reportPath = path.join(root, "output/playwright/flagship-video-evaluation.json");
const screenshotPath = path.join(root, "output/playwright/flagship-demo.png");
const minBytes = Number(process.env.LATTICE_VIDEO_MIN_BYTES || 120_000);
const minDuration = Number(process.env.LATTICE_VIDEO_MIN_SECONDS || 4);
const minWidth = Number(process.env.LATTICE_VIDEO_MIN_WIDTH || 1000);
const minHeight = Number(process.env.LATTICE_VIDEO_MIN_HEIGHT || 700);

const video = await latestFile(resultDir, ".webm");
const screenshot = (await exists(screenshotPath)) ? screenshotPath : null;

if (!video) fail("No Playwright .webm video artifact found.");
if (!screenshot) fail("No Playwright screenshot artifact found.");

const videoStat = await stat(video);
const screenshotStat = await stat(screenshot);
const probe = probeVideo(video);

const checks = [
  ["video exists", true, video],
  ["video size", videoStat.size >= minBytes, `${videoStat.size} bytes`],
  ["screenshot exists", true, screenshot],
  ["screenshot size", screenshotStat.size >= 80_000, `${screenshotStat.size} bytes`],
  ["ffprobe available", probe.available === true, probe.error || "available"],
  ["video duration", Number.isFinite(probe.duration) && probe.duration >= minDuration, `${probe.duration ?? "unavailable"} seconds`],
  ["video width", Number.isInteger(probe.width) && probe.width >= minWidth, `${probe.width ?? "unavailable"} px`],
  ["video height", Number.isInteger(probe.height) && probe.height >= minHeight, `${probe.height ?? "unavailable"} px`],
];

const acceptable = checks.every(([_name, passed]) => passed);
const report = {
  acceptable,
  video,
  screenshot,
  thresholds: { minBytes, minDuration, minWidth, minHeight },
  probe,
  checks: checks.map(([name, passed, detail]) => ({ name, passed, detail })),
};

await mkdir(path.dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);

if (!acceptable) {
  console.error(`Flagship E2E video unacceptable. See ${reportPath}`);
  console.error(JSON.stringify(report, null, 2));
  process.exit(1);
}

console.log(`Flagship E2E video acceptable: ${video}`);
console.log(`Video evaluation: ${reportPath}`);

async function latestFile(dir, extension) {
  const files = await findFiles(dir, extension).catch(() => []);
  const stats = await Promise.all(files.map(async (file) => ({ file, stat: await stat(file) })));
  stats.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
  return stats[0]?.file;
}

async function exists(file) {
  try {
    await stat(file);
    return true;
  } catch {
    return false;
  }
}

async function findFiles(dir, extension) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map((entry) => {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) return findFiles(fullPath, extension);
      if (entry.isFile() && entry.name.endsWith(extension)) return [fullPath];
      return [];
    }),
  );
  return files.flat();
}

function probeVideo(file) {
  const result = spawnSync(
    "ffprobe",
    [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=width,height:format=duration",
      "-of",
      "json",
      file,
    ],
    { encoding: "utf8" },
  );

  if (result.error) return { available: false, error: result.error.message };
  if (result.status !== 0) {
    return { available: false, error: result.stderr || `ffprobe exited ${result.status}` };
  }

  try {
    const parsed = JSON.parse(result.stdout);
    const stream = parsed.streams?.[0] || {};
    return {
      available: true,
      duration: parsed.format?.duration ? Number(parsed.format.duration) : null,
      width: stream.width ?? null,
      height: stream.height ?? null,
    };
  } catch (error) {
    return { available: false, error: error.message };
  }
}

function fail(message) {
  console.error(message);
  process.exit(1);
}
