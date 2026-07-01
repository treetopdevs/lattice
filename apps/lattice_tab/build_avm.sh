#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
TAG=v0.7.0-alpha.1
MIX=~/.asdf/shims/mix; ERLC=~/.asdf/shims/erlc; ESCRIPT=~/.asdf/shims/escript
APP="$ROOT/apps/lattice_tab"
STAGE="$ROOT/examples/atomvm_tab"
WORK="$APP/.atomvm_build"; mkdir -p "$WORK"

# (a) VM bundle — fetch + verify against the pinned hashes.
gh release download "$TAG" --repo atomvm/AtomVM --pattern 'AtomVM-web-*' --dir "$WORK/vendor" --clobber
( cd "$WORK/vendor" && shasum -a 256 -c AtomVM-web-$TAG.js.sha256 AtomVM-web-$TAG.wasm.sha256 )

# (b) stdlib + bridge libs from source (cmake/ninja — host tools).
SRC="$WORK/AtomVM-src"
[ -d "$SRC/.git" ] || git clone --depth 1 --branch "$TAG" https://github.com/atomvm/AtomVM "$SRC"
( cd "$SRC" && mkdir -p build && cd build && cmake -G Ninja .. >/dev/null && ninja atomvmlib exavmlib )

# (c) pack the app .avm: compile the emscripten/websocket beams + app beams, pack together.
( cd "$APP" && "$MIX" deps.get )
( cd "$APP" && "$MIX" do compile, atomvm.packbeam )   # -> apps/lattice_tab/lattice_tab.avm
"$ERLC" -o "$WORK/beams" "$SRC"/libs/avm_emscripten/src/{emscripten,websocket}.erl
"$ESCRIPT" "$SRC/build/tools/packbeam/packbeam" create "$WORK/app_full.avm" \
  "$APP/lattice_tab.avm" "$WORK/beams/emscripten.beam" "$WORK/beams/websocket.beam"

# (d) stage into examples/atomvm_tab/ (names match the static_handler whitelist).
cp "$WORK/vendor/AtomVM-web-$TAG.js"   "$STAGE/AtomVM-web-$TAG.js"
cp "$WORK/vendor/AtomVM-web-$TAG.wasm" "$STAGE/AtomVM-web-$TAG.wasm"
cp "$WORK/app_full.avm"                "$STAGE/lattice_tab.avm"
cp "$SRC/build/libs/atomvmlib.avm"     "$STAGE/atomvmlib.avm"
cp "$SRC/build/libs/exavmlib/lib/exavmlib.avm" "$STAGE/exavmlib.avm"
echo "staged AtomVM tab assets -> $STAGE"
