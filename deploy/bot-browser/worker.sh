#!/usr/bin/env bash
set -euo pipefail
umask 077

export HOME=/var/lib/pengmanager-browser
export DISPLAY=:73
export XAUTHORITY=/run/pengmanager-browser/xauthority
socket=/run/pengmanager-browser/rfb.sock
profile="$HOME/profile"
mkdir -p "$profile"
touch "$XAUTHORITY"
printf 'add %s MIT-MAGIC-COOKIE-1 %s\n' "$DISPLAY" "$(mcookie)" | xauth -q -f "$XAUTHORITY"

# Only the dedicated gateway group can access the Unix RFB socket.
Xtigervnc "$DISPLAY" -auth "$XAUTHORITY" -nolisten tcp -rfbport -1 \
  -rfbunixpath "$socket" -rfbunixmode 0660 -SecurityTypes None -NoClipboard \
  -NeverShared -DisconnectClients=0 -geometry 1280x900 -depth 24 &
xpid=$!

for ((attempt = 1; attempt <= 40; attempt += 1)); do
  if [[ -S "$socket" ]] && xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then
    break
  fi
  if ! kill -0 "$xpid" 2>/dev/null; then exit 1; fi
  sleep 0.25
done
if [[ ! -S "$socket" ]] || ! xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then exit 1; fi

fluxbox &
wmpid=$!
chromium --user-data-dir="$profile" --no-first-run --no-default-browser-check --disable-sync --start-maximized about:blank &
browserpid=$!

wait -n "$xpid" "$wmpid" "$browserpid"
