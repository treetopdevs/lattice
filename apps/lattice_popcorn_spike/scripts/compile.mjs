import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { prepareShared } from "./shared.mjs";
import { writeFile } from "node:fs/promises";

const sources = await prepareShared();
execFileSync("mix", ["compile", "--warnings-as-errors"], {
  cwd: fileURLToPath(new URL("../browser", import.meta.url)), stdio: "inherit"
});
await writeFile(new URL("../browser/_build/source-hashes.json", import.meta.url), JSON.stringify(sources));
