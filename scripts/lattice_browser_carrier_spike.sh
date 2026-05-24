#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

mix test apps/lattice_carrier_spike/test
mix lattice.browser_carrier.proof
