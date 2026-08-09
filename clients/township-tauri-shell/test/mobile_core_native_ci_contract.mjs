import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const shellRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const repoRoot = resolve(shellRoot, "..", "..");

function jobBlocks(workflow) {
  const jobsStart = workflow.indexOf("\njobs:\n");
  if (jobsStart === -1) return [];
  const jobsSection = workflow.slice(jobsStart + "\njobs:\n".length);
  const jobs =
    jobsSection.match(/^  [a-zA-Z0-9_-]+:\n(?:^(?!  [a-zA-Z0-9_-]+:)[^\n]*\n?)*/gm) ?? [];
  return jobs;
}

function stepBlocks(job) {
  return job.match(/^      - (?:[^\n]*\n)(?:^(?!      - )[^\n]*\n?)*/gm) ?? [];
}

function scalar(block, key, indent = 8) {
  const ordinary = block.match(new RegExp(`^ {${indent}}${key}:\\s*(.*)$`, "m"));
  const firstStepKey =
    indent === 8 ? block.match(new RegExp(`^ {6}- ${key}:\\s*(.*)$`, "m")) : undefined;
  const match = ordinary ?? firstStepKey;
  if (!match) return undefined;

  const value = match[1].trim();
  if (!/^\|[-+]?$/u.test(value)) return value;

  const blockLines = block.slice((match.index ?? 0) + match[0].length).split("\n");
  return blockLines
    .filter((line) => line.startsWith(" ".repeat(indent + 2)))
    .map((line) => line.slice(indent + 2).trim())
    .filter(Boolean)
    .join("\n");
}

function normalizedPath(value) {
  return value?.replace(/^\.\//u, "").replace(/\/+$/u, "");
}

function fullNativeCargoTest(command) {
  const tokens = command.trim().split(/\s+/u);
  if (tokens[0] !== "cargo" || tokens[1] !== "test") return undefined;

  let manifestPath;
  for (let index = 2; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (["--locked", "--all-features"].includes(token)) continue;
    if (token === "--manifest-path") {
      manifestPath = tokens[index + 1];
      index += 1;
      if (!manifestPath) return undefined;
      continue;
    }
    if (token.startsWith("--manifest-path=")) {
      manifestPath = token.slice("--manifest-path=".length);
      continue;
    }
    return undefined;
  }

  return { manifestPath: normalizedPath(manifestPath) };
}

function nativeTestSteps(workflow) {
  return jobBlocks(workflow)
    .flatMap((job) =>
      stepBlocks(job).flatMap((step) =>
        (scalar(step, "run") ?? "")
          .split("\n")
          .map((run) => ({ job, step, run, cargo: fullNativeCargoTest(run) }))
          .filter(({ cargo }) => cargo !== undefined),
      ),
    )
    .filter(({ step, cargo }) => {
      const nativeWorkingDirectory =
        normalizedPath(scalar(step, "working-directory")) ===
        "clients/lattice-mobile-core/native";
      const explicitManifest =
        cargo.manifestPath === "clients/lattice-mobile-core/native/Cargo.toml";
      return nativeWorkingDirectory || explicitManifest;
    });
}

function blockingValue(value) {
  return value === undefined || value === "false";
}

function requiredStep({ job, step }) {
  return (
    scalar(step, "if") === undefined &&
    blockingValue(scalar(step, "continue-on-error")) &&
    scalar(job, "if", 4) === undefined &&
    blockingValue(scalar(job, "continue-on-error", 4))
  );
}

test("native-suite step detection rejects empty and non-blocking substitutes", () => {
  const required = `name: fixture

jobs:
  unit:
    runs-on: ubuntu-latest
    steps:
      - name: Native matrix
        env:
          CARGO_TERM_COLOR: always
        run: cargo test --locked --manifest-path clients/lattice-mobile-core/native/Cargo.toml
        working-directory: .
`;
  const compileOnly = required.replace("cargo test --locked", "cargo test --no-run --locked");
  const libOnly = required.replace("cargo test --locked", "cargo test --lib --locked");
  const allTargets = required.replace("cargo test --locked", "cargo test --all-targets --locked");
  const filtered = required.replace("Cargo.toml", "Cargo.toml nothing");
  const conditional = required.replace(
    "        env:",
    "        if: \\${{ false }}\n        env:",
  );
  const nonBlockingStep = required.replace(
    "        env:",
    "        continue-on-error: \\${{ always() }}\n        env:",
  );
  const nonBlockingJob = required.replace(
    "    runs-on:",
    "    continue-on-error: true\n    runs-on:",
  );

  assert.equal(nativeTestSteps(required).filter(requiredStep).length, 1);
  assert.equal(nativeTestSteps(compileOnly).length, 0);
  assert.equal(nativeTestSteps(libOnly).length, 0);
  assert.equal(nativeTestSteps(allTargets).length, 0);
  assert.equal(nativeTestSteps(filtered).length, 0);
  assert.equal(nativeTestSteps(conditional).filter(requiredStep).length, 0);
  assert.equal(nativeTestSteps(nonBlockingStep).filter(requiredStep).length, 0);
  assert.equal(nativeTestSteps(nonBlockingJob).filter(requiredStep).length, 0);
});

test("flagship executes the lattice-mobile-core native contract suite unconditionally", () => {
  const workflow = readFileSync(resolve(repoRoot, ".github/workflows/flagship.yml"), "utf8");
  const nativeStep = nativeTestSteps(workflow).find(requiredStep);

  assert.ok(
    nativeStep,
    "flagship must unconditionally execute a blocking, full cargo test of lattice-mobile-core/native using a single-line command or YAML run block",
  );

  const migrationMatrix = readFileSync(
    resolve(repoRoot, "clients/lattice-mobile-core/native/tests/migration_matrix.rs"),
    "utf8",
  );
  const executableContracts = migrationMatrix.match(/^#\[test\]$/gmu) ?? [];
  assert.ok(
    executableContracts.length >= 10,
    "the mandatory native step must retain a substantive migration-matrix test target",
  );
  assert.doesNotMatch(
    migrationMatrix,
    /^#\[ignore(?:\([^\n]*\))?\]$/gmu,
    "migration-matrix contracts must not be ignored by the mandatory cargo test step",
  );
});
