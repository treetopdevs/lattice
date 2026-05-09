#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."
mix lattice.server "${1:-4040}"
