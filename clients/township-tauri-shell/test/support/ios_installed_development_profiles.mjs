import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import {
  developmentProfileErrors,
  duplicateProfileEntitlementKeys,
  profileDateTimeMs,
} from "./ios_development_profile.mjs";

export function assessInstalledIosDevelopmentProfiles(candidates, options) {
  const seenIdentities = new Set();
  const errorCounts = new Map();
  let decodedUniqueProfileCount = 0;
  let invalidProfileCount = 0;
  let undecodableProfileCount = 0;
  let validProfileCount = 0;

  for (const candidate of candidates) {
    if (
      typeof candidate?.identity !== "string" ||
      candidate.identity.length === 0 ||
      !candidate.profile
    ) {
      undecodableProfileCount += 1;
      continue;
    }
    if (seenIdentities.has(candidate.identity)) continue;
    seenIdentities.add(candidate.identity);
    decodedUniqueProfileCount += 1;

    const errors = developmentProfileErrors(candidate.profile, options);
    if (errors.length === 0) {
      validProfileCount += 1;
      continue;
    }
    invalidProfileCount += 1;
    for (const error of errors) {
      errorCounts.set(error, (errorCounts.get(error) ?? 0) + 1);
    }
  }

  return {
    decodedUniqueProfileCount,
    errorCounts: Object.fromEntries(
      [...errorCounts].sort(([left], [right]) => left.localeCompare(right)),
    ),
    invalidProfileCount,
    undecodableProfileCount,
    validProfileCount,
  };
}

export function installedIosDevelopmentProfileDiagnostic(assessment) {
  const counts = [
    assessment.decodedUniqueProfileCount,
    assessment.validProfileCount,
    assessment.invalidProfileCount,
    assessment.undecodableProfileCount,
  ];
  if (counts.some((count) => !Number.isSafeInteger(count) || count < 0)) {
    throw new Error("invalid installed iOS profile diagnostic count");
  }
  const errors = Object.entries(assessment.errorCounts);
  if (
    errors.some(
      ([error, count]) =>
        !/^[a-z0-9-]+$/.test(error) ||
        !Number.isSafeInteger(count) ||
        count < 0,
    )
  ) {
    throw new Error("invalid installed iOS profile diagnostic error count");
  }
  const errorSummary = errors
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([error, count]) => `${error}:${count}`)
    .join(",");
  return [
    `decoded=${assessment.decodedUniqueProfileCount}`,
    `valid=${assessment.validProfileCount}`,
    `invalid=${assessment.invalidProfileCount}`,
    `undecodable=${assessment.undecodableProfileCount}`,
    `errors=${errorSummary || "none"}`,
  ].join(" ");
}

export function inspectInstalledIosDevelopmentProfiles(options) {
  if (typeof options.home !== "string" || options.home.length === 0) {
    throw new Error(
      "installed iOS profile preflight requires a home directory",
    );
  }

  const profileStores = [
    join(
      options.home,
      "Library/Developer/Xcode/UserData/Provisioning Profiles",
    ),
    join(options.home, "Library/MobileDevice/Provisioning Profiles"),
  ];
  const profilePaths = profileStores.flatMap((store) => {
    if (!existsSync(store)) return [];
    return readdirSync(store)
      .filter((name) =>
        [".mobileprovision", ".provisionprofile"].includes(
          extname(name).toLowerCase(),
        ),
      )
      .map((name) => join(store, name))
      .filter((path) => {
        try {
          return statSync(path).isFile();
        } catch {
          return false;
        }
      });
  });

  const candidates = profilePaths.map(decodeProfile);
  return assessInstalledIosDevelopmentProfiles(candidates, options);
}

function decodeProfile(profilePath) {
  // Verify CMS integrity here; Xcode and codesign remain authoritative for trust.
  const cms = spawnSync(
    "/usr/bin/openssl",
    ["cms", "-verify", "-noverify", "-inform", "DER", "-in", profilePath],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  if (cms.status !== 0 || !cms.stdout.includes("<plist")) return {};

  const plistXml = cms.stdout;
  const applicationIdentifier = extractPlistValue(
    plistXml,
    "Entitlements.application-identifier",
  );
  const uuid = extractPlistValue(plistXml, "UUID");
  if (!applicationIdentifier || !uuid) return {};

  const provisionsAllDevices = extractPlistValue(
    plistXml,
    "ProvisionsAllDevices",
  );
  const getTaskAllow = extractPlistValue(
    plistXml,
    "Entitlements.get-task-allow",
  );
  return {
    identity: `${uuid}\u0000${applicationIdentifier}`,
    profile: {
      teamIdentifiers: extractPlistJson(plistXml, "TeamIdentifier"),
      applicationIdentifierPrefixes: extractPlistJson(
        plistXml,
        "ApplicationIdentifierPrefix",
      ),
      duplicateEntitlementKeys: duplicateProfileEntitlementKeys(plistXml),
      entitlements: {
        applicationIdentifier,
        teamIdentifier: extractPlistValue(
          plistXml,
          "Entitlements.com\\.apple\\.developer\\.team-identifier",
        ),
        getTaskAllow:
          getTaskAllow === undefined ? undefined : getTaskAllow === "true",
        keychainAccessGroups: extractPlistJson(
          plistXml,
          "Entitlements.keychain-access-groups",
        ),
      },
      provisionedDevices: extractPlistJson(plistXml, "ProvisionedDevices"),
      provisionsAllDevices:
        provisionsAllDevices === undefined
          ? undefined
          : provisionsAllDevices === "true",
      creationTimeMs: profileDateTimeMs(
        extractPlistValue(plistXml, "CreationDate"),
      ),
      expirationTimeMs: profileDateTimeMs(
        extractPlistValue(plistXml, "ExpirationDate"),
      ),
    },
  };
}

function extractPlistJson(plistXml, key) {
  const value = extractPlistValue(plistXml, key, "json");
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function extractPlistValue(plistXml, key, format = "raw") {
  const result = spawnSync(
    "/usr/bin/plutil",
    ["-extract", key, format, "-o", "-", "-"],
    {
      encoding: "utf8",
      input: plistXml,
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: 10 * 1024 * 1024,
    },
  );
  return result.status === 0 ? result.stdout.trim() : undefined;
}
