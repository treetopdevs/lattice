#!/usr/bin/env bash
# Point apt at a cached archive directory and admit only cached .deb files that the current
# authenticated index vouches for. Shared by the `verify` and `unit` jobs in flagship.yml, which
# restore the directory from actions/cache before this runs and save it afterwards.
#
# apt reuses an archive that is already present by file name and size alone, so a restored file
# must be re-verified here, before apt can see it: it stays only when the index lists that exact
# name, version and architecture with the same SHA256. Everything else (hash mismatch, unknown
# package, lock file, stray entries) is dropped. `partial/` is kept so apt can resume downloads it
# then hash-checks itself.
set -euo pipefail

cache="${APT_ARCHIVE_CACHE:-$HOME/.cache/apt-archives}"
mkdir -p "$cache/partial"
sudo tee /etc/apt/apt.conf.d/99lattice-ci-cache > /dev/null <<CONF
Dir::Cache::Archives "$cache";
APT::Keep-Downloaded-Packages "true";
Acquire::Retries "3";
Acquire::http::Timeout "30";
Acquire::https::Timeout "30";
CONF
sudo apt-get update

staged="${RUNNER_TEMP:-/tmp}/apt-staged"
rm -rf "$staged"
mkdir -p "$staged"
find "$cache" -mindepth 1 -maxdepth 1 ! -name partial -exec mv -t "$staged" {} +
kept=0
dropped=0
for deb in "$staged"/*.deb; do
  [ -e "$deb" ] || continue
  base=$(basename "$deb" .deb)
  # apt names archives <package>_<version>_<arch>.deb and quotes ':' in the version as %3a.
  name=${base%%_*}
  arch=${base##*_}
  ver=${base#*_}
  ver=${ver%_*}
  ver=$(printf '%b' "${ver//%/\\x}")
  expected=$( (apt-cache show "$name" 2>/dev/null || true) | awk -v v="Version: $ver" -v a="Architecture: $arch" '
    BEGIN { RS = "" }
    index("\n" $0 "\n", "\n" v "\n") && index("\n" $0 "\n", "\n" a "\n") {
      for (i = 1; i <= NF; i++) if ($i == "SHA256:") { print $(i + 1); exit }
    }')
  actual=$(sha256sum "$deb" | cut -d' ' -f1)
  if [ -n "$expected" ] && [ "$expected" = "$actual" ]; then
    mv "$deb" "$cache/"
    kept=$((kept + 1))
  else
    dropped=$((dropped + 1))
  fi
done
rm -rf "$staged"
echo "apt archive cache: kept $kept verified package(s), dropped $dropped"
