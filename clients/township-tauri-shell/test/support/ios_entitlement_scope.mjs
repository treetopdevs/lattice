export function developmentEntitlementErrors(entitlements, options) {
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
  const expectedApplicationIdentifier = options.expectedApplicationIdentifier;
  const expectedTeamIdentifier = options.expectedTeamIdentifier;

  if (!applicationIdentifier) errors.push("missing-application-identifier");
  if (!teamIdentifier) errors.push("missing-team-identifier");
  if (!expectedApplicationIdentifier) {
    errors.push("missing-expected-application-identifier");
  } else {
    if (
      expectedApplicationIdentifier.endsWith(".*") ||
      applicationIdentifier?.endsWith(".*")
    ) {
      errors.push("wildcard-application-identifier");
    } else {
      if (!expectedApplicationIdentifier.endsWith(`.${options.bundleIdentifier}`)) {
        errors.push("profile-application-identifier-does-not-match-bundle");
      }
      if (applicationIdentifier !== expectedApplicationIdentifier) {
        errors.push("application-identifier-does-not-match-profile");
      }
    }
  }
  if (!expectedTeamIdentifier) {
    errors.push("missing-expected-team-identifier");
  } else if (teamIdentifier !== expectedTeamIdentifier) {
    errors.push("team-identifier-does-not-match-profile");
  }
  if (!/<key>get-task-allow<\/key>\s*<true\s*\/>/.test(entitlements)) {
    errors.push("not-development-entitled");
  }

  // When this key is absent, iOS uses the exact application identifier validated above.
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
