import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { PackagedBundleVariant } from "./packaged_bundle_variant";

/**
 * Frontend variant classifier (Plan 181 row 201). EnrollmentPanel.vue carries a fixed static attribute
 * value; App.vue imports the panel only when both variant flags are "1", so an ordinary dist has no file
 * containing the marker.
 */
export const TREEHOUSE_ENROLLMENT_FRONTEND_MARKER = "treehouse.enrollment-panel.v1";

export type FrontendVariant = "ordinary" | "enrollment";

export const FRONTEND_VARIANT_FOR_BUNDLE: Record<PackagedBundleVariant, FrontendVariant> = {
  ordinary: "ordinary",
  dev_trace: "enrollment",
};

function listFiles(root: string, dir: string, out: string[]): void {
  for (const name of readdirSync(dir).sort()) {
    const path = join(dir, name);
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) {
      const real = realpathSync(path);
      const rel = relative(root, real);
      if (rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith("/"))
        throw new Error(`dist contains a symlink escaping it: ${path}`);
      continue; // an in-dist target is scanned under its own path
    }
    if (stat.isDirectory()) listFiles(root, path, out);
    else if (stat.isFile()) out.push(path);
  }
}

export function classifyFrontendDist(distDir: string): FrontendVariant {
  let root: string;
  try {
    root = realpathSync(distDir);
  } catch {
    throw new Error(`frontend dist is missing: ${distDir}`);
  }
  if (!lstatSync(root).isDirectory()) throw new Error(`frontend dist is not a directory: ${distDir}`);
  const files: string[] = [];
  listFiles(root, root, files);
  if (files.length === 0) throw new Error(`frontend dist is empty: ${distDir}`);
  if (!files.includes(join(root, "index.html")))
    throw new Error(`frontend dist has no index.html: ${distDir}`);
  const marker = Buffer.from(TREEHOUSE_ENROLLMENT_FRONTEND_MARKER, "utf8");
  return files.some((file) => readFileSync(file).includes(marker)) ? "enrollment" : "ordinary";
}

export function assertFrontendDistVariant(distDir: string, expected: FrontendVariant): void {
  const actual = classifyFrontendDist(distDir);
  if (actual !== expected)
    throw new Error(`frontend dist ${distDir} classifies as ${actual}, expected ${expected}`);
}
