#!/usr/bin/env bash
# Row 192: launch the Treehouse debug APK on a booted emulator and fail if the app
# panics or is gone after the settle window. A compile-only job cannot see the wry
# main-pipe panic that killed every launch about 11 s in.
# Usage: android_launch_smoke.sh <apk> <out-dir> [settle-seconds]
set -euo pipefail

apk="$1"
out="$2"
settle="${3:-40}"
pkg="dev.treetop.lattice.treehouse"
adb="${ADB:-adb}"

mkdir -p "$out"
"$adb" wait-for-device
until [ "$("$adb" shell getprop sys.boot_completed | tr -d '\r')" = "1" ]; do sleep 2; done

"$adb" install -r "$apk"
"$adb" logcat -c
"$adb" shell input keyevent 82 || true
"$adb" shell am start -W -n "$pkg/.MainActivity" | tee "$out/am-start.txt"
grep -q "Status: ok" "$out/am-start.txt"

pid="$("$adb" shell pidof "$pkg" | tr -d '\r')"
echo "launched pid=${pid:-none}"
sleep "$settle"

"$adb" logcat -d -v threadtime > "$out/logcat.txt"
"$adb" exec-out screencap -p > "$out/screen.png" || true
alive="$("$adb" shell pidof "$pkg" | tr -d '\r')"
echo "pid after ${settle}s=${alive:-none}"

status=0
if grep -nE "panicked at|E RustPanic|FATAL EXCEPTION" "$out/logcat.txt"; then
  echo "Treehouse panicked or crashed after launch" >&2
  status=1
fi
if [ -z "$pid" ] || [ "$alive" != "$pid" ]; then
  echo "Treehouse process did not survive ${settle}s (launched ${pid:-none}, now ${alive:-none})" >&2
  status=1
fi
exit "$status"
