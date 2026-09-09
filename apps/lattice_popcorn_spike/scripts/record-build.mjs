import { readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";

const root = new URL("../dist/", import.meta.url);
const assets = [];
async function inventory(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const url = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
    if (entry.isDirectory()) await inventory(url);
    else {
      const bytes = await readFile(url);
      assets.push({ path: url.pathname.slice(root.pathname.length), bytes: bytes.length,
        gzipEstimateBytes: gzipSync(bytes).length,
        sha256: createHash("sha256").update(bytes).digest("hex") });
    }
  }
}
await inventory(root);
const json = async path => JSON.parse(await readFile(new URL(path, import.meta.url)));
await writeFile(new URL("build.json", root), JSON.stringify({
  package: "0.4.0-next.0",
  shared: await json("../browser/_build/source-hashes.json"),
  runtimeManifest: await json("../node_modules/@swmansion/popcorn/dist/runtimes/crypto/manifest.json"),
  assets
}, null, 2));
