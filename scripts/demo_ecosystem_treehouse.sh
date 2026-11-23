#!/usr/bin/env bash
set -euo pipefail

# Launches a Treehouse desktop demo instance (dev-trace enrollment profile)
# wired to an isolated data directory and participant identity from the unified
# local demo relay (`scripts/demo_ecosystem_relay.sh`).
#
# Usage:
#   scripts/demo_ecosystem_treehouse.sh [founder|neighbor] [--build-only] [--dir <path>]
#
# Security / honesty note:
#   Assisted local demo profile using static routes (EnrollmentPanel) and
#   deterministic dev-trace seeds. Ordinary production builds stay untouched.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ROLE="founder"
BUILD_ONLY=0
DEMO_DIR="${DEMO_ECOSYSTEM_DIR:-output/demo_ecosystem}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    founder|neighbor)
      ROLE="$1"
      shift
      ;;
    --build-only)
      BUILD_ONLY=1
      shift
      ;;
    --dir)
      DEMO_DIR="$2"
      shift 2
      ;;
    *)
      echo "usage: $0 [founder|neighbor] [--build-only] [--dir <path>]" >&2
      exit 64
      ;;
  esac
done

if [[ "$DEMO_DIR" != /* ]]; then
  DEMO_DIR="$ROOT_DIR/$DEMO_DIR"
fi

SEED_FILE="$DEMO_DIR/identities/participant_${ROLE}.seed"
ROUTES_FILE="$DEMO_DIR/treehouse-routes-${ROLE}.json"
DATA_DIR="$DEMO_DIR/treehouse_desktop_${ROLE}"

if [[ ! -f "$SEED_FILE" || ! -f "$ROUTES_FILE" ]]; then
  echo "Missing demo relay artifacts in $DEMO_DIR." >&2
  echo "Start scripts/demo_ecosystem_relay.sh first." >&2
  exit 1
fi

mkdir -p "$DATA_DIR"
chmod 700 "$DATA_DIR"

APP_BIN="$ROOT_DIR/clients/treehouse-tauri-shell/src-tauri/target/release/bundle/macos/Treehouse.app/Contents/MacOS/treehouse-tauri-shell"

if [[ "$BUILD_ONLY" -eq 1 || ! -x "$APP_BIN" ]]; then
  echo "Building Treehouse desktop demo variant (enrollment + dev-trace)..."
  npm --prefix clients/lattice-client run build
  npm --prefix clients/treehouse-tauri-shell run tauri:build:dev-trace
fi

if [[ "$BUILD_ONLY" -eq 1 ]]; then
  echo "Treehouse demo variant built at: $APP_BIN"
  exit 0
fi

SEED_HEX="$(tr -d '[:space:]' < "$SEED_FILE")"

echo "Launching Treehouse desktop demo for role '${ROLE}'"
echo "  Data dir:    $DATA_DIR"
echo "  Routes JSON: $ROUTES_FILE"
echo ""
echo "Paste the contents of $ROUTES_FILE into the Enrollment panel's Relay Routes field:"
cat "$ROUTES_FILE"
echo ""

export TREEHOUSE_DEV_DATA_DIR="$DATA_DIR"
export TREEHOUSE_DEV_CARRIER_SEED="$SEED_HEX"

exec "$APP_BIN"
