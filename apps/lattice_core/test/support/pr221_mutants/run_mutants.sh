#!/usr/bin/env bash
# PR #221 row 389 mutation check for the replacement resolver properties.
#
# Each patch in this directory is applied to a scratch COPY of the checkout (never to this
# worktree's lib), compiled under MIX_ENV=test, and the default (green-on-head) property suites
# are run against it. A mutant is killed when at least one of those properties fails. Properties
# tagged :pr221_open are red on the head and are excluded, so they cannot count as kills.
#
# Usage (from the repository root):
#   apps/lattice_core/test/support/pr221_mutants/run_mutants.sh [RUNS] [SEED] [PATCH...]
# Environment: MIX (default ~/.asdf/shims/mix), R389_MUTANT_DIR (scratch parent directory;
# default a fresh mktemp directory).
set -euo pipefail

ROOT=$(git rev-parse --show-toplevel)
HERE="$ROOT/apps/lattice_core/test/support/pr221_mutants"
MIX=${MIX:-$HOME/.asdf/shims/mix}
RUNS=${1:-60}
SEED=${2:-1}
shift $(( $# > 2 ? 2 : $# )) || true
PATCHES=("$@")
if [ ${#PATCHES[@]} -eq 0 ]; then PATCHES=("$HERE"/*.patch); fi
PARENT=${R389_MUTANT_DIR:-$(mktemp -d)}
TESTS=(
  apps/lattice_core/test/treehouse/catalog_resolution_property_test.exs
  apps/lattice_core/test/treehouse/catalog_binding_graph_generated_differential_test.exs
)

summary=()
for patch in "${PATCHES[@]}"; do
  name=$(basename "$patch" .patch)
  dest="$PARENT/$name"
  rm -rf "$dest"
  mkdir -p "$dest"
  rsync -a --exclude .git --exclude clients --exclude .claude --exclude node_modules --exclude _build/test/consolidated "$ROOT/" "$dest/"
  if ! (cd "$dest" && patch -p1 --forward --silent < "$patch"); then
    echo "PATCH FAILED TO APPLY: $name" >&2
    exit 2
  fi
  grep -q "MUTANT" "$dest/apps/lattice_core/lib/treehouse/catalog_binding_graph.ex" || {
    echo "PATCH APPLIED NOTHING: $name" >&2
    exit 2
  }
  log="$PARENT/$name.log"
  (cd "$dest" && MIX_ENV=test "$MIX" compile >/dev/null 2>&1 &&
    R389_RUNS="$RUNS" MIX_ENV=test "$MIX" test "${TESTS[@]}" --seed "$SEED") >"$log" 2>&1 || true
  failed=$(grep -E '^\s+[0-9]+\) property ' "$log" | sed -E 's/^ +[0-9]+\) property ([A-Z0-9-]+):.*/\1/' | sort -u | tr '\n' ' ' || true)
  result=$(grep -E '^[0-9]+ propert(y|ies), [0-9]+ failures?' "$log" | tail -1 || true)
  if [ -n "$failed" ]; then verdict="KILLED by: $failed"; else verdict="SURVIVED"; fi
  if [ -z "$result" ]; then verdict="ERROR (see $log)"; fi
  summary+=("$name: $verdict [$result]")
  echo "$name: $verdict [$result] (log $log)"
done

echo
echo "== mutation summary (runs=$RUNS seed=$SEED) =="
printf '%s\n' "${summary[@]}"
