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
# default a fresh mktemp directory), R389_MUTANT_TESTS (space-separated test files replacing the
# default property suites, e.g. the scenario files, so a kill can name the scenario), and
# R389_CONTROL=1 (also run an unmutated copy first; every mutant verdict is read against it).
#
# Recorded results on head d60d50c45 (seed 1; the control copy ran 33 properties, 161 tests, 0
# failures in about 1000 s under load, so each mutant takes 15 to 20 minutes):
#   control                          SURVIVED (correct)
#   m1_merge_floor_first_prior_wins  KILLED
#   m5_stage_a_not_intrinsic         KILLED
#   m6_escape_direct_parents_only    KILLED
#   m7_floor_join_no_dedup           ERROR: the test VM was killed (signal 9, memory blow-up from the
#                                    undeduplicated join). It is not a clean property kill.
#   m8_floor_no_memo                 NOT RUN (stopped mid-run; over the 10 minute budget)
#   m9_entry_facts_ignored           NOT RUN
#   m10_entry_quarantine_incomplete  NOT RUN
#   m11_step4_rejudged_on_union      KILLED (row 321, on head 664ef239d over lib 915cba5bc, not
#                                    d60d50c45; runs 60, seed 1, R389_MUTANT_TESTS set to
#                                    catalog_resolution_property_test.exs only, about 5 minutes):
#                                    M (its d279 check names the accepted candidate as raw
#                                    evidence), M exercise, S1, S1F and S2
# m2 to m4 are not covered by this table. Patches m5 to m10 target the four pass-2 fixes
# (Stage A prefix, D-275 escape, floor dedupe, floor memo) and the row 390 entry-fact fixes.
# m11 (row 321) targets D-279 itself: step 4's own-closure Core judgment re-read from the full
# union analysis, the "immutable check judged against growing evidence" class. Expected KILLED
# by property M's d279 check (an accepted candidate becomes raw evidence) or by the deterministic
# "M exercise" test, with R389_MUTANT_TESTS set to catalog_resolution_property_test.exs.
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
if [ -n "${R389_MUTANT_TESTS:-}" ]; then read -r -a TESTS <<<"$R389_MUTANT_TESTS"; fi
if [ "${R389_CONTROL:-0}" = "1" ]; then PATCHES=(control "${PATCHES[@]}"); fi

summary=()
for patch in "${PATCHES[@]}"; do
  name=$(basename "$patch" .patch)
  dest="$PARENT/$name"
  rm -rf "$dest"
  mkdir -p "$dest"
  # The BEAM tests read the catalog vectors under clients/, so copy those (only).
  rsync -a --exclude .git --exclude clients --exclude .claude --exclude node_modules --exclude _build/test/consolidated "$ROOT/" "$dest/"
  mkdir -p "$dest/clients/lattice-client/test"
  rsync -a "$ROOT/clients/lattice-client/test/vectors" "$dest/clients/lattice-client/test/"
  if [ "$patch" != control ]; then
    if ! (cd "$dest" && patch -p1 --forward --silent < "$patch"); then
      echo "PATCH FAILED TO APPLY: $name" >&2
      exit 2
    fi
    grep -q "MUTANT" "$dest/apps/lattice_core/lib/treehouse/catalog_binding_graph.ex" || {
      echo "PATCH APPLIED NOTHING: $name" >&2
      exit 2
    }
  fi
  log="$PARENT/$name.log"
  (cd "$dest" && MIX_ENV=test "$MIX" compile >/dev/null 2>&1 &&
    R389_RUNS="$RUNS" MIX_ENV=test "$MIX" test "${TESTS[@]}" --seed "$SEED") >"$log" 2>&1 || true
  failed=$(grep -E '^\s+[0-9]+\) (property|test) ' "$log" | sed -E 's/^ +[0-9]+\) (property|test) ([^(]+) \(.*/\2/' | sort -u | tr '\n' ';' || true)
  # ExUnit prints "N properties, M tests, K failures", or "M tests, K failures" for scenario files.
  result=$(grep -E '^([0-9]+ propert(y|ies), )?([0-9]+ tests?, )?[0-9]+ failures?' "$log" | tail -1 || true)
  if [ -n "$failed" ]; then verdict="KILLED by: $failed"; else verdict="SURVIVED"; fi
  if [ -z "$result" ]; then verdict="ERROR (see $log)"; fi
  summary+=("$name: $verdict [$result]")
  echo "$name: $verdict [$result] (log $log)"
done

echo
echo "== mutation summary (runs=$RUNS seed=$SEED) =="
printf '%s\n' "${summary[@]}"
