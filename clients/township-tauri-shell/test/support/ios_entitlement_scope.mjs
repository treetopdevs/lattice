export function developmentEntitlementErrors(entitlements, bundleIdentifier) {
  const duplicateErrors = [
    ["application-identifier", "duplicate-application-identifier-entitlement"],
    [
      "com.apple.developer.team-identifier",
      "duplicate-team-identifier-entitlement",
    ],
    ["get-task-allow", "duplicate-get-task-allow-entitlement"],
    ["keychain-access-groups", "duplicate-keychain-scope-entitlement"],
  ]
    .filter(([key]) => countOccurrences(entitlements, `<key>${key}</key>`) > 1)
    .map(([, error]) => error);
  if (duplicateErrors.length > 0) return duplicateErrors;

  const errors = [];
  const applicationIdentifier = stringEntitlement(
    entitlements,
    "application-identifier",
  );
  const teamIdentifier = stringEntitlement(
    entitlements,
    "com.apple.developer.team-identifier",
  );

  if (!applicationIdentifier) errors.push("missing-application-identifier");
  if (!teamIdentifier) errors.push("missing-team-identifier");
  if (
    applicationIdentifier &&
    teamIdentifier &&
    applicationIdentifier !== `${teamIdentifier}.${bundleIdentifier}`
  ) {
    errors.push("application-identifier-does-not-match-team-and-bundle");
  }
  if (!/<key>get-task-allow<\/key>\s*<true\s*\/>/.test(entitlements)) {
    errors.push("not-development-entitled");
  }

  const keychainScopeKey = "<key>keychain-access-groups</key>";
  const keychainScopeCount = countOccurrences(entitlements, keychainScopeKey);
  if (keychainScopeCount === 1) {
    const groupXml = entitlements.match(
      /<key>keychain-access-groups<\/key>\s*<array>([\s\S]*?)<\/array>/,
    )?.[1];
    const groups = [
      ...(groupXml ?? "").matchAll(/<string>([^<]+)<\/string>/g),
    ].map((match) => match[1]);
    if (
      groups.length !== 1 ||
      groups[0] !== applicationIdentifier ||
      applicationIdentifier?.endsWith(".*")
    ) {
      errors.push("explicit-keychain-scope-is-not-app-exclusive");
    }
  }

  return errors;
}

function countOccurrences(text, needle) {
  let count = 0;
  let offset = 0;
  while (offset < text.length) {
    const match = text.indexOf(needle, offset);
    if (match === -1) break;
    count += 1;
    offset = match + needle.length;
  }
  return count;
}

function stringEntitlement(entitlements, key) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return entitlements.match(
    new RegExp(`<key>${escapedKey}</key>\\s*<string>([^<]+)</string>`),
  )?.[1];
}
