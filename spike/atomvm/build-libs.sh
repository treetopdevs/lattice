#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
SRC=AtomVM-src
if [ ! -d "$SRC/.git" ]; then
  git clone --depth 1 --branch v0.7.0-alpha.1 https://github.com/atomvm/AtomVM "$SRC"
fi
cd "$SRC"
mkdir -p build && cd build
echo "--- cmake configure ---"
cmake -G Ninja .. 2>&1 | tail -8
echo "--- build lib avms (atomvmlib, exavmlib) ---"
ninja atomvmlib exavmlib 2>&1 | tail -15
echo "--- locate produced .avm ---"
find . -name '*.avm' | head
