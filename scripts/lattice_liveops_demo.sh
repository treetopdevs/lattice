#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

OUT="${LATTICE_LIVEOPS_OUT:-output/liveops}"
rm -rf "$OUT"
mkdir -p "$OUT"

if [[ "${LATTICE_SKIP_DEPS:-0}" != "1" ]]; then
  mix deps.get
  npm ci
fi

if [[ "${LATTICE_SKIP_PLAYWRIGHT_INSTALL:-0}" != "1" ]]; then
  npx playwright install chromium
fi

mix lattice.liveops.proof --out "$OUT"
LATTICE_LIVEOPS_OUT="$OUT" npm run liveops:e2e

printf "\nLiveOps demo artifacts:\n"
printf "  topology JSON: %s/liveops-topology.json\n" "$OUT"
printf "  topology Mermaid: %s/liveops-topology.mmd\n" "$OUT"
printf "  audit JSON: %s/liveops-audit.json\n" "$OUT"
printf "  proof summary: %s/liveops-summary.json\n" "$OUT"
printf "  E2E summary: %s/liveops-e2e-summary.json\n" "$OUT"
printf "  screenshot: %s/liveops-stage.png\n" "$OUT"
printf "  recording directory: %s\n" "$OUT"
