import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Plan 181 slice 5c2: structural contract for the hard-failing packaged enrollment job.
//
// The workflow is parsed into job and step blocks (no yaml dependency in this shell, as in the Township
// precedent mobile_core_native_ci_contract.mjs). `check` returns a list of violations for a workflow text
// and a package.json object, and every mutation fixture below must make it return a non-empty list. A text
// check alone is not feasibility proof: the hosted job still has to finish green.
//
// Re-pinned for plan 183 on 2026-10-08 (product-scoped CI). Every pin below stayed exact; none was deleted or
// loosened. What moved, and why:
// - The five ordinary Treehouse preview steps (build, ordinary-bundle classification, restart, replay, upload)
//   moved out of packaged_macos into a new sibling job, treehouse_packaged_macos, so Township-only changes
//   skip them. The classification-step checks, the ordering after the ordinary build and the upload-artifact
//   pin now read that job. packaged_macos is pinned by digest over all its remaining step bodies, and the
//   moved bodies (plus the setup steps copied with them) stay pinned by a second digest, so no step body that
//   was pinned before is unpinned now.
// - This job now carries exactly the treehouse product gate and needs exactly the changes classifier, instead
//   of having no job-level if.
// - android_pilot.needs gains the changes classifier. The enrollment job is still not a distribution
//   dependency: exactly one other job, the required fan-in, may reference it.
//
// Re-pinned for plan 186 on 2026-10-17 (shared shell kit). Every pin below stayed exact; none was deleted or
// loosened. What moved, and why:
// - The packaged:enrollment script pin is now exactly `tsx --preserve-symlinks test/packaged_enrollment.ts`,
//   because the harness imports the relay client and sync, which now live in clients/lattice-shell-kit, and a
//   kit module resolves its lattice-client peer only through the shell's node_modules under
//   --preserve-symlinks (decision D-15, row 221). No workflow step body changed, so both digests are unchanged.

// Re-pinned for row 201 on 2026-10-18 (frontend variant classification). Every pin below stayed exact; none was
// deleted or loosened. What moved, and why:
// - assert_bundle_variant.ts now takes a required third argument, the built frontend dist, and asserts the
//   executable variant and the paired frontend variant together. The ordinary classification step is pinned
//   with that dist argument; it is excluded from TREEHOUSE_PREVIEW_DIGEST, so that digest is unchanged.
// - The enrollment job gains a "Classify Treehouse dev-trace bundle" step between the dev-trace build and the
//   harness. That job carries no digest pin, so no digest moved; the step is pinned structurally instead.
// - New: no VITE_TREEHOUSE_* key may appear anywhere in flagship.yml (workflow, job, step env or run lines),
//   and VITE_TREEHOUSE_ENROLLMENT / VITE_TREEHOUSE_DEV_TRACE may appear in package.json only in the
//   tauri:build:dev-trace script. Neither pinned workflow digest moved.

// Re-pinned for row 228 on 2026-10-18 (setup-step network retries). Every pin below stayed exact; none was
// deleted or loosened. What moved, and why:
// - Every erlef/setup-beam step now sets install-hex and install-rebar to false and is followed by one new
//   run step, "Install Hex and Rebar", that runs mix local.hex and mix local.rebar with a bounded four-attempt
//   retry. setup-beam ran them once, and a 60 s timeout reaching builds.hex.pm failed whole jobs. Both
//   packaged_macos and treehouse_packaged_macos gained those lines, so PACKAGED_MACOS_DIGEST moved from
//   0b2ccbc32d2e01785653ff3a7952b8bb09710dd9b7242710c0ab1d899ef5c085 and TREEHOUSE_PREVIEW_DIGEST from
//   032cc785f32d8f3dd7af93a8e2e0d2c97445795f3becbb8292079899d4b04d4d. Both new values were recomputed by this
//   file's own functions and the old values reproduce from the previous workflow text, so no other step body moved.
// - The enrollment job needed no pin change: its setup-beam checks (versions, order, no continue-on-error, no
//   masking, exactly one if) all still hold with the extra step in place.

// Re-pinned for row 236 on 2026-10-19 (packaged Space frames export). Every pin below stayed exact; none was
// deleted or loosened. What moved, and why:
// - treehouse_packaged_macos gains one step, "Export Space frames from the packaged app and verify with the
//   ceremony reader", between the frame replay and the evidence upload. It reuses the retained app data and
//   key from the preview run. Like the classification step it is excluded from TREEHOUSE_PREVIEW_DIGEST and
//   pinned structurally instead: exactly one such step, its position, run, working directory, exact env, and
//   no if, continue-on-error or masking, its own keys are exactly name, working-directory, env and run, and the
//   whole step body equals the pinned text (quoted YAML keys would pass the line checks).
// - The packaged:export script pin is exactly `tsx --preserve-symlinks test/packaged_export.ts`.
// - No other step body changed, so PACKAGED_MACOS_DIGEST and TREEHOUSE_PREVIEW_DIGEST are both unchanged.

// Re-pinned for row 238 on 2026-10-31 (quoted YAML skip keys). Every pin below stayed exact; none was
// deleted or loosened. What moved, and why:
// - The ordinary classification step and the enrollment job's dev-trace classification step are now
//   pinned as exact text, as the Space export was in row 236, so a quoted `'if': false` or
//   `"continue-on-error": true` cannot ride along. Their own keys are exactly name, working-directory
//   and run. The same quoted-key scan is applied to the export step so updating the pin and the
//   workflow together cannot smuggle a skip key.
// - The enrollment job's step `if` scan now reads quoted YAML keys (after the same escape decode the
//   variant-flag scan uses, including escaped line breaks), so `'if'` / `"if"` / `"i\\u0066"` /
//   `"i\\\n f"` count as `if`. Block-scalar keys with indent indicators (`? |2-`) and tags
//   (`? !!str |-`) count too. continue-on-error remains forbidden in any spelling. Own-key
//   comparison reads those explicit names, so updating a pin constant and the workflow together
//   cannot add a block-scalar `shell`. No workflow step body changed, so both digests are unchanged.

const shellRoot = dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
const repoRoot = resolve(shellRoot, "..", "..");

const JOB = "treehouse_packaged_macos_enrollment";
const PREVIEW_JOB = "treehouse_packaged_macos";
const ENROLLMENT_GATE = "needs.changes.outputs.treehouse == 'true'";
const SHELL_DIR = "clients/treehouse-tauri-shell";
const CLASSIFY_STEP = "Classify ordinary Treehouse bundle";
const REPLAY_STEP = "Independently replay exact packaged Treehouse frames";
const EXPORT_STEP = "Export Space frames from the packaged app and verify with the ceremony reader";
const PREVIEW_UPLOAD_STEP = "Upload public Treehouse preview evidence";
const EXPORT_RUN = "npm run packaged:export";
const CLASSIFY_CALL =
  "npx --no-install tsx test/assert_bundle_variant.ts src-tauri/target/release/bundle/macos/Treehouse.app";
const ORDINARY_CLASSIFY_RUN = `${CLASSIFY_CALL} ordinary dist`;
const DEV_TRACE_CLASSIFY_RUN = `${CLASSIFY_CALL} dev_trace dist`;
const CLASSIFY_STEP_KEYS = ["name", "working-directory", "run"];
const CLASSIFY_STEP_BODY = [
  `      - name: ${CLASSIFY_STEP}`,
  `        working-directory: ${SHELL_DIR}`,
  `        run: ${ORDINARY_CLASSIFY_RUN}`,
  "",
].join("\n");
const CLASSIFY_DEV_TRACE_STEP = "Classify Treehouse dev-trace bundle";
const CLASSIFY_DEV_TRACE_STEP_BODY = [
  `      - name: ${CLASSIFY_DEV_TRACE_STEP}`,
  `        working-directory: ${SHELL_DIR}`,
  `        run: ${DEV_TRACE_CLASSIFY_RUN}`,
  "",
].join("\n");
const EXPORT_STEP_BODY = [
  "      - name: Export Space frames from the packaged app and verify with the ceremony reader",
  "        working-directory: clients/treehouse-tauri-shell",
  "        env:",
  "          TREEHOUSE_EVIDENCE_DIR: ${{ runner.temp }}/treehouse-preview/space-export",
  "          MIX_ENV: test",
  "        run: npm run packaged:export",
  "",
].join("\n");
const EXPORT_ENV = [
  ["TREEHOUSE_EVIDENCE_DIR", "${{ runner.temp }}/treehouse-preview/space-export"],
  ["MIX_ENV", "test"],
];
const EXPORT_SCRIPT = "tsx --preserve-symlinks test/packaged_export.ts";
const VARIANT_FLAGS = ["VITE_TREEHOUSE_ENROLLMENT", "VITE_TREEHOUSE_DEV_TRACE"];
const BUILD_STEP_CALL = "npm run tauri:build:dev-trace";
const EVIDENCE_DIR = "${{ runner.temp }}/treehouse-enrollment";
const REAL_DATA = "dev.treetop.lattice.treehouse";

// Digest of every packaged_macos step body. These bodies are operator-reviewed and pinned.
// Re-pinned for plan 183 on 2026-10-08: the Treehouse preview steps (and the classification step) left this job,
// so the digest now covers the Township smokes and their setup only. It was a7457cfa3c27586c… before the move.
const PACKAGED_MACOS_DIGEST = "0210087e513128d0a0db75e9fd0225515666183479a1d2424b63b7493f6e497b";

// Digest of every treehouse_packaged_macos step body except the classification and Space export steps, which
// are checked structurally below. Added for plan 183 on 2026-10-08 so the moved preview bodies stay pinned
// exactly as they were while they lived in packaged_macos (the old digest covered them).
const TREEHOUSE_PREVIEW_DIGEST = "dc7e02d0255fb2d32dc53455ca0888df10fca7cec499e38b2e5e1f0cce76c4df";

// Re-pinned for plan 183 on 2026-10-08: android_pilot also needs the changes classifier, whose output its
// township gate reads. The list is exact and in workflow order.
const ANDROID_PILOT_NEEDS = ["verify", "unit", "packaged_macos", "android_pilot_verify", "changes"];

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

/** Every entry of the job-level `permissions:` mapping, blank lines and comments skipped; null when absent. */
function permissions(header) {
  const at = header.search(/^ {4}permissions:/mu);
  if (at === -1) return null;
  const [first, ...rest] = header.slice(at).split("\n");
  const inline = first.replace(/^ {4}permissions:/u, "").trim();
  if (inline !== "") return [inline];
  const entries = [];
  for (const line of rest) {
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    if (!line.startsWith("      ")) break;
    entries.push(line.trim());
  }
  return entries;
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

/** Every step env entry as [key, value], in order. */
function envEntries(step) {
  const at = step.search(/^ {8}env:\s*$/m);
  if (at === -1) return [];
  const entries = [];
  for (const line of step.slice(at).split("\n").slice(1)) {
    if (line.trim() === "") continue;
    if (!line.startsWith(" ".repeat(10))) break;
    const entry = /^ {10}([^:\s]+):\s*(.*)$/u.exec(line);
    entries.push(entry ? [entry[1], entry[2].trim()] : [line.trim(), undefined]);
  }
  return entries;
}

function decodeYamlEscapes(text) {
  // Strip comments first so a quote or trailing `\` in a comment cannot start a fake
  // double-quoted scalar that swallows the next line's real key. Then fold `\`+linebreak
  // only inside remaining double-quoted scalars, then hex/Unicode.
  const uncommented = text.split("\n").map(stripYamlComment).join("\n");
  const folded = uncommented.replace(/"(?:[^"\\]|\\[\s\S])*"/gu, (scalar) =>
    scalar.replace(/\\(?:\r\n|\r|\n)[ \t]*/gu, ""),
  );
  return folded.replace(/\\(?:x([0-9A-Fa-f]{2})|u([0-9A-Fa-f]{4})|U([0-9A-Fa-f]{8}))/gu, (_m, x, u, U) =>
    String.fromCodePoint(Number.parseInt(x ?? u ?? U, 16)),
  );
}

const YAML_MAPPING_KEY = String.raw`(?:'([^']+)'|"([^"]+)"|([A-Za-z0-9_-]+))`;
const YAML_DECORATORS = String.raw`(?:(?:!!?\S+|&[A-Za-z0-9_-]+)[ \t]+)*`;
const YAML_BLOCK_HEADER = String.raw`[|>][0-9+-]*`;

function stripYamlComment(line) {
  return line.replace(/[ \t]+#.*$/u, "");
}

function stripYamlDecorators(text) {
  let out = text.trim();
  for (;;) {
    const next = out.replace(/^(?:!!?\S+|&[A-Za-z0-9_-]+)[ \t]*/u, "").trim();
    if (next === out) return next;
    out = next;
  }
}

function firstExplicitName(lines, start) {
  for (let j = start; j < lines.length; j++) {
    const content = stripYamlDecorators(stripYamlComment(lines[j]));
    if (content === "") continue;
    if (new RegExp(`^${YAML_BLOCK_HEADER}$`, "u").test(content)) continue;
    const named = new RegExp(`^${YAML_MAPPING_KEY}`, "u").exec(content);
    return named ? (named[1] ?? named[2] ?? named[3]) : content.replace(/^['"]|['"]$/gu, "");
  }
  return undefined;
}

function parseExplicitKey(line) {
  const m = /^\s*(?:-\s+)?\?[ \t]*(.*)$/u.exec(line);
  if (!m) return undefined;
  const body = stripYamlDecorators(m[1]);
  if (body === "" || new RegExp(`^${YAML_BLOCK_HEADER}$`, "u").test(body)) return { kind: "lookAhead" };
  const named = new RegExp(`^${YAML_MAPPING_KEY}(?:[ \\t]+|:|$)`, "u").exec(body);
  if (named) return { kind: "named", name: named[1] ?? named[2] ?? named[3] };
  return { kind: "lookAhead" };
}

function mappingKeys(block, indent, dashed) {
  const decoded = decodeYamlEscapes(block);
  const prefix = dashed ? ` {${indent}}- ` : ` {${indent}}`;
  const keys = [...decoded.matchAll(new RegExp(`^${prefix}${YAML_DECORATORS}${YAML_MAPPING_KEY}[ \\t]*:`, "gmu"))].map(
    (m) => m[1] ?? m[2] ?? m[3],
  );
  const atIndent = new RegExp(`^${prefix}\\?`, "u");
  const lines = decoded.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = stripYamlComment(lines[i]);
    if (!atIndent.test(line)) continue;
    const parsed = parseExplicitKey(line);
    if (parsed?.kind === "named") keys.push(parsed.name);
    else if (parsed?.kind === "lookAhead") {
      const name = firstExplicitName(lines, i + 1);
      if (name !== undefined) keys.push(name);
    }
  }
  return keys;
}

function stepOwnKeys(step) {
  return [...mappingKeys(step, 6, true), ...mappingKeys(step, 8, false)];
}

function headerOwnKeys(header) {
  return mappingKeys(header, 4, false);
}

function unquotedStepKeys(step) {
  return [...step.matchAll(/^ {6}- ([a-z-]+):|^ {8}([a-z-]+):/gmu)].map((m) => m[1] ?? m[2]);
}

function countYamlKey(block, name) {
  const decoded = decodeYamlEscapes(block);
  const quoted = String.raw`(?:'${name}'|"${name}"|${name})`;
  let n = 0;
  const lines = decoded.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = stripYamlComment(lines[i]);
    const parsed = parseExplicitKey(line);
    if (parsed) {
      if (parsed.kind === "named" && parsed.name === name) n += 1;
      else if (parsed.kind === "lookAhead" && firstExplicitName(lines, i + 1) === name) n += 1;
      continue;
    }
    n += [...line.matchAll(new RegExp(`(?:^|[{,\\s])${YAML_DECORATORS}${quoted}[ \\t]*:`, "gu"))].length;
  }
  return n;
}

function hasSkipKey(step) {
  return countYamlKey(step, "if") > 0 || countYamlKey(step, "continue-on-error") > 0;
}

function exactStepBody(step) {
  return step.replace(/\s+$/u, "\n");
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
  return sha(stepBlocks(job).join(""));
}

function previewDigest(workflow) {
  const job = findJob(workflow, PREVIEW_JOB);
  if (!job) return undefined;
  const bodies = stepBlocks(job).filter((step) => ![CLASSIFY_STEP, EXPORT_STEP].includes(stepName(step)));
  return sha(bodies.join(""));
}

/** The job-level needs as a list, for the block-list, flow-list and single-name spellings. */
function needsOf(job) {
  const block = /^ {4}needs:\n((?: {6}- .*\n)+)/mu.exec(job);
  if (block) return [...block[1].matchAll(/- (\S+)/gu)].map((m) => m[1]);
  const flow = /^ {4}needs:\s*\[([^\]]*)\]\s*$/mu.exec(job);
  if (flow) return flow[1].split(",").map((name) => name.trim()).filter(Boolean);
  const single = /^ {4}needs:\s*([A-Za-z0-9_-]+)\s*$/mu.exec(job);
  return single ? [single[1]] : [];
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

  // Row 201: the variant flags are set only by the tauri:build:dev-trace package script. No VITE_TREEHOUSE_*
  // key may appear in any non-comment workflow line (workflow, job or step env, or an inline run).
  // YAML double-quoted escapes are decoded first, so an escaped key cannot spell a flag past the scan.
  const decoded = decodeYamlEscapes(workflow);
  const flagLine = decoded.split("\n").find((line) => !line.trim().startsWith("#") && /VITE_TREEHOUSE_/u.test(line));
  if (flagLine !== undefined) fail(`flagship.yml must not set any VITE_TREEHOUSE_* key: ${flagLine.trim()}`);
  for (const [script, body] of Object.entries(pkg.scripts ?? {}))
    if (script !== "tauri:build:dev-trace" && VARIANT_FLAGS.some((flag) => String(body).includes(flag)))
      fail(`package script ${script} must not set a Treehouse variant flag`);

  const job = findJob(workflow, JOB);
  const macos = findJob(workflow, "packaged_macos");
  const preview = findJob(workflow, PREVIEW_JOB);
  if (!job) {
    fail(`job ${JOB} is missing`);
  }
  if (!macos) fail("job packaged_macos is missing");
  if (!preview) fail(`job ${PREVIEW_JOB} is missing`);

  // packaged_macos keeps the Township smokes only: every remaining step body is pinned by digest.
  if (macos && packagedMacosDigest(workflow) !== PACKAGED_MACOS_DIGEST)
    fail("packaged_macos step bodies changed");

  // The ordinary Treehouse preview job: add-only classification step, every other body pinned by digest.
  if (preview) {
    const steps = stepBlocks(preview);
    const names = steps.map(stepName);
    const buildAt = names.indexOf("Build ordinary offline Treehouse app");
    const classifies = steps.filter((step) => stepName(step) === CLASSIFY_STEP);
    const classifyAt = names.indexOf(CLASSIFY_STEP);
    if (classifies.length !== 1) fail(`${PREVIEW_JOB} must have exactly one ordinary bundle classification step`);
    else {
      if (classifyAt <= buildAt || buildAt === -1) fail("classification must run after the ordinary build");
      const classify = classifies[0];
      const run = scalar(classify, "run") ?? "";
      if (run.trim() !== ORDINARY_CLASSIFY_RUN)
        fail("classification step must assert the ordinary variant of the ordinary bundle and its dist");
      if (scalar(classify, "working-directory") !== SHELL_DIR) fail("classification runs in the Treehouse shell");
      if (hasSkipKey(classify) || /\|\|/u.test(run)) fail("classification must be unconditional and blocking");
      // The whole step is pinned as exact text, so no key rides along in any YAML spelling (quoted keys
      // such as 'if' or "continue-on-error" pass a bare `if:` line check).
      if (exactStepBody(classify) !== CLASSIFY_STEP_BODY)
        fail("the ordinary classification step body must be exactly the pinned text");
      if (
        JSON.stringify(unquotedStepKeys(classify)) !== JSON.stringify(CLASSIFY_STEP_KEYS) ||
        JSON.stringify(stepOwnKeys(classify)) !== JSON.stringify(CLASSIFY_STEP_KEYS)
      )
        fail("the ordinary classification step keys must be exactly name, working-directory and run");
    }
    if (previewDigest(workflow) !== TREEHOUSE_PREVIEW_DIGEST)
      fail(`${PREVIEW_JOB} step bodies other than the classification and export steps changed`);

    // Row 236: the Space export runs once, after the replay and before the upload, on the retained app data.
    const exports = steps.filter((step) => stepName(step) === EXPORT_STEP);
    if (exports.length !== 1) fail(`${PREVIEW_JOB} must have exactly one Space export step`);
    else {
      const exportAt = names.indexOf(EXPORT_STEP);
      if (names[exportAt - 1] !== REPLAY_STEP) fail("the Space export must run immediately after the frame replay");
      if (names[exportAt + 1] !== PREVIEW_UPLOAD_STEP)
        fail("the Space export must run immediately before the evidence upload");
      const step = exports[0];
      const run = scalar(step, "run") ?? "";
      if (run.trim() !== EXPORT_RUN) fail(`the Space export must run exactly ${EXPORT_RUN}`);
      if (scalar(step, "working-directory") !== SHELL_DIR) fail("the Space export runs in the Treehouse shell");
      if (JSON.stringify(envEntries(step)) !== JSON.stringify(EXPORT_ENV))
        fail("the Space export env must be exactly the evidence dir and MIX_ENV");
      if (hasSkipKey(step) || /\|\||set\s+\+e/u.test(step)) fail("the Space export must be unconditional and blocking");
      // The whole step is pinned as exact text, so no key rides along in any YAML spelling (quoted keys
      // such as 'if' or "continue-on-error" pass a bare `if:` line check).
      if (exactStepBody(step) !== EXPORT_STEP_BODY) fail("the Space export step body must be exactly the pinned text");
      // No shell, timeout, id or uses may ride along: the step's own keys are exactly these four.
      const exportKeys = ["name", "working-directory", "env", "run"];
      if (
        JSON.stringify(unquotedStepKeys(step)) !== JSON.stringify(exportKeys) ||
        JSON.stringify(stepOwnKeys(step)) !== JSON.stringify(exportKeys)
      )
        fail("the Space export step keys must be exactly name, working-directory, env and run");
    }
    if (pkg.scripts?.["packaged:export"] !== EXPORT_SCRIPT)
      fail(`packaged:export must be exactly ${EXPORT_SCRIPT}`);
  }

  // android_pilot needs stays exactly the pinned list. The enrollment job is no distribution dependency;
  // the only job that may reference it is the required fan-in, which must.
  const pilot = findJob(workflow, "android_pilot");
  if (pilot) {
    if (JSON.stringify(needsOf(pilot)) !== JSON.stringify(ANDROID_PILOT_NEEDS))
      fail("android_pilot needs must be exactly the pinned list");
  } else fail("android_pilot is missing");
  const referrers = jobBlocks(workflow)
    .filter((other) => jobName(other) !== JOB && new RegExp(`\\b${JOB}\\b`, "u").test(other))
    .map(jobName);
  if (JSON.stringify(referrers) !== JSON.stringify(["required"]))
    fail(`exactly one other job, required, may reference ${JOB}`);
  const requiredJob = findJob(workflow, "required");
  if (!requiredJob || !needsOf(requiredJob).includes(JOB)) fail(`required must list ${JOB} in its needs`);

  if (!job) return problems;

  const header = jobHeader(job);
  const steps = stepBlocks(job);

  if (scalar(header, "runs-on", 4) !== "macos-15-intel") fail("runs-on must be macos-15-intel");
  const timeout = Number(scalar(header, "timeout-minutes", 4));
  if (!Number.isInteger(timeout) || timeout < 30 || timeout > 120) fail("timeout-minutes must be a bounded 30 to 120");
  if ((header.match(/^ {4}if:/gmu) ?? []).length !== 1 || scalar(header, "if", 4) !== ENROLLMENT_GATE)
    fail(`the job must carry exactly one job-level if, ${ENROLLMENT_GATE}`);
  if (countYamlKey(header, "if") !== 1 || headerOwnKeys(header).filter((key) => key === "if").length !== 1)
    fail(`the job must carry exactly one job-level if, including quoted YAML keys, ${ENROLLMENT_GATE}`);
  if (JSON.stringify(needsOf(job)) !== JSON.stringify(["changes"]))
    fail("the job must need exactly the changes classifier");
  if (JSON.stringify(permissions(header)) !== JSON.stringify(["contents: read"]))
    fail("the job must declare exactly least-privilege permissions: contents: read");
  if (/continue-on-error/u.test(job) || /continue-on-error/u.test(decodeYamlEscapes(job)))
    fail("continue-on-error is forbidden in any spelling");
  if (countYamlKey(job, "continue-on-error") > 0) fail("continue-on-error is forbidden in any spelling");
  if (/\|\|\s*(?:true|:|exit\s+0)\b/u.test(job)) fail("|| true style masking is forbidden");
  if (/set\s+\+e/u.test(job)) fail("set +e is forbidden");
  if (/\bif:\s*(?:\$\{\{\s*)?false\b/u.test(job)) fail("if: false is forbidden");
  if (/['"]if['"]:\s*(?:\$\{\{\s*)?(?:['"]false['"]|false)\b/u.test(decodeYamlEscapes(job)))
    fail("if: false is forbidden");
  if (/lattice-mobile-core/u.test(job)) fail("the job must not use lattice-mobile-core");
  if (/SKIP/iu.test(job)) fail("skip switches are forbidden");
  if (/TREEHOUSE_PACKAGED_PREFLIGHT_ONLY/u.test(job)) fail("the preflight-only switch must not be set in CI");

  // Only the evidence upload may carry an if, and it is exactly always(). Quoted YAML keys count.
  const conditional = steps.filter((step) => countYamlKey(step, "if") > 0);
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
  const releaseUploadPin = preview ? pinnedUses(preview, "actions/upload-artifact") : undefined;
  if (uploadPin !== releaseUploadPin) fail(`upload-artifact pin must match ${PREVIEW_JOB}`);

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
  const classifyAt = named(CLASSIFY_DEV_TRACE_STEP);
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
    classifyAt,
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

  // The dev-trace bundle and its frontend are classified together, unconditionally, before the harness runs.
  const classifySteps = steps.filter((step) => stepName(step) === CLASSIFY_DEV_TRACE_STEP);
  if (classifySteps.length !== 1) fail("the enrollment job must have exactly one dev-trace classification step");
  else {
    const step = classifySteps[0];
    const run = runOf(step);
    if (run.trim() !== DEV_TRACE_CLASSIFY_RUN)
      fail("dev-trace classification must assert the dev_trace bundle and the dist");
    if (scalar(step, "working-directory") !== SHELL_DIR) fail("dev-trace classification runs in the Treehouse shell");
    if (hasSkipKey(step) || /\|\|/u.test(run)) fail("dev-trace classification must be unconditional and blocking");
    if (exactStepBody(step) !== CLASSIFY_DEV_TRACE_STEP_BODY)
      fail("the dev-trace classification step body must be exactly the pinned text");
    if (
      JSON.stringify(unquotedStepKeys(step)) !== JSON.stringify(CLASSIFY_STEP_KEYS) ||
      JSON.stringify(stepOwnKeys(step)) !== JSON.stringify(CLASSIFY_STEP_KEYS)
    )
      fail("the dev-trace classification step keys must be exactly name, working-directory and run");
  }

  // The harness: real harness script, oracle inside it, evidence dir, no env skip or debug switches.
  if (harnessAt !== -1) {
    const step = steps[harnessAt];
    if (scalar(step, "working-directory") !== SHELL_DIR) fail("the harness runs in the Treehouse shell");
    const keys = envKeys(step);
    if (!keys.includes("TREEHOUSE_EVIDENCE_DIR")) fail("the harness step must set TREEHOUSE_EVIDENCE_DIR");
    const evidence = /^ {10}TREEHOUSE_EVIDENCE_DIR:\s*(.*)$/mu.exec(step)?.[1]?.trim();
    if (evidence !== EVIDENCE_DIR) fail("the evidence directory must be under runner.temp");
    for (const key of keys) if (/skip|only|keep/iu.test(key)) fail(`harness env ${key} is a skip or debug switch`);
    if (pkg.scripts?.["packaged:enrollment"] !== "tsx --preserve-symlinks test/packaged_enrollment.ts")
      fail("packaged:enrollment must be exactly tsx --preserve-symlinks test/packaged_enrollment.ts");
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
  "permissions removed": (text) => mutateJob(text, (job) => mutate(job, "    permissions:\n      contents: read\n", "")),
  "permissions write-all": (text) =>
    mutateJob(text, (job) => mutate(job, "    permissions:\n      contents: read\n", "    permissions: write-all\n")),
  "extra permission after a blank line": (text) =>
    mutateJob(text, (job) => mutate(job, "      contents: read\n", "      contents: read\n\n      id-token: write\n")),
  "extra permission after a comment": (text) =>
    mutateJob(text, (job) => mutate(job, "      contents: read\n", "      contents: read\n      # needed later\n      packages: write\n")),
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
  "harness quoted if false (row 238)": (text) =>
    mutateJob(text, (job) =>
      mutate(job, "        run: npm run packaged:enrollment", "        'if': false\n        run: npm run packaged:enrollment"),
    ),
  "harness double-quoted if false": (text) =>
    mutateJob(text, (job) =>
      mutate(job, "        run: npm run packaged:enrollment", '        "if": false\n        run: npm run packaged:enrollment'),
    ),
  "harness quoted if with space before colon": (text) =>
    mutateJob(text, (job) =>
      mutate(job, "        run: npm run packaged:enrollment", "        'if' : false\n        run: npm run packaged:enrollment"),
    ),
  "harness explicit YAML if key": (text) =>
    mutateJob(text, (job) =>
      mutate(job, "        run: npm run packaged:enrollment", "        ? if\n        : false\n        run: npm run packaged:enrollment"),
    ),
  "harness explicit quoted if with comment": (text) =>
    mutateJob(text, (job) =>
      mutate(
        job,
        "        run: npm run packaged:enrollment",
        "        ? 'if' # skip\n        : false\n        run: npm run packaged:enrollment",
      ),
    ),
  "harness tagged if key": (text) =>
    mutateJob(text, (job) =>
      mutate(job, "        run: npm run packaged:enrollment", "        !!str if: false\n        run: npm run packaged:enrollment"),
    ),
  "harness block-scalar if key": (text) =>
    mutateJob(text, (job) =>
      mutate(
        job,
        "        run: npm run packaged:enrollment",
        "        ? |-\n          if\n        : false\n        run: npm run packaged:enrollment",
      ),
    ),
  "harness block-scalar if with indent indicator": (text) =>
    mutateJob(text, (job) =>
      mutate(
        job,
        "        run: npm run packaged:enrollment",
        "        ? |2-\n          if\n        : runner.os == 'Linux'\n        run: npm run packaged:enrollment",
      ),
    ),
  "harness tagged block-scalar if key": (text) =>
    mutateJob(text, (job) =>
      mutate(
        job,
        "        run: npm run packaged:enrollment",
        "        ? !!str |-\n          if\n        : runner.os == 'Linux'\n        run: npm run packaged:enrollment",
      ),
    ),
  "harness tagged block-scalar if with indent indicator": (text) =>
    mutateJob(text, (job) =>
      mutate(
        job,
        "        run: npm run packaged:enrollment",
        "        ? !!str |2-\n          if\n        : runner.os == 'Linux'\n        run: npm run packaged:enrollment",
      ),
    ),
  "harness if after comment line continuation": (text) =>
    mutateJob(text, (job) =>
      mutate(
        job,
        "        run: npm run packaged:enrollment",
        "        # harmless \\\n        if: runner.os == 'Linux'\n        run: npm run packaged:enrollment",
      ),
    ),
  "harness split-line tagged if": (text) =>
    mutateJob(text, (job) =>
      mutate(
        job,
        "        run: npm run packaged:enrollment",
        "        ? !!str\n          if\n        : runner.os == 'Linux'\n        run: npm run packaged:enrollment",
      ),
    ),
  "harness nested tagged if": (text) =>
    mutateJob(text, (job) =>
      mutate(
        job,
        "        run: npm run packaged:enrollment",
        "        ?\n          !!str if\n        : runner.os == 'Linux'\n        run: npm run packaged:enrollment",
      ),
    ),
  "harness if after comment quote line continuation": (text) =>
    mutateJob(text, (job) =>
      mutate(
        job,
        "        run: npm run packaged:enrollment",
        '        # harmless " \\\n        if: runner.os == \'Linux\'\n        # closing "\n        run: npm run packaged:enrollment',
      ),
    ),
  "harness anchored explicit if": (text) =>
    mutateJob(text, (job) =>
      mutate(
        job,
        "        run: npm run packaged:enrollment",
        "        ? &cond 'if'\n        : runner.os == 'Linux'\n        id: *cond\n        run: npm run packaged:enrollment",
      ),
    ),
  "harness escaped-newline continue-on-error": (text) =>
    mutateJob(text, (job) =>
      mutate(
        job,
        "        run: npm run packaged:enrollment",
        '        ? "continue-on-erro\\\n          r"\n        : true\n        run: npm run packaged:enrollment',
      ),
    ),
  "job escaped-newline continue-on-error": (text) =>
    mutateJob(text, (job) =>
      mutate(job, "    runs-on:", '    ? "continue-on-erro\\\n      r"\n    : true\n    runs-on:'),
    ),
  "harness escaped continue-on-error": (text) =>
    mutateJob(text, (job) =>
      mutate(
        job,
        "        run: npm run packaged:enrollment",
        '        "continue-on-erro\\u0072": true\n        run: npm run packaged:enrollment',
      ),
    ),
  "ordinary classification duplicated": (text) => {
    const step = stepBlocks(findJob(text, PREVIEW_JOB)).find((s) => stepName(s) === CLASSIFY_STEP);
    return text.replace(step, `${step}${step}`);
  },
  "job extra quoted if false": (text) =>
    mutateJob(text, (job) =>
      mutate(job, "    runs-on:", "    'if': false\n    runs-on:"),
    ),
  "job escaped continue-on-error": (text) =>
    mutateJob(text, (job) =>
      mutate(job, "    runs-on:", '    "continue-on-erro\\u0072": true\n    runs-on:'),
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
      stepBlocks(findJob(text, PREVIEW_JOB)).find((step) => stepName(step) === CLASSIFY_STEP) ?? "",
      "",
    ),
  "classification asserts dev_trace": (text) =>
    mutate(text, "Treehouse.app ordinary", "Treehouse.app dev_trace"),
  "classification masked": (text) =>
    mutate(text, "Treehouse.app ordinary", "Treehouse.app ordinary || true"),
  "classification lacks the dist argument": (text) =>
    mutate(text, "Treehouse.app ordinary dist", "Treehouse.app ordinary"),
  "classification dist argument replaced": (text) =>
    mutate(text, "Treehouse.app ordinary dist", "Treehouse.app ordinary src"),
  "ordinary classification conditional": (text) => {
    const step = stepBlocks(findJob(text, PREVIEW_JOB)).find((s) => stepName(s) === CLASSIFY_STEP);
    return text.replace(step, step.replace("        run:", "        if: success()\n        run:"));
  },
  "ordinary classification gains a quoted if (row 238)": (text) => {
    const step = stepBlocks(findJob(text, PREVIEW_JOB)).find((s) => stepName(s) === CLASSIFY_STEP);
    return text.replace(step, step.replace("        run:", "        'if': false\n        run:"));
  },
  "ordinary classification gains a double-quoted if": (text) => {
    const step = stepBlocks(findJob(text, PREVIEW_JOB)).find((s) => stepName(s) === CLASSIFY_STEP);
    return text.replace(step, step.replace("        run:", '        "if": false\n        run:'));
  },
  "ordinary classification gains an escaped if": (text) => {
    const step = stepBlocks(findJob(text, PREVIEW_JOB)).find((s) => stepName(s) === CLASSIFY_STEP);
    return text.replace(step, step.replace("        run:", '        "i\\u0066": false\n        run:'));
  },
  "ordinary classification gains a quoted continue-on-error": (text) => {
    const step = stepBlocks(findJob(text, PREVIEW_JOB)).find((s) => stepName(s) === CLASSIFY_STEP);
    return text.replace(step, step.replace("        run:", '        "continue-on-error": true\n        run:'));
  },
  "ordinary classification gains a quoted shell": (text) => {
    const step = stepBlocks(findJob(text, PREVIEW_JOB)).find((s) => stepName(s) === CLASSIFY_STEP);
    return text.replace(step, step.replace("        run:", "        'shell': 'bash {0}'\n        run:"));
  },
  "ordinary classification gains a block-scalar shell": (text) => {
    const step = stepBlocks(findJob(text, PREVIEW_JOB)).find((s) => stepName(s) === CLASSIFY_STEP);
    return text.replace(step, step.replace("        run:", "        ? |-\n          shell\n        : bash -c true {0}\n        run:"));
  },
  "ordinary classification gains an anchored shell": (text) => {
    const step = stepBlocks(findJob(text, PREVIEW_JOB)).find((s) => stepName(s) === CLASSIFY_STEP);
    return text.replace(step, step.replace("        run:", "        &sh 'shell': bash -c true {0}\n        run:"));
  },
  "job-level VITE_TREEHOUSE_ENROLLMENT on the ordinary job (row 201)": (text) =>
    mutate(
      text,
      `  ${PREVIEW_JOB}:\n    name: Packaged macOS Treehouse preview\n`,
      `  ${PREVIEW_JOB}:\n    name: Packaged macOS Treehouse preview\n    env:\n      VITE_TREEHOUSE_ENROLLMENT: "1"\n`,
    ),
  "job-level VITE_TREEHOUSE_DEV_TRACE on the ordinary job": (text) =>
    mutate(
      text,
      `  ${PREVIEW_JOB}:\n    name: Packaged macOS Treehouse preview\n`,
      `  ${PREVIEW_JOB}:\n    name: Packaged macOS Treehouse preview\n    env:\n      VITE_TREEHOUSE_DEV_TRACE: "1"\n`,
    ),
  "workflow-level VITE_TREEHOUSE_ENROLLMENT": (text) => mutate(text, "\njobs:\n", '\nenv:\n  VITE_TREEHOUSE_ENROLLMENT: "1"\n\njobs:\n'),
  "step env VITE_TREEHOUSE_DEV_TRACE on the ordinary build": (text) =>
    mutate(
      text,
      "      - name: Build ordinary offline Treehouse app\n        working-directory: clients/treehouse-tauri-shell\n",
      '      - name: Build ordinary offline Treehouse app\n        working-directory: clients/treehouse-tauri-shell\n        env:\n          VITE_TREEHOUSE_DEV_TRACE: "1"\n',
    ),
  "inline VITE_TREEHOUSE_ENROLLMENT in a run line": (text) =>
    mutate(text, "run: npm run tauri -- build", "run: VITE_TREEHOUSE_ENROLLMENT=1 npm run tauri -- build"),
  "inline VITE_TREEHOUSE_ENROLLMENT in the enrollment build": (text) =>
    mutate(text, "run: npm run tauri:build:dev-trace", "run: VITE_TREEHOUSE_ENROLLMENT=1 npm run tauri:build:dev-trace"),
  "unrelated VITE_TREEHOUSE key in the workflow": (text) =>
    mutate(text, "run: npm run packaged:enrollment", "run: VITE_TREEHOUSE_POLL_MS=0 npm run packaged:enrollment"),
  "ordinary classification only echoed (review)": (text) =>
    mutate(text, "run: npx --no-install tsx test/assert_bundle_variant.ts src-tauri/target/release/bundle/macos/Treehouse.app ordinary dist", "run: echo npx --no-install tsx test/assert_bundle_variant.ts src-tauri/target/release/bundle/macos/Treehouse.app ordinary dist"),
  "dev-trace classification inside a shell if (review)": (text) =>
    mutate(text, "run: npx --no-install tsx test/assert_bundle_variant.ts src-tauri/target/release/bundle/macos/Treehouse.app dev_trace dist", "run: if npx --no-install tsx test/assert_bundle_variant.ts src-tauri/target/release/bundle/macos/Treehouse.app dev_trace dist; then :; fi"),
  "YAML-escaped variant keys on the ordinary job (review)": (text) =>
    mutate(
      text,
      `  ${PREVIEW_JOB}:\n    name: Packaged macOS Treehouse preview\n`,
      `  ${PREVIEW_JOB}:\n    name: Packaged macOS Treehouse preview\n    env:\n      "VITE\\u005fTREEHOUSE_ENROLLMENT": "1"\n      "VITE\\x5fTREEHOUSE_DEV_TRACE": "1"\n`,
    ),
  "variant key after comment line continuation": (text) =>
    mutate(
      text,
      `  ${PREVIEW_JOB}:\n    name: Packaged macOS Treehouse preview\n`,
      `  ${PREVIEW_JOB}:\n    name: Packaged macOS Treehouse preview\n    # noop \\\n      VITE_TREEHOUSE_DEV_TRACE: "1"\n`,
    ),
  "dev-trace classification removed": (text) =>
    mutateJob(text, (job) => job.replace(stepBlocks(job).find((step) => stepName(step) === CLASSIFY_DEV_TRACE_STEP) ?? "", "")),
  "dev-trace classification lacks the dist argument": (text) => mutate(text, "dev_trace dist", "dev_trace"),
  "dev-trace classification asserts ordinary": (text) => mutate(text, "dev_trace dist", "ordinary dist"),
  "dev-trace classification masked": (text) => mutate(text, "dev_trace dist", "dev_trace dist || true"),
  "dev-trace classification conditional": (text) =>
    mutate(
      text,
      "      - name: Classify Treehouse dev-trace bundle\n",
      "      - name: Classify Treehouse dev-trace bundle\n        if: runner.os == 'macOS'\n",
    ),
  "dev-trace classification gains a quoted if (row 238)": (text) =>
    mutateJob(text, (job) => {
      const step = stepBlocks(job).find((s) => stepName(s) === CLASSIFY_DEV_TRACE_STEP);
      return job.replace(step, step.replace("        run:", "        'if': false\n        run:"));
    }),
  "dev-trace classification gains a quoted continue-on-error": (text) =>
    mutateJob(text, (job) => {
      const step = stepBlocks(job).find((s) => stepName(s) === CLASSIFY_DEV_TRACE_STEP);
      return job.replace(step, step.replace("        run:", '        "continue-on-error": true\n        run:'));
    }),
  "dev-trace classification gains a quoted shell": (text) =>
    mutateJob(text, (job) => {
      const step = stepBlocks(job).find((s) => stepName(s) === CLASSIFY_DEV_TRACE_STEP);
      return job.replace(step, step.replace("        run:", "        'shell': 'bash {0}'\n        run:"));
    }),
  "dev-trace classification gains a block-scalar shell": (text) =>
    mutateJob(text, (job) => {
      const step = stepBlocks(job).find((s) => stepName(s) === CLASSIFY_DEV_TRACE_STEP);
      return job.replace(step, step.replace("        run:", "        ? |-\n          shell\n        : bash -c true {0}\n        run:"));
    }),
  "dev-trace classification duplicated": (text) =>
    mutateJob(text, (job) => {
      const step = stepBlocks(job).find((s) => stepName(s) === CLASSIFY_DEV_TRACE_STEP);
      return job.replace(step, `${step}${step}`);
    }),
  "dev-trace classification before the build": (text) =>
    mutateJob(text, (job) => {
      const classify = stepBlocks(job).find((step) => stepName(step) === CLASSIFY_DEV_TRACE_STEP);
      const build = stepBlocks(job).find((step) => stepName(step) === "Build packaged Treehouse dev-trace variant");
      return job.replace(classify, "").replace(build, `${classify}${build}`);
    }),
  "dev-trace classification after the harness": (text) =>
    mutateJob(text, (job) => {
      const classify = stepBlocks(job).find((step) => stepName(step) === CLASSIFY_DEV_TRACE_STEP);
      const harness = stepBlocks(job).find((step) => stepName(step) === "Verify packaged Treehouse enrollment against Lattice.Sim");
      return job.replace(classify, "").replace(harness, `${harness}${classify}`);
    }),
  "dev-trace classification in the wrong directory": (text) =>
    mutateJob(text, (job) =>
      mutate(
        job,
        "      - name: Classify Treehouse dev-trace bundle\n        working-directory: clients/treehouse-tauri-shell",
        "      - name: Classify Treehouse dev-trace bundle\n        working-directory: clients/township-tauri-shell",
      ),
    ),
  "packaged_macos step body edited": (text) =>
    mutate(text, "run: npm run tauri:feed:smoke\n", "run: npm run tauri:feed:smoke -- --skip\n"),
  "preview job step body edited": (text) =>
    mutate(text, "run: npm run packaged\n", "run: npm run packaged -- --skip\n"),
  "export step removed (row 236)": (text) => {
    const step = stepBlocks(findJob(text, PREVIEW_JOB)).find((s) => stepName(s) === EXPORT_STEP);
    assert.ok(step, "the export step must exist to remove it");
    return text.replace(step, "");
  },
  "export step duplicated": (text) => {
    const step = stepBlocks(findJob(text, PREVIEW_JOB)).find((s) => stepName(s) === EXPORT_STEP);
    return text.replace(step, `${step}${step}`);
  },
  "export step before the replay": (text) => {
    const steps = stepBlocks(findJob(text, PREVIEW_JOB));
    const step = steps.find((s) => stepName(s) === EXPORT_STEP);
    const replay = steps.find((s) => stepName(s) === REPLAY_STEP);
    return text.replace(step, "").replace(replay, `${step}${replay}`);
  },
  "export step after the upload": (text) => {
    const steps = stepBlocks(findJob(text, PREVIEW_JOB));
    const step = steps.find((s) => stepName(s) === EXPORT_STEP);
    const upload = steps.find((s) => stepName(s) === PREVIEW_UPLOAD_STEP);
    return text.replace(step, "").replace(upload, `${upload.trimEnd()}\n\n${step}`);
  },
  "export run replaced": (text) => mutate(text, "run: npm run packaged:export\n", "run: npm run packaged\n"),
  "export run masked with || true": (text) =>
    mutate(text, "run: npm run packaged:export\n", "run: npm run packaged:export || true\n"),
  "export run behind set +e": (text) =>
    mutate(text, "run: npm run packaged:export\n", "run: |\n          set +e\n          npm run packaged:export\n"),
  "export in the wrong directory": (text) =>
    mutate(
      text,
      `      - name: ${EXPORT_STEP}\n        working-directory: clients/treehouse-tauri-shell\n`,
      `      - name: ${EXPORT_STEP}\n        working-directory: clients/township-tauri-shell\n`,
    ),
  "export conditional": (text) =>
    mutate(text, `      - name: ${EXPORT_STEP}\n`, `      - name: ${EXPORT_STEP}\n        if: success()\n`),
  "export continue-on-error": (text) =>
    mutate(text, `      - name: ${EXPORT_STEP}\n`, `      - name: ${EXPORT_STEP}\n        continue-on-error: true\n`),
  "export step gains a quoted if": (text) =>
    mutate(text, "        run: npm run packaged:export\n", "        'if': false\n        run: npm run packaged:export\n"),
  "export step gains a quoted continue-on-error": (text) =>
    mutate(text, "        run: npm run packaged:export\n", "        \"continue-on-error\": true\n        run: npm run packaged:export\n"),
  "export step gains a quoted shell": (text) =>
    mutate(text, "        run: npm run packaged:export\n", "        'shell': 'bash {0}'\n        run: npm run packaged:export\n"),
  "export step gains a block-scalar shell": (text) =>
    mutate(
      text,
      "        run: npm run packaged:export\n",
      "        ? |-\n          shell\n        : bash -c true {0}\n        run: npm run packaged:export\n",
    ),
  "export step gains a shell": (text) =>
    mutate(text, "        run: npm run packaged:export\n", "        shell: bash {0}\n        run: npm run packaged:export\n"),
  "export step gains a timeout": (text) =>
    mutate(text, "        run: npm run packaged:export\n", "        timeout-minutes: 1\n        run: npm run packaged:export\n"),
  "export evidence dir moved": (text) =>
    mutate(text, "/treehouse-preview/space-export\n", "/space-export\n"),
  "export env drops MIX_ENV": (text) =>
    mutate(text, "/treehouse-preview/space-export\n          MIX_ENV: test\n", "/treehouse-preview/space-export\n"),
  "export env gains a key": (text) =>
    mutate(
      text,
      "/treehouse-preview/space-export\n          MIX_ENV: test\n",
      "/treehouse-preview/space-export\n          MIX_ENV: test\n          TREEHOUSE_PACKAGED_KEEP: \"1\"\n",
    ),
  "export env reordered": (text) =>
    mutate(
      text,
      "          TREEHOUSE_EVIDENCE_DIR: ${{ runner.temp }}/treehouse-preview/space-export\n          MIX_ENV: test\n",
      "          MIX_ENV: test\n          TREEHOUSE_EVIDENCE_DIR: ${{ runner.temp }}/treehouse-preview/space-export\n",
    ),
  "classification step moved back into packaged_macos": (text) => {
    const classify = stepBlocks(findJob(text, PREVIEW_JOB)).find((step) => stepName(step) === CLASSIFY_STEP);
    assert.ok(classify, "the classification step must exist to move it");
    const macos = findJob(text, "packaged_macos");
    return text.replace(classify, "").replace(macos, `${macos.trimEnd()}\n\n${classify}\n`);
  },
  "preview job upload pin differs": (text) => {
    const job = findJob(text, PREVIEW_JOB);
    return text.replace(job, job.replace(/(actions\/upload-artifact@)[0-9a-f]{40}/u, "$1" + "0".repeat(40)));
  },
  "android_pilot needs extended": (text) =>
    mutate(text, "      - android_pilot_verify\n      - changes\n    runs-on: ubuntu-latest\n    timeout-minutes: 90\n    environment: android-pilot", `      - android_pilot_verify\n      - changes\n      - ${JOB}\n    runs-on: ubuntu-latest\n    timeout-minutes: 90\n    environment: android-pilot`),
  "android_pilot needs drops changes": (text) =>
    mutate(text, "      - android_pilot_verify\n      - changes\n    runs-on: ubuntu-latest\n    timeout-minutes: 90\n    environment: android-pilot", "      - android_pilot_verify\n    runs-on: ubuntu-latest\n    timeout-minutes: 90\n    environment: android-pilot"),
  "enrollment gate altered": (text) =>
    mutateJob(text, (job) =>
      mutate(job, "    if: needs.changes.outputs.treehouse == 'true'\n", "    if: needs.changes.outputs.township == 'true'\n"),
    ),
  "enrollment gate removed": (text) =>
    mutateJob(text, (job) => mutate(job, "    if: needs.changes.outputs.treehouse == 'true'\n", "")),
  "enrollment gate widened": (text) =>
    mutateJob(text, (job) =>
      mutate(
        job,
        "    if: needs.changes.outputs.treehouse == 'true'\n",
        "    if: needs.changes.outputs.treehouse == 'true' || always()\n",
      ),
    ),
  "enrollment job stops needing the classifier": (text) =>
    mutateJob(text, (job) => mutate(job, "    needs: changes\n", "")),
  "required drops the enrollment job": (text) =>
    mutate(text, "treehouse_packaged_macos, treehouse_packaged_macos_enrollment, ", "treehouse_packaged_macos, "),
  "required removed": (text) => text.replace(findJob(text, "required") ?? "", ""),
  "a second job references the enrollment job": (text) =>
    mutate(
      text,
      "  carrier_release:\n    name: Packaged carrier restart durability\n    needs: changes\n",
      `  carrier_release:\n    name: Packaged carrier restart durability\n    needs: [changes, ${JOB}]\n`,
    ),
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
  "dev-trace frontend flag dropped from the build script": (p) => ({
    ...p,
    scripts: { ...p.scripts, "tauri:build:dev-trace": p.scripts["tauri:build:dev-trace"].replace("VITE_TREEHOUSE_DEV_TRACE=1 ", "") },
  }),
  "overlay dropped from the build script": (p) => ({
    ...p,
    scripts: { ...p.scripts, "tauri:build:dev-trace": p.scripts["tauri:build:dev-trace"].replace(" --config src-tauri/tauri.dev-trace.conf.json", "") },
  }),
  "enrollment flag set in the build script": (p) => ({
    ...p,
    scripts: { ...p.scripts, build: `VITE_TREEHOUSE_ENROLLMENT=1 ${p.scripts.build}` },
  }),
  "dev-trace flag set in the tauri script": (p) => ({
    ...p,
    scripts: { ...p.scripts, tauri: `VITE_TREEHOUSE_DEV_TRACE=1 ${p.scripts.tauri}` },
  }),
  "enrollment flag set in the test script": (p) => ({
    ...p,
    scripts: { ...p.scripts, test: `VITE_TREEHOUSE_ENROLLMENT=1 ${p.scripts.test}` },
  }),
  "harness script repointed": (p) => ({
    ...p,
    scripts: { ...p.scripts, "packaged:enrollment": "tsx test/packaged_preview.ts" },
  }),
  "export script repointed (row 236)": (p) => ({
    ...p,
    scripts: { ...p.scripts, "packaged:export": "tsx test/packaged_preview.ts" },
  }),
  "export script without --preserve-symlinks": (p) => ({
    ...p,
    scripts: { ...p.scripts, "packaged:export": "tsx test/packaged_export.ts" },
  }),
  "export script removed": (p) => {
    const { "packaged:export": _removed, ...scripts } = p.scripts;
    return { ...p, scripts };
  },
};

for (const [name, apply] of Object.entries(packageMutations)) {
  test(`package mutation fails the contract: ${name}`, () => {
    assert.notDeepEqual(check(workflow, apply(pkg), harnessSource), [], `contract accepted: ${name}`);
  });
}

// Row 201 review: the variant flags reach Vite only through the package script, so the shell carries no .env
// file and Tauri's ordinary pre-build hook is exactly the plain build. The dist classification in CI is the
// runtime backstop for any other route.
test("the shell has no .env file and the ordinary pre-build hook is the plain build", () => {
  assert.deepEqual(readdirSync(shellRoot).filter((name) => name.startsWith(".env")), []);
  const conf = JSON.parse(readFileSync(resolve(shellRoot, "src-tauri/tauri.conf.json"), "utf8"));
  assert.equal(conf.build?.beforeBuildCommand, "npm run build");
});

test("a harness without the oracle or a failing exit fails the contract", () => {
  assert.notDeepEqual(check(workflow, pkg, harnessSource.replaceAll("treehouse_enrollment_oracle.exs", "x.exs")), []);
  assert.notDeepEqual(check(workflow, pkg, harnessSource.replaceAll("process.exit(1)", "process.exit(0)")), []);
});

test("the pinned packaged_macos digest is a real sha256", () => {
  assert.match(PACKAGED_MACOS_DIGEST, /^[0-9a-f]{64}$/u);
});

test("the pinned treehouse_packaged_macos digest is a real sha256", () => {
  assert.match(TREEHOUSE_PREVIEW_DIGEST, /^[0-9a-f]{64}$/u);
});

test("the Treehouse preview job is a distinct sibling of packaged_macos", () => {
  const names = jobBlocks(workflow).map(jobName);
  assert.equal(names.filter((name) => name === PREVIEW_JOB).length, 1);
  assert.ok(names.includes("packaged_macos"));
});

test("countYamlKey reads indent-indicator and tagged block-scalar if keys", () => {
  assert.ok(countYamlKey("        ? |2-\n          if\n        : runner.os == 'Linux'\n", "if") > 0);
  assert.ok(countYamlKey("        ? !!str |-\n          if\n        : false\n", "if") > 0);
  assert.ok(countYamlKey("        ? !!str |2-\n          if\n        : false\n", "if") > 0);
});

test("countYamlKey reads escaped-newline continue-on-error keys", () => {
  assert.ok(countYamlKey('        ? "continue-on-erro\\\n          r"\n        : true\n', "continue-on-error") > 0);
  assert.ok(countYamlKey('    ? "continue-on-erro\\\n      r"\n    : true\n', "continue-on-error") > 0);
});

test("own-key whitelist sees a lockstep block-scalar shell", () => {
  const injected = "        ? |-\n          shell\n        : bash -c true {0}\n        run:";
  const exportKeys = ["name", "working-directory", "env", "run"];
  for (const [body, allowed] of [
    [CLASSIFY_STEP_BODY, CLASSIFY_STEP_KEYS],
    [CLASSIFY_DEV_TRACE_STEP_BODY, CLASSIFY_STEP_KEYS],
    [EXPORT_STEP_BODY, exportKeys],
  ]) {
    const updated = body.replace("        run:", injected);
    assert.ok(stepOwnKeys(updated).includes("shell"));
    assert.notEqual(JSON.stringify(stepOwnKeys(updated)), JSON.stringify(allowed));
  }
});

test("countYamlKey still sees if after a comment that ends with a backslash", () => {
  assert.ok(countYamlKey("        # harmless \\\n        if: runner.os == 'Linux'\n", "if") > 0);
});

test("countYamlKey reads split-line and nested tagged if keys", () => {
  assert.ok(countYamlKey("        ? !!str\n          if\n        : runner.os == 'Linux'\n", "if") > 0);
  assert.ok(countYamlKey("        ?\n          !!str if\n        : false\n", "if") > 0);
});

test("own-key whitelist sees a lockstep split-line tagged shell", () => {
  const injected = "        ? !!str\n          shell\n        : bash -c true {0}\n        run:";
  const exportKeys = ["name", "working-directory", "env", "run"];
  for (const [body, allowed] of [
    [CLASSIFY_STEP_BODY, CLASSIFY_STEP_KEYS],
    [CLASSIFY_DEV_TRACE_STEP_BODY, CLASSIFY_STEP_KEYS],
    [EXPORT_STEP_BODY, exportKeys],
  ]) {
    const updated = body.replace("        run:", injected);
    assert.ok(stepOwnKeys(updated).includes("shell"));
    assert.notEqual(JSON.stringify(stepOwnKeys(updated)), JSON.stringify(allowed));
  }
});

test("countYamlKey still sees if after a quoted comment line continuation", () => {
  assert.ok(
    countYamlKey('        # harmless " \\\n        if: runner.os == \'Linux\'\n        # closing "\n', "if") > 0,
  );
});

test("countYamlKey reads an anchored explicit if key", () => {
  assert.ok(countYamlKey("        ? &cond 'if'\n        : runner.os == 'Linux'\n        id: *cond\n", "if") > 0);
});

test("own-key whitelist sees a lockstep anchored shell", () => {
  const injected = "        &sh 'shell': bash -c true {0}\n        run:";
  const exportKeys = ["name", "working-directory", "env", "run"];
  for (const [body, allowed] of [
    [CLASSIFY_STEP_BODY, CLASSIFY_STEP_KEYS],
    [CLASSIFY_DEV_TRACE_STEP_BODY, CLASSIFY_STEP_KEYS],
    [EXPORT_STEP_BODY, exportKeys],
  ]) {
    const updated = body.replace("        run:", injected);
    assert.ok(stepOwnKeys(updated).includes("shell"));
    assert.notEqual(JSON.stringify(stepOwnKeys(updated)), JSON.stringify(allowed));
  }
});
