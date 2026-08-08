export function duplicateProfileEntitlementKeys(profileXml) {
  if (typeof profileXml !== "string") return undefined;
  const entitlementMarkers = [
    ...profileXml.matchAll(/<key>\s*Entitlements\s*<\/key>/g),
  ];
  if (entitlementMarkers.length !== 1) {
    return entitlementMarkers.length > 1 ? ["Entitlements"] : undefined;
  }

  const marker = entitlementMarkers[0];
  const tail = profileXml.slice((marker.index ?? 0) + marker[0].length);
  const opening = tail.match(/^(?:\s|<!--[\s\S]*?-->)*<dict\b[^>]*>/);
  if (!opening) return undefined;

  const counts = new Map();
  const tokenPattern =
    /<!--[\s\S]*?-->|<dict\b[^>]*\/\s*>|<dict\b[^>]*>|<\/dict\s*>|<key\b[^>]*>([\s\S]*?)<\/key\s*>/g;
  tokenPattern.lastIndex = opening[0].length;
  let depth = 1;
  let closed = false;
  for (const token of tail.matchAll(tokenPattern)) {
    if (token[0].startsWith("<!--") || /\/\s*>$/.test(token[0])) {
      continue;
    }
    if (token[0].startsWith("<dict")) {
      depth += 1;
    } else if (token[0].startsWith("</dict")) {
      depth -= 1;
      if (depth === 0) {
        closed = true;
        break;
      }
    } else if (depth === 1) {
      const key = decodeXmlText(token[1]);
      if (key === undefined) return undefined;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  if (!closed) return undefined;
  return [...counts]
    .filter(([, count]) => count > 1)
    .map(([key]) => key);
}

export function profileDateTimeMs(value) {
  if (typeof value !== "string") return Number.NaN;
  const match =
    /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,3}))?Z$/.exec(
      value,
    );
  if (!match) return Number.NaN;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return Number.NaN;
  const expectedIso = `${match[1]}.${(match[2] ?? "").padEnd(3, "0")}Z`;
  return new Date(parsed).toISOString() === expectedIso ? parsed : Number.NaN;
}

export function developmentProfileErrors(profile, options) {
  if (!nonemptyString(options.expectedTeamIdentifier)) {
    return ["missing-expected-team"];
  }
  if (!Array.isArray(profile.duplicateEntitlementKeys)) {
    return ["invalid-profile-entitlement-evidence"];
  }
  if (profile.duplicateEntitlementKeys.length > 0) {
    return ["duplicate-profile-entitlement"];
  }

  const errors = [];
  const teamIdentifier = singleNonemptyString(profile.teamIdentifiers);
  const applicationIdentifierPrefix = singleNonemptyString(
    profile.applicationIdentifierPrefixes,
  );
  if (!teamIdentifier) errors.push("ambiguous-profile-team");
  if (!applicationIdentifierPrefix)
    errors.push("ambiguous-application-identifier-prefix");
  if (!teamIdentifier || !applicationIdentifierPrefix) return errors;
  if (teamIdentifier !== options.expectedTeamIdentifier) {
    errors.push("profile-team-does-not-match-expected-team");
  }

  const entitlements =
    profile.entitlements &&
    typeof profile.entitlements === "object" &&
    !Array.isArray(profile.entitlements)
      ? profile.entitlements
      : {};
  const applicationIdentifier = nonemptyString(
    entitlements.applicationIdentifier,
  );
  const entitlementTeamIdentifier = nonemptyString(
    entitlements.teamIdentifier,
  );
  const expectedApplicationIdentifier = `${applicationIdentifierPrefix}.${options.bundleIdentifier}`;

  if (profile.provisionsAllDevices === true)
    errors.push("enterprise-profile-not-supported");
  if (!Array.isArray(profile.provisionedDevices)) {
    errors.push("missing-provisioned-devices");
  } else if (
    !profile.provisionedDevices.some(
      (device) =>
        typeof device === "string" &&
        device.toUpperCase() === options.deviceUdid.toUpperCase(),
    )
  ) {
    errors.push("device-not-provisioned");
  }

  if (!applicationIdentifier) {
    errors.push("missing-profile-application-identifier");
  } else {
    if (applicationIdentifier.endsWith(".*"))
      errors.push("wildcard-profile-application-identifier");
    if (!applicationIdentifier.startsWith(`${applicationIdentifierPrefix}.`)) {
      errors.push("profile-application-identifier-prefix-mismatch");
    }
    if (applicationIdentifier !== expectedApplicationIdentifier) {
      errors.push("profile-application-identifier-does-not-match-bundle");
    }
  }
  if (!entitlementTeamIdentifier) {
    errors.push("missing-profile-team-identifier");
  } else if (entitlementTeamIdentifier !== teamIdentifier) {
    errors.push("profile-entitlement-team-not-authorized");
  }
  if (entitlements.getTaskAllow !== true)
    errors.push("not-development-profile");

  const keychainAccessGroups = entitlements.keychainAccessGroups;
  if (
    keychainAccessGroups !== undefined &&
    (!Array.isArray(keychainAccessGroups) ||
      keychainAccessGroups.length === 0 ||
      keychainAccessGroups.some((group) => typeof group !== "string") ||
      !keychainAccessGroups.some(
        (group) =>
          group === applicationIdentifier ||
          group === `${applicationIdentifierPrefix}.*`,
      ))
  ) {
    errors.push("invalid-profile-keychain-scope");
  }

  if (!Number.isFinite(profile.creationTimeMs)) {
    errors.push("invalid-profile-creation-date");
  } else if (profile.creationTimeMs > options.nowMs) {
    errors.push("profile-creation-date-in-future");
  }
  if (!Number.isFinite(profile.expirationTimeMs)) {
    errors.push("invalid-profile-expiration-date");
  } else if (
    profile.expirationTimeMs - options.nowMs <
    options.minimumRemainingMs
  ) {
    errors.push("profile-lifetime-too-short");
  }

  return errors;
}

function decodeXmlText(value) {
  if (/<[^>]+>/.test(value)) return undefined;
  let invalid = false;
  const decoded = value.replace(
    /&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g,
    (_entity, body) => {
      if (body === "amp") return "&";
      if (body === "lt") return "<";
      if (body === "gt") return ">";
      if (body === "quot") return '"';
      if (body === "apos") return "'";
      const codePoint = Number.parseInt(
        body.slice(body.startsWith("#x") ? 2 : 1),
        body.startsWith("#x") ? 16 : 10,
      );
      if (!Number.isSafeInteger(codePoint) || codePoint > 0x10ffff) {
        invalid = true;
        return "";
      }
      return String.fromCodePoint(codePoint);
    },
  );
  return invalid || /&[^;]*;/.test(decoded) ? undefined : decoded;
}

function singleNonemptyString(value) {
  if (!Array.isArray(value) || value.length !== 1) return undefined;
  return nonemptyString(value[0]);
}

function nonemptyString(value) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
