import { chmodSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

export function createIosProbeCopyDestination(root, launch, attempt) {
  const rootStat = statSync(root);
  if (!rootStat.isDirectory() || (rootStat.mode & 0o777) !== 0o700) {
    throw new Error("physical iOS probe directory is not private");
  }
  const destination = join(root, `launch-${launch}-copy-${attempt}.log`);
  if (existsSync(destination)) {
    throw new Error("physical iOS probe copy destination already exists");
  }
  return destination;
}

export function secureIosProbeCopy(path) {
  const before = statSync(path);
  if (!before.isFile()) {
    throw new Error("physical iOS probe copy is not a file");
  }
  chmodSync(path, 0o600);
  if ((statSync(path).mode & 0o777) !== 0o600) {
    throw new Error("physical iOS probe copy is not private");
  }
}

export function iosDeviceLaunchProcessId(value) {
  const processIds = new Set();
  collectProcessIds(value, processIds);
  if (processIds.size !== 1) {
    throw new Error("physical iOS launch process id was not unique");
  }
  return [...processIds][0];
}

function collectProcessIds(value, processIds) {
  if (Array.isArray(value)) {
    for (const entry of value) collectProcessIds(entry, processIds);
    return;
  }
  if (!value || typeof value !== "object") return;

  for (const [key, entry] of Object.entries(value)) {
    if (key === "processIdentifier" && Number.isInteger(entry) && entry > 0) {
      processIds.add(String(entry));
    } else {
      collectProcessIds(entry, processIds);
    }
  }
}

export function completeProbeLines(output, prefix) {
  const lastLineBreak = Math.max(
    output.lastIndexOf("\n"),
    output.lastIndexOf("\r"),
  );
  if (lastLineBreak === -1) return [];

  return output
    .slice(0, lastLineBreak + 1)
    .split(/\r\n|\r|\n/)
    .filter((line) => line.includes(prefix));
}

export function iosDeviceProbeProgress(
  output,
  prefix,
  expectedLaunchNonce,
  expectedProcessId,
) {
  const marker = `LATTICE_PROBE: ${prefix} `;
  const escapedPrefix = escapeRegExp(prefix);
  const startupPattern = new RegExp(
    `^LATTICE_PROBE: ${escapedPrefix} stage=native_startup ` +
      `launch_nonce=([0-9a-f]{32}) process_id=(\\d+)$`,
  );
  const slotPattern = new RegExp(
    `^LATTICE_PROBE: ${escapedPrefix} store=ios_protected_keychain ` +
      `slot=(primary|control) outcome=(ready|error) key_id=([A-Za-z0-9_.:-]+) ` +
      `(.+) launch_nonce=([0-9a-f]{32}) process_id=(\\d+)$`,
  );
  const records = {};

  for (const line of completeProbeLines(output, prefix)) {
    const markerIndex = line.indexOf(marker);
    if (markerIndex === -1) throw malformedProbeRecord();
    const event = line.slice(markerIndex);
    const startup = startupPattern.exec(event);
    if (startup) {
      addProbeRecord(records, "startup", {
        fields: {
          launch_nonce: startup[1],
          process_id: startup[2],
          stage: "native_startup",
        },
        line: event,
      });
      continue;
    }

    const slot = slotPattern.exec(event);
    if (!slot) throw malformedProbeRecord();
    const [, name, outcome, keyId, outcomeFields, launchNonce, processId] =
      slot;
    const expectedKeyId =
      name === "primary"
        ? "township-resident"
        : "township-ios-key-reuse-control";
    if (keyId !== expectedKeyId) throw malformedProbeRecord();

    const fields = {
      key_id: keyId,
      launch_nonce: launchNonce,
      outcome,
      process_id: processId,
      slot: name,
      store: "ios_protected_keychain",
    };
    if (outcome === "ready") {
      const ready =
        /^public_key_base64url=([A-Za-z0-9_-]{43}) signature_bytes=(\d+)$/.exec(
          outcomeFields,
        );
      if (!ready) throw malformedProbeRecord();
      fields.public_key_base64url = ready[1];
      fields.signature_bytes = ready[2];
    } else {
      if (outcomeFields !== "error=unavailable") throw malformedProbeRecord();
      fields.error = "unavailable";
    }
    addProbeRecord(records, name, { fields, line: event });
  }

  const processIds = new Set(
    Object.values(records).map((record) => record.fields.process_id),
  );
  if (processIds.size > 1)
    throw new Error("physical iOS probe process id mismatch");
  const launchNonces = new Set(
    Object.values(records).map((record) => record.fields.launch_nonce),
  );
  if (launchNonces.size > 1)
    throw new Error("physical iOS probe launch nonce mismatch");

  const processId = records.startup?.fields.process_id;
  const launchNonce = records.startup?.fields.launch_nonce;
  if (processId && processId !== expectedProcessId)
    throw new Error("physical iOS probe process id mismatch");
  if (launchNonce && launchNonce !== expectedLaunchNonce)
    throw new Error("physical iOS probe launch nonce mismatch");
  const evidence =
    records.startup && records.primary && records.control
      ? {
          control: records.control,
          launchNonce,
          primary: records.primary,
          processId,
          startup: records.startup,
        }
      : undefined;
  return { evidence, launchNonce, processId };
}

function addProbeRecord(records, name, record) {
  if (records[name]) throw new Error(`duplicate ${name} probe`);
  records[name] = record;
}

function malformedProbeRecord() {
  return new Error("malformed physical iOS probe record");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function redactIosDeviceCommandOutput(
  value,
  deviceUdid = "",
  home = "",
  deviceName = "",
) {
  let redacted = value;
  if (deviceUdid) {
    redacted = redacted.replaceAll(deviceUdid, "<physical-device>");
  }
  if (home) redacted = redacted.replaceAll(home, "~");
  if (deviceName) {
    for (const variant of textVariants(deviceName)) {
      redacted = redacted.replaceAll(variant, "<physical-device-name>");
    }
  }

  return redacted
    .replace(
      /\b(?:Apple Development|Apple Distribution|iPhone Developer|Developer ID(?: Application| Installer)?):[^\r\n"]+/g,
      "Apple signing identity: <redacted>",
    )
    .replace(
      /\b(provisioning profile(?: name)?)\s*[:=][^\r\n]+/gi,
      "$1: <redacted>",
    )
    .replace(
      /\b(provisioning profile(?: name)?)\s+(["'])[^\r\n"']+\2/gi,
      '$1 "<redacted>"',
    )
    .replace(/\b[0-9A-F]{8}-[0-9A-F]{16}\b/gi, "<physical-device>")
    .replace(/\b[0-9A-F]{8}(?:-[0-9A-F]{4}){3}-[0-9A-F]{12}\b/gi, "<uuid>")
    .replace(/\b[0-9A-F]{40}\b/gi, "<certificate>")
    .replace(
      /\b(public_key_base64url|key_id|error|signature)=\S+/g,
      "$1=<redacted>",
    )
    .replace(
      /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g,
      "<redacted-key>",
    )
    .replace(/\b[A-Z0-9]{10}\b/g, "<apple-team>");
}

function textVariants(value) {
  return new Set([
    value,
    value.normalize("NFC"),
    value.normalize("NFD"),
    value.replaceAll("'", "’"),
    value.replaceAll("’", "'"),
  ]);
}
