#!/usr/bin/env bash
set -euo pipefail
# Product jobs may be skipped by classification. These jobs must run on every event.
if ! jq -e '
  type == "object" and
  (.changes.result == "success") and
  (.unit.result == "success") and
  (.treehouse_native.result == "success") and
  (to_entries | all(.value.result == "success" or .value.result == "skipped"))
' <<< "$RESULTS" > /dev/null; then
  echo "a required job failed, was cancelled, or did not complete as required:" >&2
  printf '%s\n' "$RESULTS" >&2
  exit 1
fi
echo "required jobs succeeded; only path-gated product jobs may be skipped"
