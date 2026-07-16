export interface TownshipStorageSecretFinding {
  storageKey: string;
  path: string;
  reason: "secret_needle" | "secret_field";
  match: string;
}

const SECRET_FIELD = /(^|[_-])(seed|private|secret|mnemonic|pkcs8|signing[_-]?key|carrier[_-]?seed)([_-]|$)/i;

export function townshipKvSecretFindings(
  entries: Iterable<readonly [string, string]>,
  secretNeedles: readonly string[] = [],
): TownshipStorageSecretFinding[] {
  const needles = [...new Set(secretNeedles.filter((needle) => needle.length >= 8))];
  const findings: TownshipStorageSecretFinding[] = [];

  for (const [storageKey, rawValue] of entries) {
    for (const needle of needles) {
      if (rawValue.includes(needle)) {
        findings.push({ storageKey, path: "$", reason: "secret_needle", match: redacted(needle) });
      }
    }

    try {
      scanJson(JSON.parse(rawValue), "$", storageKey, findings);
    } catch {
      scanText(rawValue, storageKey, findings);
    }
  }

  return findings;
}

export function assertTownshipKvStoresNoSecrets(
  entries: Iterable<readonly [string, string]>,
  secretNeedles: readonly string[] = [],
): void {
  const findings = townshipKvSecretFindings(entries, secretNeedles);
  if (findings.length === 0) return;

  const summary = findings
    .map((finding) => `${finding.storageKey}${finding.path}: ${finding.reason} ${finding.match}`)
    .join("; ");
  throw new Error(`Township app storage contains secret material: ${summary}`);
}

function scanJson(
  value: unknown,
  path: string,
  storageKey: string,
  findings: TownshipStorageSecretFinding[],
): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => scanJson(item, `${path}[${index}]`, storageKey, findings));
    return;
  }

  if (value === null || typeof value !== "object") return;

  for (const [key, nested] of Object.entries(value)) {
    const nestedPath = `${path}.${key}`;
    if (SECRET_FIELD.test(key)) {
      findings.push({ storageKey, path: nestedPath, reason: "secret_field", match: key });
    }
    scanJson(nested, nestedPath, storageKey, findings);
  }
}

function scanText(
  value: string,
  storageKey: string,
  findings: TownshipStorageSecretFinding[],
): void {
  const match = value.match(SECRET_FIELD);
  if (match?.[0]) findings.push({ storageKey, path: "$", reason: "secret_field", match: match[0] });
}

function redacted(value: string): string {
  return value.length <= 12 ? "<redacted>" : `${value.slice(0, 4)}...${value.slice(-4)}`;
}
