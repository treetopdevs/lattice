import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Plan 181 slice 5c2: structural contract for the hard-failing packaged enrollment job.
//
// The workflow is parsed into job and step blocks (no yaml dependency in this shell, as in the Township
// precedent mobile_core_native_ci_contract.mjs). `check` returns a list of violations for a workflow text
// and a package.json object, and every mutation fixture below must make it return a non-empty list. A text
// check alone is not feasibility proof: the hosted job still has to finish green.

const shellRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const repoRoot = resolve(shellRoot, "..", "..");

const JOB = "treehouse_packaged_macos_enrollment";
const SHELL_DIR = "clients/treehouse-tauri-shell";
const CLASSIFY_STEP = "Classify ordinary Treehouse bundle";
const BUILD_STEP_CALL = "npm run tauri:build:dev-trace";
const EVIDENCE_DIR = "${{ runner.temp }}/treehouse-enrollment";
const REAL_DATA = "dev.treetop.lattice.treehouse";

// Digest of every packaged_macos step body except the added classification step. These bodies are
// operator-reviewed and pinned: the classification step is the only add-only edit this plan makes there.
const PACKAGED_MACOS_DIGEST = "a7457cfa3c27586c7b75003254d1f12ca12f3e998ac4cf7bc7a375a0fb278637";

const ANDROID_PILOT_NEEDS = ["verify", "unit", "packaged_macos", "android_pilot_verify"];

function jobBlocks(workflow) {
  const jobsStart = workflow.indexOf("\njobs:\n");
  if (jobsStart === -1) return [];
  const jobsSection = workflow.slice(jobsStart + "\njobs:\n".length);
  return jobsSection.match(/^  [a-zA-Z0-9_-]+:\n(?:^(?!  [a-zA-Z0-9_-]+:)[^\n]*\n?)*/gm) ?? [];
}

function jobName(block) {
  return /^ {2}([a-zA-Z0-9_-]+):/u.exec(block)?.[1];
}

function findJob(workflow, name) {
  return jobBlocks(workflow).find((block) => jobName(block) === name);
}

function stepBlocks(job) {
  return job.match(/^ {6}- (?:[^\n]*\n)(?:^(?! {6}- )[^\n]*\n?)*/gm) ?? [];
}

function stepName(step) {
  return /^ {6}- name:\s*(.*)$/mu.exec(step)?.[1]?.trim();
}

function scalar(block, key, indent = 8) {
  const ordinary = block.match(new RegExp(`^ {${indent}}${key}:\\s*(.*)$`, "m"));
  const firstStepKey =
    indent === 8 ? block.match(new RegExp(`^ {6}- ${key}:\\s*(.*)$`, "m")) : undefined;
  const match = ordinary ?? firstStepKey;
  if (!match) return undefined;
  const value = match[1].trim();
  if (!/^[|>][-+]?$/u.test(value)) return value;
  const lines = block.slice((match.index ?? 0) + match[0].length).split("\n");
  const out = [];
  for (const line of lines) {
    if (line.trim() === "") continue;
    if (!line.startsWith(" ".repeat(indent + 2))) break;
    out.push(line.slice(indent + 2).trim());
  }
  return out.join("\n");
}

function jobHeader(job) {
  const at = job.indexOf("\n    steps:");
  return at === -1 ? job : job.slice(0, at);
}

function withKey(step, key) {
  const match = step.match(new RegExp(`^ {10}${key}:\\s*(.*)$`, "m"));
  return match?.[1]?.trim();
}

function envKeys(step) {
  const at = step.search(/^ {8}env:\s*$/m);
  if (at === -1) return [];
  const keys = [];
  for (const line of step.slice(at).split("\n").slice(1)) {
    if (line.trim() === "") continue;
    if (!line.startsWith(" ".repeat(10))) break;
    const key = /^ {10}([A-Za-z0-9_]+):/u.exec(line)?.[1];
    if (key) keys.push(key);
  }
  return keys;
}

function expandRun(run, scripts) {
  return run
    .split("\n")
    .map((line) => {
      const call = /^npm run (\S+)/u.exec(line.trim());
      return call && scripts[call[1]] !== undefined ? `${line}\n${scripts[call[1]]}` : line;
    })
    .join("\n");
}

function sha(text) {
  return createHash("sha256").update(text).digest("hex");
}

function packagedMacosDigest(workflow) {
  const job = findJob(workflow, "packaged_macos");
  if (!job) return undefined;
  const bodies = stepBlocks(job).filter((step) => stepName(step) !== CLASSIFY_STEP);
  return sha(bodies.join(""));
}

function pinnedUses(job, action) {
  for (const step of stepBlocks(job)) {
    const uses = scalar(step, "uses");
    if (uses?.startsWith(`${action}@`)) return uses.replace(/\s+#.*$/u, "");
  }
  return undefined;
}

export function check(workflow, pkg, harnessSource) {
  const problems = [];
  const fail = (message) => problems.push(message);

  const job = findJob(workflow, JOB);
  const macos = findJob(workflow, "packaged_macos");
  if (!job) {
    fail(`job ${JOB} is missing`);
  }
  if (!macos) fail("job packaged_macos is missing");

  // Existing packaged_macos: add-only classification step, every other body pinned by digest.
  if (macos) {
    const steps = stepBlocks(macos);
    const names = steps.map(stepName);
    const buildAt = names.indexOf("Build ordinary offline Treehouse app");
    const classifyAt = names.indexOf(CLASSIFY_STEP);
    if (classifyAt === -1) fail("packaged_macos lacks the ordinary bundle classification step");
    else {
      if (classifyAt <= buildAt || buildAt === -1) fail("classification must run after the ordinary build");
      const classify = steps[classifyAt];
      const run = scalar(classify, "run") ?? "";
      if (!/tsx test\/assert_bundle_variant\.ts\s+\S*Treehouse\.app\s+ordinary\s*$/mu.test(run))
        fail("classification step must assert the ordinary variant of the ordinary bundle");
      if (scalar(classify, "working-directory") !== SHELL_DIR) fail("classification runs in the Treehouse shell");
      if (/^ {6,8}(?:- )?(?:if|continue-on-error):/mu.test(classify) || /\|\|/u.test(run))
        fail("classification must be unconditional and blocking");
    }
    if (packagedMacosDigest(workflow) !== PACKAGED_MACOS_DIGEST)
      fail("packaged_macos step bodies other than the classification step changed");
  }

  // android_pilot needs stays exactly the pinned four; the new job is no one's dependency.
  const pilot = findJob(workflow, "android_pilot");
  if (pilot) {
    const needs = [...(/^ {4}needs:\n((?: {6}- .*\n)+)/mu.exec(pilot)?.[1] ?? "").matchAll(/- (\S+)/gu)].map(
      (m) => m[1],
    );
    if (JSON.stringify(needs) !== JSON.stringify(ANDROID_PILOT_NEEDS))
      fail("android_pilot needs must stay the existing four jobs");
  } else fail("android_pilot is missing");
  for (const other of jobBlocks(workflow)) {
    if (jobName(other) === JOB) continue;
    if (new RegExp(`\\b${JOB}\\b`, "u").test(other)) fail(`${jobName(other)} must not reference ${JOB}`);
  }

  if (!job) return problems;

  const header = jobHeader(job);
  const steps = stepBlocks(job);

  if (scalar(header, "runs-on", 4) !== "macos-15-intel") fail("runs-on must be macos-15-intel");
  const timeout = Number(scalar(header, "timeout-minutes", 4));
  if (!Number.isInteger(timeout) || timeout < 30 || timeout > 120) fail("timeout-minutes must be a bounded 30 to 120");
  if (scalar(header, "if", 4) !== undefined) fail("the job must have no if");
  if (!/^ {4}permissions:\n {6}contents: read\n(?! {6})/mu.test(header)) fail("the job must declare least-privilege permissions: contents: read");
  if (/continue-on-error/u.test(job)) fail("continue-on-error is forbidden in any spelling");
  if (/\|\|\s*(?:true|:|exit\s+0)\b/u.test(job)) fail("|| true style masking is forbidden");
  if (/set\s+\+e/u.test(job)) fail("set +e is forbidden");
  if (/\bif:\s*(?:\$\{\{\s*)?false\b/u.test(job)) fail("if: false is forbidden");
  if (/lattice-mobile-core/u.test(job)) fail("the job must not use lattice-mobile-core");
  if (/SKIP/iu.test(job)) fail("skip switches are forbidden");
  if (/TREEHOUSE_PACKAGED_PREFLIGHT_ONLY/u.test(job)) fail("the preflight-only switch must not be set in CI");

  // Only the evidence upload may carry an if, and it is exactly always().
  const conditional = steps.filter((step) => /^ {8}if:|^ {6}- if:/mu.test(step));
  if (conditional.length !== 1) fail("exactly one step (the evidence upload) may carry an if");
  for (const step of conditional) {
    if (scalar(step, "if") !== "always()") fail("the only permitted if is always()");
    if (!(scalar(step, "uses") ?? "").startsWith("actions/upload-artifact@"))
      fail("only the upload step may carry an if");
  }

  const index = (predicate) => steps.findIndex(predicate);
  const named = (name) => index((step) => stepName(step) === name);
  const runOf = (step) => scalar(step, "run") ?? "";
  const usesOf = (step) => scalar(step, "uses") ?? "";

  // Actions: same pinned SHAs as packaged_macos.
  for (const action of [
    "actions/checkout",
    "erlef/setup-beam",
    "actions/setup-node",
    "actions/cache",
    "actions/upload-artifact",
  ]) {
    const mine = pinnedUses(job, action);
    if (!mine || !/@[0-9a-f]{40}$/u.test(mine)) fail(`${action} must be pinned to a full commit SHA`);
    else if (action !== "actions/upload-artifact" && macos && mine !== pinnedUses(macos, action))
      fail(`${action} pin must match packaged_macos`);
  }
  const uploadPin = pinnedUses(job, "actions/upload-artifact");
  const releaseUploadPin = macos ? pinnedUses(macos, "actions/upload-artifact") : undefined;
  if (uploadPin !== releaseUploadPin) fail("upload-artifact pin must match packaged_macos");

  const checkoutAt = index((step) => usesOf(step).startsWith("actions/checkout@"));
  const beamAt = index((step) => usesOf(step).startsWith("erlef/setup-beam@"));
  const nodeAt = index((step) => usesOf(step).startsWith("actions/setup-node@"));
  const cacheAt = index((step) => usesOf(step).startsWith("actions/cache@"));
  const depsAt = index((step) => runOf(step) === "env MIX_ENV=test mix deps.get");
  const compileAt = index((step) => runOf(step) === "env MIX_ENV=test mix compile");
  const npmAt = index((step) => /^npm --prefix clients\/lattice-client ci$/mu.test(runOf(step)));
  const buildClientAt = index((step) => /^npm --prefix clients\/lattice-client run build$/mu.test(runOf(step)));
  const preAt = index((step) => stepName(step) === "Assert no ordinary Treehouse app data before the run");
  const buildAt = index((step) => /^npm run tauri:build:dev-trace$/mu.test(runOf(step)));
  const harnessAt = index((step) => /^npm run packaged:enrollment$/mu.test(runOf(step)));
  const postAt = index((step) => stepName(step) === "Assert no ordinary Treehouse app data after the run");
  const uploadAt = index((step) => usesOf(step).startsWith("actions/upload-artifact@"));

  const required = {
    checkoutAt,
    beamAt,
    nodeAt,
    cacheAt,
    depsAt,
    compileAt,
    npmAt,
    buildClientAt,
    preAt,
    buildAt,
    harnessAt,
    postAt,
    uploadAt,
  };
  for (const [key, value] of Object.entries(required)) if (value === -1) fail(`missing step ${key}`);
  const order = Object.values(required);
  if (order.every((value) => value !== -1) && order.some((value, i) => i > 0 && value <= order[i - 1]))
    fail("steps are out of order");
  if (uploadAt !== -1 && uploadAt !== steps.length - 1) fail("the evidence upload must be the last step");

  if (checkoutAt !== -1) {
    if (withKey(steps[checkoutAt], "persist-credentials") !== "false") fail("checkout needs persist-credentials: false");
  }
  if (beamAt !== -1) {
    const step = steps[beamAt];
    if (withKey(step, "otp-version") !== '"28.1"') fail("OTP must be 28.1");
    if (withKey(step, "elixir-version") !== '"1.19.5"') fail("Elixir must be 1.19.5");
  }
  if (nodeAt !== -1) {
    const step = steps[nodeAt];
    if (withKey(step, "node-version") !== '"22"') fail("Node must be 22");
    const lockfiles = step.split("cache-dependency-path:")[1] ?? "";
    for (const lock of [
      "clients/lattice-client/package-lock.json",
      "clients/treehouse-tauri-shell/package-lock.json",
    ])
      if (!lockfiles.includes(lock)) fail(`Node cache must cover ${lock}`);
  }
  if (cacheAt !== -1) {
    const step = steps[cacheAt];
    const key = /^ {10}key:\s*(.*)$/mu.exec(step)?.[1] ?? "";
    for (const source of [
      "clients/treehouse-tauri-shell/src-tauri/Cargo.lock",
      "clients/treehouse-tauri-shell/src-tauri/src/**/*.rs",
      "clients/treehouse-tauri-shell/src/**",
    ])
      if (!key.includes(source)) fail(`cargo cache key must hash ${source}`);
    if (!step.includes("clients/treehouse-tauri-shell/src-tauri/target")) fail("cargo cache must cover the Treehouse target");
  }
  if (npmAt !== -1) {
    const run = runOf(steps[npmAt]);
    for (const line of ["npm --prefix clients/lattice-client ci", "npm --prefix clients/treehouse-tauri-shell ci"])
      if (!run.split("\n").includes(line)) fail(`install step must run: ${line}`);
  }

  for (const [at, label] of [
    [preAt, "pre"],
    [postAt, "post"],
  ]) {
    if (at === -1) continue;
    const run = runOf(steps[at]);
    if (!run.includes(REAL_DATA) || !/test ! -e/u.test(run)) fail(`${label} check must assert the real app data dir is absent`);
  }

  // The variant build: fresh, flags, feature, overlay, in the Treehouse shell.
  if (buildAt !== -1) {
    const step = steps[buildAt];
    if (scalar(step, "working-directory") !== SHELL_DIR) fail("the variant build runs in the Treehouse shell");
    const expanded = expandRun(runOf(step), pkg.scripts ?? {});
    for (const needle of [
      "VITE_TREEHOUSE_ENROLLMENT=1",
      "VITE_TREEHOUSE_DEV_TRACE=1",
      "VITE_TREEHOUSE_AUTOSYNC_ON_MOUNT=0",
      "VITE_TREEHOUSE_POLL_MS=0",
      "tauri build",
      "--features treehouse-dev-trace",
      "--bundles app",
      "--config src-tauri/tauri.dev-trace.conf.json",
    ])
      if (!expanded.includes(needle)) fail(`variant build lacks ${needle}`);
    if (!runOf(step).includes(BUILD_STEP_CALL)) fail("variant build must be the tauri:build:dev-trace script");
  }

  // The harness: real harness script, oracle inside it, evidence dir, no switches.
  if (harnessAt !== -1) {
    const step = steps[harnessAt];
    if (scalar(step, "working-directory") !== SHELL_DIR) fail("the harness runs in the Treehouse shell");
    const keys = envKeys(step);
    if (!keys.includes("TREEHOUSE_EVIDENCE_DIR")) fail("the harness step must set TREEHOUSE_EVIDENCE_DIR");
    const evidence = /^ {10}TREEHOUSE_EVIDENCE_DIR:\s*(.*)$/mu.exec(step)?.[1]?.trim();
    if (evidence !== EVIDENCE_DIR) fail("the evidence directory must be under runner.temp");
    for (const key of keys) if (/skip|only|keep/iu.test(key)) fail(`harness env ${key} is a skip or debug switch`);
    if (pkg.scripts?.["packaged:enrollment"] !== "tsx test/packaged_enrollment.ts")
      fail("packaged:enrollment must run test/packaged_enrollment.ts");
  }
  if (typeof harnessSource === "string") {
    if (!harnessSource.includes("treehouse_enrollment_oracle.exs") || !harnessSource.includes("ORACLE_OK"))
      fail("the harness must run the Lattice.Sim oracle and require ORACLE_OK");
    if (!/process\.exit\(1\)/u.test(harnessSource)) fail("the harness must exit non-zero on failure");
  }

  // Public evidence only: the two oracle and result JSON files, nothing else.
  if (uploadAt !== -1) {
    const step = steps[uploadAt];
    const path = step.split("path:")[1] ?? "";
    const entries = path
      .split("\n")
      .map((line) => line.trim())
      .filter((line, i) => i === 0 ? line !== "" && line !== "|" : line !== "");
    const listed = entries.map((line) => line.replace(/^\|\s*/u, "")).filter(Boolean);
    const expected = [`${EVIDENCE_DIR}/oracle_out.json`, `${EVIDENCE_DIR}/result.json`];
    const stop = listed.findIndex((line) => /^[a-z-]+:/u.test(line));
    const paths = stop === -1 ? listed : listed.slice(0, stop);
    if (JSON.stringify([...paths].sort()) !== JSON.stringify([...expected].sort()))
      fail("the upload may carry only oracle_out.json and result.json");
    if (withKey(step, "if-no-files-found") !== "error") fail("missing evidence must fail the upload");
  }

  return problems;
}

const workflow = readFileSync(resolve(repoRoot, ".github/workflows/flagship.yml"), "utf8");
const pkg = JSON.parse(readFileSync(resolve(shellRoot, "package.json"), "utf8"));
const harnessSource = readFileSync(resolve(shellRoot, "test/packaged_enrollment.ts"), "utf8");

function mutate(source, from, to) {
  assert.ok(source.includes(from), `mutation anchor not found: ${JSON.stringify(from)}`);
  return source.replace(from, to);
}

function mutateJob(text, fn) {
  const job = findJob(text, JOB);
  assert.ok(job, "the job must exist to mutate it");
  return text.replace(job, fn(job));
}

test("the committed workflow satisfies the enrollment job contract", () => {
  assert.deepEqual(check(workflow, pkg, harnessSource), []);
});

test("the job is a sibling of packaged_macos and a distinct job", () => {
  const names = jobBlocks(workflow).map(jobName);
  assert.ok(names.includes("packaged_macos"));
  assert.equal(names.filter((name) => name === JOB).length, 1);
});

const mutations = {
  "job removed": (text) => text.replace(findJob(text, JOB) ?? "", ""),
  "wrong runner": (text) => mutateJob(text, (job) => mutate(job, "macos-15-intel", "macos-latest")),
  "no timeout": (text) => mutateJob(text, (job) => job.replace(/^ {4}timeout-minutes:.*\n/mu, "")),
  "unbounded timeout": (text) =>
    mutateJob(text, (job) => job.replace(/^( {4}timeout-minutes:).*$/mu, "$1 360")),
  "job continue-on-error true": (text) =>
    mutateJob(text, (job) => mutate(job, "    runs-on:", "    continue-on-error: true\n    runs-on:")),
  "step continue-on-error always": (text) =>
    mutateJob(text, (job) =>
      mutate(job, "        run: npm run packaged:enrollment", "        continue-on-error: ${{ always() }}\n        run: npm run packaged:enrollment"),
    ),
  "job if": (text) =>
    mutateJob(text, (job) => mutate(job, "    runs-on:", "    if: github.ref == 'refs/heads/main'\n    runs-on:")),
  "harness masked with || true": (text) =>
    mutateJob(text, (job) => mutate(job, "run: npm run packaged:enrollment", "run: npm run packaged:enrollment || true")),
  "harness masked with set +e": (text) =>
    mutateJob(text, (job) =>
      mutate(job, "run: npm run packaged:enrollment", "run: |\n          set +e\n          npm run packaged:enrollment"),
    ),
  "harness if false": (text) =>
    mutateJob(text, (job) =>
      mutate(job, "        run: npm run packaged:enrollment", "        if: false\n        run: npm run packaged:enrollment"),
    ),
  "harness if expression false": (text) =>
    mutateJob(text, (job) =>
      mutate(job, "        run: npm run packaged:enrollment", "        if: ${{ false }}\n        run: npm run packaged:enrollment"),
    ),
  "build step conditional": (text) =>
    mutateJob(text, (job) =>
      mutate(job, "        run: npm run tauri:build:dev-trace", "        if: runner.os == 'macOS'\n        run: npm run tauri:build:dev-trace"),
    ),
  "skip env var": (text) =>
    mutateJob(text, (job) =>
      mutate(job, "          TREEHOUSE_EVIDENCE_DIR:", "          TREEHOUSE_SKIP_PACKAGED: \"1\"\n          TREEHOUSE_EVIDENCE_DIR:"),
    ),
  "preflight-only env": (text) =>
    mutateJob(text, (job) =>
      mutate(job, "          TREEHOUSE_EVIDENCE_DIR:", "          TREEHOUSE_PACKAGED_PREFLIGHT_ONLY: \"1\"\n          TREEHOUSE_EVIDENCE_DIR:"),
    ),
  "harness step removed": (text) =>
    mutateJob(text, (job) => mutate(job, "run: npm run packaged:enrollment", "run: echo packaged:enrollment")),
  "upload not always": (text) =>
    mutateJob(text, (job) => mutate(job, "        if: always()\n", "")),
  "upload on success only": (text) =>
    mutateJob(text, (job) => mutate(job, "        if: always()\n", "        if: success()\n")),
  "upload wildcard evidence": (text) =>
    mutateJob(text, (job) => mutate(job, `${EVIDENCE_DIR}/result.json`, `${EVIDENCE_DIR}/`)),
  "upload carries stores": (text) =>
    mutateJob(text, (job) => mutate(job, `${EVIDENCE_DIR}/result.json`, `${EVIDENCE_DIR}/result.json\n            \${{ runner.temp }}/data-founder/treehouse-v1.sqlite3`)),
  "upload tolerates missing evidence": (text) =>
    mutateJob(text, (job) => mutate(job, "if-no-files-found: error", "if-no-files-found: warn")),
  "mobile core pulled in": (text) =>
    mutateJob(text, (job) =>
      mutate(job, "          npm --prefix clients/treehouse-tauri-shell ci", "          npm --prefix clients/lattice-mobile-core ci\n          npm --prefix clients/treehouse-tauri-shell ci"),
    ),
  "checkout keeps credentials": (text) =>
    mutateJob(text, (job) => mutate(job, "persist-credentials: false", "persist-credentials: true")),
  "action pinned by tag": (text) =>
    mutateJob(text, (job) => job.replace(/actions\/checkout@[0-9a-f]{40} # v4/u, "actions/checkout@v4")),
  "action pin differs from packaged_macos": (text) =>
    mutateJob(text, (job) => job.replace(/(erlef\/setup-beam@)[0-9a-f]{40}/u, "$1" + "0".repeat(40))),
  "wrong otp": (text) => mutateJob(text, (job) => mutate(job, 'otp-version: "28.1"', 'otp-version: "27.0"')),
  "compile without env prefix": (text) =>
    mutateJob(text, (job) => mutate(job, "run: env MIX_ENV=test mix compile", "run: mix compile")),
  "cache key ignores shell sources": (text) =>
    mutateJob(text, (job) => mutate(job, "'clients/treehouse-tauri-shell/src/**', ", "")),
  "pre-check removed": (text) =>
    mutateJob(text, (job) => mutate(job, "Assert no ordinary Treehouse app data before the run", "Some other step")),
  "pre-check not asserting": (text) =>
    mutateJob(text, (job) => mutate(job, "run: test ! -e", "run: test -e")),
  "post-check not asserting": (text) =>
    mutateJob(text, (job) => {
      const at = job.lastIndexOf("run: test ! -e");
      assert.ok(at > job.indexOf("run: test ! -e"), "the post-check anchor must be the second occurrence");
      return `${job.slice(0, at)}run: true #${job.slice(at + "run: test ! -e".length)}`;
    }),
  "classification step removed": (text) =>
    text.replace(
      stepBlocks(findJob(text, "packaged_macos")).find((step) => stepName(step) === CLASSIFY_STEP) ?? "",
      "",
    ),
  "classification asserts dev_trace": (text) =>
    mutate(text, "Treehouse.app ordinary", "Treehouse.app dev_trace"),
  "classification masked": (text) =>
    mutate(text, "Treehouse.app ordinary", "Treehouse.app ordinary || true"),
  "packaged_macos step body edited": (text) =>
    mutate(text, "run: npm run packaged\n", "run: npm run packaged -- --skip\n"),
  "android_pilot needs extended": (text) =>
    mutate(text, "      - android_pilot_verify\n    runs-on: ubuntu-latest\n    timeout-minutes: 90\n    environment: android-pilot", `      - android_pilot_verify\n      - ${JOB}\n    runs-on: ubuntu-latest\n    timeout-minutes: 90\n    environment: android-pilot`),
};

for (const [name, apply] of Object.entries(mutations)) {
  test(`mutation fails the contract: ${name}`, () => {
    const mutated = apply(workflow);
    assert.notEqual(mutated, workflow, "the mutation must change the workflow");
    assert.notDeepEqual(check(mutated, pkg, harnessSource), [], `contract accepted: ${name}`);
  });
}

const packageMutations = {
  "feature flag dropped from the build script": (p) => ({
    ...p,
    scripts: { ...p.scripts, "tauri:build:dev-trace": p.scripts["tauri:build:dev-trace"].replace("--features treehouse-dev-trace ", "") },
  }),
  "poll flag dropped from the build script": (p) => ({
    ...p,
    scripts: { ...p.scripts, "tauri:build:dev-trace": p.scripts["tauri:build:dev-trace"].replace("VITE_TREEHOUSE_POLL_MS=0 ", "") },
  }),
  "enrollment flag dropped from the build script": (p) => ({
    ...p,
    scripts: { ...p.scripts, "tauri:build:dev-trace": p.scripts["tauri:build:dev-trace"].replace("VITE_TREEHOUSE_ENROLLMENT=1 ", "") },
  }),
  "overlay dropped from the build script": (p) => ({
    ...p,
    scripts: { ...p.scripts, "tauri:build:dev-trace": p.scripts["tauri:build:dev-trace"].replace(" --config src-tauri/tauri.dev-trace.conf.json", "") },
  }),
  "harness script repointed": (p) => ({
    ...p,
    scripts: { ...p.scripts, "packaged:enrollment": "tsx test/packaged_preview.ts" },
  }),
};

for (const [name, apply] of Object.entries(packageMutations)) {
  test(`package mutation fails the contract: ${name}`, () => {
    assert.notDeepEqual(check(workflow, apply(pkg), harnessSource), [], `contract accepted: ${name}`);
  });
}

test("a harness without the oracle or a failing exit fails the contract", () => {
  assert.notDeepEqual(check(workflow, pkg, harnessSource.replaceAll("treehouse_enrollment_oracle.exs", "x.exs")), []);
  assert.notDeepEqual(check(workflow, pkg, harnessSource.replaceAll("process.exit(1)", "process.exit(0)")), []);
});

test("the pinned packaged_macos digest is a real sha256", () => {
  assert.match(PACKAGED_MACOS_DIGEST, /^[0-9a-f]{64}$/u);
});
