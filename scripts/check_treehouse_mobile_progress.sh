#!/usr/bin/env bash
# Fails when a change touches clients/treehouse-mobile/ or docs/treehouse-mobile/ without also
# updating docs/treehouse-mobile/PROGRESS.md.
#
#   scripts/check_treehouse_mobile_progress.sh            # staged changes (use before committing)
#   scripts/check_treehouse_mobile_progress.sh --worktree # staged, unstaged and untracked changes
#   scripts/check_treehouse_mobile_progress.sh <range>    # each commit in a range, e.g. origin/main..HEAD
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
progress="docs/treehouse-mobile/PROGRESS.md"
watched='^(clients/treehouse-mobile/|docs/treehouse-mobile/)'
# The M0 scaffold commit predates PROGRESS.md. Range mode skips it and everything before it.
baseline="bd9ddcc550bfc75f08033443880d1bb27f099bbe"

check() { # $1 = label, stdin = changed paths
  local files
  files="$(cat)"
  if grep -Eq "$watched" <<<"$files" && ! grep -Fxq "$progress" <<<"$files"; then
    echo "treehouse-mobile progress check: $1 changes the mobile client or its docs but not $progress" >&2
    return 1
  fi
}

case "${1:-}" in
  "")
    git diff --cached --name-only | check "the staged change"
    ;;
  --worktree)
    { git diff --name-only HEAD; git ls-files --others --exclude-standard; } | check "the working tree"
    ;;
  *)
    status=0
    exclude=()
    if git cat-file -e "$baseline^{commit}" 2>/dev/null; then exclude=("^$baseline"); fi
    for commit in $(git rev-list --no-merges "$1" ${exclude[@]+"${exclude[@]}"}); do
      git diff-tree --no-commit-id --name-only -r "$commit" \
        | check "commit $(git log -1 --format='%h %s' "$commit")" || status=1
    done
    [ "$status" -eq 0 ] || exit "$status"
    ;;
esac
echo "treehouse-mobile progress check: ok"
