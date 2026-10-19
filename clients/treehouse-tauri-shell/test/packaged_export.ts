import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { createHash, generateKeyPairSync } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TreehouseWorkflow } from "../src/treehouse_workflow";
import { parseState } from "../src/treehouse_state";
import type { PreviewNative, PreviewState } from "../src/treehouse_state";
import { PACKAGED_ACCESSIBILITY_SWIFT, createAxDriver, nodesInclude, readKv } from "@treetopdevs/lattice-shell-kit/testing/packaged";
import type { AxDriver, AxNode } from "@treetopdevs/lattice-shell-kit/testing/packaged";

// Row 236. The ordinary packaged app's "Export Space frames" action, read by the catalog ceremony. Runs after
// `npm run packaged` and its replay, on the same runner: the retained Canopy Space is reused, never cleared or
// created here. The root pins a continuation through the real UI, exports to Downloads, the ceremony reader
// builds a binding payload from that file, the app signs it, exports again, and verify-binding reads the second
// file. Signer seeds stay in a private temporary directory outside the evidence directory.

const shell = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(shell, "../..");
const ORIGIN = "wss://relay.example.test";
const EXPORT_FORMAT = "lattice-space-frames-export-v1";

// ---- ceremony half (no app; also callable from a scratch script) ------------------------------------

export interface MixRun {
  args: string[];
  status: number | null;
  stdout: string;
  stderr: string;
}

/** One `mix treehouse.catalog_ceremony` run from the repository root, under MIX_ENV=test. */
export function ceremony(args: string[]): MixRun {
  const run = spawnSync(process.env.MIX ?? "mix", ["treehouse.catalog_ceremony", ...args], {
    cwd: repoRoot,
    env: { ...process.env, MIX_ENV: "test" },
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  return { args, status: run.status, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
}

/** The `key: value` lines the ceremony prints on stdout. */
export const stdoutField = (run: MixRun, key: string): string | undefined =>
  run.stdout
    .split("\n")
    .find((line) => line.startsWith(`${key}: `))
    ?.slice(key.length + 2);

export function accepted(run: MixRun, label: string) {
  assert.equal(run.status, 0, `${label} exited ${run.status}: ${run.stderr}`);
}

/** Nonzero exit with exactly this refusal atom on stderr. */
export function refused(run: MixRun, atom: string, label: string) {
  assert.notEqual(run.status, 0, `${label} was accepted`);
  assert(run.stderr.includes(`refused: ${atom}`), `${label}: expected refused: ${atom}, got ${run.stderr}`);
}

/** A fresh Ed25519 public key in standard padded base64, the form both the app and the ceremony read. */
export function freshPublicKey(): string {
  const der = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" });
  const key = der.subarray(der.length - 32).toString("base64");
  assert.equal(Buffer.from(key, "base64").length, 32);
  return key;
}

/** Same JSON value, pretty printed: the reader must refuse any encoding but the exact export bytes. */
export const prettyCopy = (bytes: string) => JSON.stringify(JSON.parse(bytes), null, 2);

/** One bit flipped in the first frame's signature, the document otherwise byte-identical. */
export function forgedCopy(bytes: string): string {
  const sig = (JSON.parse(bytes) as { frames: { sig: string }[] }).frames[0]!.sig;
  const raw = Buffer.from(sig, "base64");
  raw[0] = raw[0]! ^ 1;
  const forged = raw.toString("base64");
  assert.notEqual(forged, sig);
  assert.equal(bytes.split(`"sig":"${sig}"`).length, 2, "the first frame signature appears once");
  return bytes.replace(`"sig":"${sig}"`, `"sig":"${forged}"`);
}

export interface Workspace {
  base: string;
  keys: string;
  ceremonyDir: string;
  scratch: string;
}

/** Private temporary directories: `keys` (signer seed only) and `ceremony` both 0700, `scratch` for tampered copies. */
export function makeWorkspace(): Workspace {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "treehouse-export-")));
  chmodSync(base, 0o700);
  const dirs = { keys: join(base, "keys"), ceremonyDir: join(base, "ceremony"), scratch: join(base, "scratch") };
  for (const dir of Object.values(dirs)) {
    mkdirSync(dir, { mode: 0o700 });
    chmodSync(dir, 0o700);
  }
  return { base, ...dirs };
}

/** Write a tampered copy at a new scratch path and require the reader's refusal. */
export function refusedCopy(
  workspace: Workspace,
  name: string,
  bytes: string,
  command: (path: string) => string[],
  atom: string,
): MixRun {
  const path = join(workspace.scratch, name);
  assert(!existsSync(path));
  writeFileSync(path, bytes, { flag: "wx" });
  const run = ceremony(command(path));
  refused(run, atom, name);
  return run;
}

export const bindingPayloadArgs = (workspace: Workspace, spaceLog: string, serviceKey: string) => [
  "binding-payload",
  "--ceremony",
  workspace.ceremonyDir,
  "--space-log",
  spaceLog,
  "--service-public-key",
  serviceKey,
  "--origin",
  ORIGIN,
];
export const verifyBindingArgs = (workspace: Workspace, spaceLog: string) => [
  "verify-binding",
  "--ceremony",
  workspace.ceremonyDir,
  "--space-log",
  spaceLog,
];

/**
 * First half: generate a signer, build the binding payload from the export, then the two refused copies.
 * The successful binding-payload runs once only: a second run rewrites binding-payload.json with a new nonce.
 */
export function firstHalf(workspace: Workspace, exportPath: string, serviceKey: string) {
  const generate = ceremony(["generate", "--signer", join(workspace.keys, "signer.seed"), "--ceremony", workspace.ceremonyDir]);
  accepted(generate, "generate");
  const payload = ceremony(bindingPayloadArgs(workspace, exportPath, serviceKey));
  accepted(payload, "binding-payload");
  const sha = stdoutField(payload, "binding_payload_sha256");
  assert.match(sha ?? "", /^[0-9a-f]{64}$/, "binding-payload names binding_payload_sha256");
  const bytes = readFileSync(exportPath, "utf8");
  const command = (path: string) => bindingPayloadArgs(workspace, path, serviceKey);
  const pretty = refusedCopy(workspace, "pretty.frames.json", prettyCopy(bytes), command, "invalid_space_log");
  const forged = refusedCopy(workspace, "forged.frames.json", forgedCopy(bytes), command, "invalid_space_log");
  return { generate, payload, sha: sha!, refusals: { pretty, forged } };
}

// ---- packaged app half ------------------------------------------------------------------------------

const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
const FIELD_ROLES = ["AXTextField", "AXTextArea"];
const named = (node: AxNode, label: string) => node.title === label || node.description === label;

async function main() {
  const evidence = process.env.TREEHOUSE_EVIDENCE_DIR ?? "/tmp/treehouse-space-export";
  const binary = join(shell, "src-tauri/target/release/bundle/macos/Treehouse.app/Contents/MacOS/treehouse-tauri-shell");
  const appData = join(homedir(), "Library/Application Support/dev.treetop.lattice.treehouse");
  const database = join(appData, "treehouse-v1.sqlite3");
  mkdirSync(evidence, { recursive: true });
  const helper = join(evidence, "accessibility");
  const files: Record<string, string> = {};
  const record = (name: string, path: string) => {
    files[name] = sha256(readFileSync(path));
  };
  const keep = (name: string, from: string) => {
    copyFileSync(from, join(evidence, name));
    record(name, join(evidence, name));
  };
  const lines = (run: MixRun) => run.stdout.trim().split("\n").filter(Boolean);

  // 1. Preconditions, from the retained store, read-only.
  assert(existsSync(database), "run npm run packaged first: no retained Treehouse data");
  const history = () => {
    const value = readKv(database).find((r) => r.key === "treehouse:preview:history")?.value;
    assert(value, "no retained Treehouse history");
    return { value, state: parseState(value) };
  };
  async function readOnly(value: string, state: PreviewState) {
    const reader: PreviewNative = {
      open: async () => ({ record: value, publicKey: state.publicKey, keyStatus: "available" }),
      initialize: async () => {
        throw Error("read-only");
      },
      commit: async () => {
        throw Error("read-only");
      },
      sign: async () => {
        throw Error("read-only");
      },
      exportSpaceFrames: async () => {
        throw Error("read-only");
      },
      saveDraft: async () => {
        throw Error("read-only");
      },
      loadDraft: async () => null,
    };
    const workflow = new TreehouseWorkflow(reader);
    await workflow.open();
    return workflow;
  }
  const before = history();
  const spaces = before.state.profiles.filter((p) => p.product === "Treehouse.Space");
  assert.equal(spaces.length, 1, "exactly one retained Treehouse.Space profile");
  const replica = spaces[0]!.replica;
  const facts = (await readOnly(before.value, before.state)).continuation();
  assert.equal(facts.family, "bounded", "the retained Space is bounded-family");
  assert.equal(facts.isRoot, true, "this key is the Space root");
  assert.equal(facts.pinned, false, "no continuation is pinned yet");
  assert.equal(facts.bound, false, "no catalog binding is signed yet");

  // 2. Fresh public keys. Only public halves are used; the private halves are discarded.
  const nominee = freshPublicKey();
  const witnesses = [freshPublicKey(), freshPublicKey(), freshPublicKey()];
  const serviceKey = freshPublicKey();

  // 3. Downloads: the app writes to $HOME/Downloads and refuses a linked directory.
  const downloads = join(homedir(), "Downloads");
  mkdirSync(downloads, { recursive: true });
  assert(lstatSync(downloads).isDirectory(), "Downloads is a real directory, not a link");
  const downloadsReal = realpathSync(downloads);
  const tag = process.env.GITHUB_RUN_ID
    ? `${process.env.GITHUB_RUN_ID}-${process.env.GITHUB_RUN_ATTEMPT ?? "1"}`
    : `${process.pid}-${Date.now()}`;
  const exportName = (n: number) => `th-${tag}-${n}.frames.json`;

  execFileSync("swiftc", [PACKAGED_ACCESSIBILITY_SWIFT, "-o", helper]);
  let app: ChildProcess | null = null;
  const output: string[] = [];
  let ax: AxDriver;
  const workspace = makeWorkspace();
  const stop = async () => {
    const child = app;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const exited = new Promise<void>((r) => child.once("exit", () => r()));
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    await exited;
    clearTimeout(timer);
  };
  // Best effort: a crashed app must not replace the real failure with a dump error.
  const dumpTo = async (name: string) => {
    try {
      writeFileSync(join(evidence, name), JSON.stringify(await ax.dump(), null, 2));
    } catch {}
  };
  const waitFor = async (what: string, predicate: (nodes: AxNode[]) => boolean) => {
    try {
      return await ax.waitFor(what, predicate, 150);
    } catch (error) {
      await dumpTo("failed-ui.json");
      throw error;
    }
  };
  const waitText = (text: string) => waitFor(text, (nodes) => nodesInclude(nodes, text));
  // A refused action or a paste readback that never matches still leaves the tree it saw.
  const dumping = async (action: () => Promise<void>) => {
    try {
      await action();
    } catch (error) {
      await dumpTo("failed-ui.json");
      throw error;
    }
  };
  // A press on a disabled button finds no control; wait until it is visible and enabled first.
  const press = async (label: string) => {
    await waitFor(`${label} enabled`, (nodes) =>
      nodes.some((n) => n.role === "AXButton" && named(n, label) && n.enabled === "true"),
    );
    await dumping(() => ax.press(label));
  };
  const put = async (label: string, value: string) => {
    await waitFor(`${label} field`, (nodes) =>
      nodes.some((n) => FIELD_ROLES.includes(n.role) && named(n, label) && n.enabled === "true"),
    );
    await dumping(() => ax.put(label, value));
  };
  // WebKit may fold the <code> path into the paragraph, so match the path as text, then prove it on disk.
  async function exportAs(name: string) {
    const target = join(downloads, name);
    assert(!existsSync(target), `${target} already exists`);
    await put("Export file name", name);
    await press("Export Space frames");
    await waitFor(`Written to ${target}`, (nodes) =>
      nodesInclude(nodes, "Written to") && nodesInclude(nodes, target),
    );
    assert.equal(realpathSync(target), join(downloadsReal, name));
    const stat = lstatSync(target);
    assert(stat.isFile(), "the export is a regular file");
    const bytes = readFileSync(target, "utf8");
    const doc = JSON.parse(bytes) as { format: string; space: string; root: string; frames: { id: string }[] };
    assert.deepEqual(Object.keys(doc).sort(), ["format", "frames", "root", "space"]);
    assert.equal(doc.format, EXPORT_FORMAT);
    assert.equal(doc.space, replica);
    assert.equal(doc.root, before.state.publicKey);
    // Exactly the retained Space frames at export time.
    const retained = history().state.profiles.find((p) => p.replica === replica)!;
    assert.deepEqual(
      doc.frames.map((f) => f.id),
      retained.frames.map((f) => f.id).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    );
    return { path: target, bytes, frames: doc.frames.length, size: statSync(target).size };
  }

  try {
    app = spawn(binary, [], { stdio: ["ignore", "pipe", "pipe"] });
    const child = app;
    child.stdout!.on("data", (v) => output.push(String(v)));
    child.stderr!.on("data", (v) => output.push(String(v)));
    ax = createAxDriver({
      transfer: "paste",
      attempts: 150,
      exec: (args, input) =>
        execFileSync(helper, [String(child.pid), ...args], {
          encoding: "utf8",
          maxBuffer: 64 * 1024 * 1024,
          ...(input === undefined ? {} : { input }),
        }),
    });

    // 2. Pin the continuation through the panel.
    await waitText("Nominee public key");
    await dumpTo("unpinned-ui.json");
    await put("Nominee public key", nominee);
    await put("Witness public keys", witnesses.join("\n"));
    await press("Review continuation");
    await waitText("Review this continuation");
    await dumpTo("continuation-review-ui.json");
    await press("Pin continuation");
    await waitText("Continuation pinned.");
    await dumpTo("pinned-ui.json");
    const pinned = history();
    const pinnedFacts = (await readOnly(pinned.value, pinned.state)).continuation();
    assert.equal(pinnedFacts.pinned, true, "the pin is in the retained history");

    // 3. First export, before the binding.
    const first = await exportAs(exportName(1));
    await dumpTo("first-export-ui.json");
    keep("first.frames.json", first.path);

    // 4. Ceremony first half, in the private workspace.
    const half = firstHalf(workspace, first.path, serviceKey);
    keep("binding-payload.json", join(workspace.ceremonyDir, "binding-payload.json"));
    keep("binding-review.txt", join(workspace.ceremonyDir, "binding-review.txt"));
    const firstHalfResult = {
      status: "PASS",
      gate: "space-frames-export-first-half",
      space: replica,
      firstExport: { path: first.path, sha256: sha256(first.bytes), frames: first.frames },
      bindingPayloadSha256: half.sha,
      ceremony: { generate: lines(half.generate), bindingPayload: lines(half.payload) },
      refusals: {
        prettyBindingPayload: half.refusals.pretty.stderr.trim(),
        forgedBindingPayload: half.refusals.forged.stderr.trim(),
      },
      files,
    };
    writeFileSync(join(evidence, "first-half.json"), JSON.stringify(firstHalfResult, null, 2));

    // 6. Sign the binding in the app, then export again.
    const payloadText = readFileSync(join(workspace.ceremonyDir, "binding-payload.json"), "utf8").trim();
    await put("Paste binding payload", payloadText);
    await press("Review binding");
    await waitText("Review this binding");
    await waitText(half.sha);
    await dumpTo("binding-review-ui.json");
    await press("Sign binding");
    await waitText("Catalog binding signed.");
    await dumpTo("binding-signed-ui.json");
    const second = await exportAs(exportName(2));
    await dumpTo("second-export-ui.json");
    keep("second.frames.json", second.path);
    assert.equal(second.frames, first.frames + 1, "the second export adds exactly the binding frame");

    const verify = ceremony(verifyBindingArgs(workspace, second.path));
    accepted(verify, "verify-binding");
    const bootstrapId = stdoutField(verify, "bootstrap_id");
    assert(bootstrapId, "verify-binding names bootstrap_id");
    assert.equal(stdoutField(verify, "record_sha256"), half.sha);
    assert.equal(stdoutField(verify, "space"), replica);
    keep("binding.json", join(workspace.ceremonyDir, "binding.json"));

    const preBinding = ceremony(verifyBindingArgs(workspace, first.path));
    refused(preBinding, "binding_not_found", "verify-binding on the pre-binding export");
    const forgedSecond = refusedCopy(
      workspace,
      "forged-second.frames.json",
      forgedCopy(second.bytes),
      (path) => verifyBindingArgs(workspace, path),
      "invalid_space_log",
    );

    writeFileSync(
      join(evidence, "result.json"),
      JSON.stringify(
        {
          status: "PASS",
          gate: "space-frames-export",
          gitSha: execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", cwd: repoRoot }).trim(),
          sourceState: execFileSync("git", ["status", "--porcelain"], { encoding: "utf8", cwd: repoRoot }),
          binarySha256: sha256(readFileSync(binary)),
          space: replica,
          root: before.state.publicKey,
          origin: ORIGIN,
          downloads: [
            { path: first.path, sha256: sha256(first.bytes), frames: first.frames, bytes: first.size },
            { path: second.path, sha256: sha256(second.bytes), frames: second.frames, bytes: second.size },
          ],
          bindingPayloadSha256: half.sha,
          bootstrapId,
          ceremony: {
            generate: lines(half.generate),
            bindingPayload: lines(half.payload),
            verifyBinding: lines(verify),
          },
          refusals: {
            prettyBindingPayload: half.refusals.pretty.stderr.trim(),
            forgedBindingPayload: half.refusals.forged.stderr.trim(),
            preBindingVerify: preBinding.stderr.trim(),
            forgedSecondVerify: forgedSecond.stderr.trim(),
          },
          files,
        },
        null,
        2,
      ),
    );
    console.log(
      "PASS packaged Space frames export: pinned, exported, binding payload, signed, exported again, verify-binding",
    );
  } finally {
    await stop();
    writeFileSync(join(evidence, "app.log"), output.join(""));
    rmSync(workspace.base, { recursive: true, force: true });
  }
}

// Imported by a scratch check, only the ceremony half above is used.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
