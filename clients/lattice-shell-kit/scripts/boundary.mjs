// Plan 186 decision 8: the kit's compiled graph stays inside the kit. Reads the compiler's resolved file
// list (not source text) and fails on any file outside the kit (its own node_modules included) or
// lattice-client (reached through the tsconfig `paths` entry for its dist declarations). `--allowJs` makes
// tsc follow and list JavaScript imports too, which it otherwise drops without a diagnostic.
import { spawnSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";

const kitRoot = realpathSync(join(dirname(fileURLToPath(import.meta.url)), ".."));
const allowed = [kitRoot + sep, realpathSync(join(kitRoot, "../lattice-client")) + sep];
const tsc = join(kitRoot, "node_modules/.bin/tsc");
if (!existsSync(tsc)) {
  console.error("shell-kit boundary: no kit-local tsc; run npm ci in clients/lattice-shell-kit first");
  process.exit(1);
}
const run = spawnSync(tsc, ["--noEmit", "--listFiles", "--allowJs"], { cwd: kitRoot, encoding: "utf8" });
const files = run.stdout
  .split(/\r?\n/)
  .filter((line) => line.startsWith("/"))
  .map((line) => realpathSync(line));
const outside = files.filter((file) => !allowed.some((root) => file.startsWith(root)));
if (outside.length > 0) {
  console.error(`shell-kit boundary: the compiled graph reaches outside the kit:\n${outside.join("\n")}`);
  process.exit(1);
}
if (run.status !== 0) {
  console.error(run.stdout.split(/\r?\n/).filter((line) => !line.startsWith("/")).join("\n"), run.stderr);
  process.exit(run.status ?? 1);
}
console.log(`shell-kit boundary: ${files.length} compiled files, none outside the kit or lattice-client`);
