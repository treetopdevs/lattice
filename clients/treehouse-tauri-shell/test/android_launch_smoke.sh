#!/usr/bin/env bash
# Row 192: launch the Treehouse debug APK on a booted emulator and fail if the app
# panics, is gone after the settle window, or never rendered the page. A compile-only job
# cannot see the wry main-pipe panic that killed every launch about 11 s in.
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

pid="$("$adb" shell pidof "$pkg" | tr -d '\r' || true)"
echo "launched pid=${pid:-none}"
sleep "$settle"

"$adb" logcat -d -v threadtime > "$out/logcat.txt"
"$adb" exec-out screencap -p > "$out/screen.png" || true
alive="$("$adb" shell pidof "$pkg" | tr -d '\r' || true)"
# The WebView exposes rendered text to accessibility, so this proves the page loaded. Its
# nodes can be missing from the first dump, so retry briefly.
for _ in 1 2 3 4 5; do
  "$adb" shell uiautomator dump /sdcard/treehouse-ui.xml > /dev/null || true
  "$adb" shell cat /sdcard/treehouse-ui.xml > "$out/ui.xml" || true
  grep -qF 'text="Treehouse"' "$out/ui.xml" && break
  sleep 2
done
echo "pid after ${settle}s=${alive:-none}"

status=0
if grep -nE "panicked at|E RustPanic|FATAL EXCEPTION|Fatal signal" "$out/logcat.txt"; then
  echo "Treehouse panicked or crashed after launch" >&2
  status=1
fi
if [ -z "$pid" ] || [ "$alive" != "$pid" ]; then
  echo "Treehouse process did not survive ${settle}s (launched ${pid:-none}, now ${alive:-none})" >&2
  status=1
fi
for text in 'text="Treehouse"' 'text="Local preview"'; do
  if ! grep -qF "$text" "$out/ui.xml"; then
    echo "Treehouse page never rendered ($text missing from the accessibility tree)" >&2
    status=1
  fi
done
exit "$status"
