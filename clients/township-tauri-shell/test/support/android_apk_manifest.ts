import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { sdkRoot } from "./android_cdp";

const execFileAsync = promisify(execFile);
const releaseNetworkSecurityConfigResourceName = "township_release_network_security_config";

interface ApkXmlResource {
  id: string;
  path: string;
}

export interface ApkNetworkSecurityConfigExpectation {
  baseCleartextTrafficPermitted: boolean;
  cleartextDomains: string[];
}

export async function assertApkPackage(apkPath: string, expectedPackage: string): Promise<void> {
  const manifest = await readApkManifest(apkPath);
  assert.match(manifest, new RegExp(`\\bpackage="${escapeRegExp(expectedPackage)}"`), `expected APK package ${expectedPackage}`);
}

export async function assertApkUsesCleartextTraffic(apkPath: string, expected: boolean): Promise<void> {
  const manifest = await readApkManifest(apkPath);
  assert.match(
    manifest,
    new RegExp(`android:usesCleartextTraffic="${expected ? "true" : "false"}"`),
    `expected APK usesCleartextTraffic=${expected}`,
  );
}

export async function assertApkNetworkSecurityConfig(
  apkPath: string,
  expected: ApkNetworkSecurityConfigExpectation,
): Promise<void> {
  const manifest = await readApkManifest(apkPath);
  const manifestReference = extractManifestNetworkSecurityConfigReference(manifest);
  const releaseResource = await resolveApkXmlResource(apkPath, releaseNetworkSecurityConfigResourceName);
  if (manifestReference.startsWith("@ref/")) {
    const manifestResourceId = manifestReference.slice("@ref/".length);
    assert.equal(
      manifestResourceId.toLowerCase(),
      releaseResource.id.toLowerCase(),
      "expected release APK manifest network security config reference to target the release resource",
    );
  } else {
    assert.equal(
      manifestReference,
      `@xml/${releaseNetworkSecurityConfigResourceName}`,
      "expected release APK manifest network security config reference to target the release resource",
    );
  }

  const xmlTree = await readApkXmlTree(apkPath, releaseResource.path);
  assert.equal(
    extractXmlBooleanAttribute(xmlTree, "base-config", "cleartextTrafficPermitted"),
    expected.baseCleartextTrafficPermitted,
    `expected base-config cleartextTrafficPermitted=${expected.baseCleartextTrafficPermitted} in compiled network security config:\n${xmlTree}`,
  );
  assert.equal(
    extractXmlBooleanAttribute(xmlTree, "domain-config", "cleartextTrafficPermitted"),
    true,
    `expected domain-config cleartextTrafficPermitted=true in compiled network security config:\n${xmlTree}`,
  );
  assert.deepEqual(
    extractXmlDomainTexts(xmlTree),
    expected.cleartextDomains,
    `expected network security config domains ${expected.cleartextDomains.join(", ")}:\n${xmlTree}`,
  );
}

export async function readApkManifest(apkPath: string): Promise<string> {
  assert.ok(existsSync(apkPath), `missing APK at ${apkPath}`);
  const apkanalyzer = join(sdkRoot, "cmdline-tools", "latest", "bin", "apkanalyzer");
  assert.ok(existsSync(apkanalyzer), `missing apkanalyzer at ${apkanalyzer}`);
  const { stdout } = await execFileAsync(apkanalyzer, ["manifest", "print", apkPath], {
    maxBuffer: 2 * 1024 * 1024,
    timeout: 30_000,
  });
  return stdout;
}

function extractManifestNetworkSecurityConfigReference(manifest: string): string {
  const match = /android:networkSecurityConfig="([^"]+)"/.exec(manifest);
  assert.ok(match?.[1], `expected release APK manifest to include a network security config reference:\n${manifest}`);
  return match[1];
}

async function readApkXmlTree(apkPath: string, resourcePath: string): Promise<string> {
  assert.ok(existsSync(apkPath), `missing APK at ${apkPath}`);
  const aapt2 = findAapt2();
  const { stdout } = await execFileAsync(aapt2, ["dump", "xmltree", "--file", resourcePath, apkPath], {
    maxBuffer: 2 * 1024 * 1024,
    timeout: 30_000,
  });
  return stdout;
}

async function resolveApkXmlResource(apkPath: string, resourceName: string): Promise<ApkXmlResource> {
  assert.ok(existsSync(apkPath), `missing APK at ${apkPath}`);
  const aapt2 = findAapt2();
  const { stdout } = await execFileAsync(aapt2, ["dump", "resources", apkPath], {
    maxBuffer: 16 * 1024 * 1024,
    timeout: 30_000,
  });
  const match = new RegExp(
    `resource\\s+(0x[0-9a-f]+)\\s+xml/${escapeRegExp(resourceName)}\\s*\\n\\s+\\(\\) \\(file\\) (\\S+) type=XML`,
  ).exec(stdout);
  assert.ok(match?.[1] && match[2], `expected APK resource table to contain xml/${resourceName}:\n${stdout}`);
  return { id: match[1], path: match[2] };
}

function findAapt2(): string {
  const buildToolsRoot = join(sdkRoot, "build-tools");
  assert.ok(existsSync(buildToolsRoot), `missing Android build-tools at ${buildToolsRoot}`);
  const versions = readdirSync(buildToolsRoot)
    .filter((name) => existsSync(join(buildToolsRoot, name, "aapt2")))
    .sort()
    .reverse();
  const candidate = versions[0] ? join(buildToolsRoot, versions[0], "aapt2") : "";
  assert.ok(candidate && existsSync(candidate), `missing aapt2 under ${buildToolsRoot}`);
  return candidate;
}

function extractXmlBooleanAttribute(xmlTree: string, element: string, attribute: string): boolean {
  const lines = xmlTree.split(/\r?\n/);
  const elementLineIndex = lines.findIndex((line) => line.trimStart().startsWith(`E: ${element} `));
  assert.notEqual(elementLineIndex, -1, `expected compiled network security config to contain ${element}:\n${xmlTree}`);
  const elementIndent = leadingSpaces(lines[elementLineIndex] ?? "");

  for (let index = elementLineIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const trimmed = line.trimStart();
    const indent = leadingSpaces(line);
    if (trimmed.startsWith("E: ") && indent <= elementIndent) break;
    if (!trimmed.startsWith("A: ") || !trimmed.includes(attribute)) continue;
    const value = parseAaptBooleanAttributeLine(line);
    assert.notEqual(value, null, `expected boolean ${attribute} attribute line in compiled XML:\n${line}`);
    return value;
  }

  assert.fail(`expected ${element} to include ${attribute} in compiled network security config:\n${xmlTree}`);
}

function extractXmlDomainTexts(xmlTree: string): string[] {
  const domains: string[] = [];
  const lines = xmlTree.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const trimmed = line.trimStart();
    if (!trimmed.startsWith("E: domain ")) continue;
    const elementIndent = leadingSpaces(line);
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const candidate = lines[cursor] ?? "";
      const candidateTrimmed = candidate.trimStart();
      const candidateIndent = leadingSpaces(candidate);
      if (candidateTrimmed.startsWith("E: ") && candidateIndent <= elementIndent) break;
      const textMatch = /^T: '([^']+)'$/.exec(candidateTrimmed);
      if (textMatch?.[1]) {
        domains.push(textMatch[1]);
        break;
      }
    }
  }
  return domains;
}

function parseAaptBooleanAttributeLine(line: string): boolean | null {
  const textMatch = /=\s*(true|false)\s*$/i.exec(line);
  if (textMatch?.[1]) return textMatch[1].toLowerCase() === "true";

  const encodedValueMatch = /\)(0x[0-9a-f]+)\s*$/i.exec(line);
  if (!encodedValueMatch?.[1]) return null;
  const normalized = encodedValueMatch[1].toLowerCase();
  if (normalized === "0x0") return false;
  if (normalized === "0x1" || normalized === "0xffffffff") return true;
  return null;
}

function leadingSpaces(line: string): number {
  return line.match(/^ */)?.[0].length ?? 0;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
