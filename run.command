#!/bin/sh
# Double-click this in Finder, or run ./run.command from a terminal.
#
# Starts a local web server in this folder and opens the visualizer.
# It has to be served over http://localhost — browsers refuse camera and
# microphone access to pages opened directly from a file:// path.

cd "$(dirname "$0")" || exit 1

PREFERRED_PORT=8137
DRY_RUN=0
[ "$1" = "--dry-run" ] && DRY_RUN=1

port_free() {
  # lsof is on every macOS install; fall back to assuming free if it is not
  command -v lsof >/dev/null 2>&1 || return 0
  ! lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1
}

PORT=""
for p in $PREFERRED_PORT 8138 8139 8140 8141; do
  if port_free "$p"; then PORT="$p"; break; fi
done
if [ -z "$PORT" ]; then
  echo "Could not find a free port in 8137-8141."
  echo "Something is already listening on all of them."
  exit 1
fi

# Camera and microphone permission is granted per origin, and the port is part
# of the origin. Landing on a different port means granting permission again.
if [ "$PORT" != "$PREFERRED_PORT" ]; then
  echo "Note: port $PREFERRED_PORT was busy, using $PORT instead."
  echo "The browser will ask for camera access again on this new port."
  echo
fi

if command -v python3 >/dev/null 2>&1; then
  CMD="python3 -m http.server $PORT"
elif command -v python >/dev/null 2>&1; then
  CMD="python -m SimpleHTTPServer $PORT"
elif command -v npx >/dev/null 2>&1; then
  CMD="npx --yes serve -l $PORT ."
elif command -v ruby >/dev/null 2>&1; then
  CMD="ruby -run -e httpd . -p $PORT"
else
  echo "No web server available."
  echo "Install Python 3 (it ships with macOS developer tools):"
  echo "    xcode-select --install"
  exit 1
fi

URL="http://localhost:$PORT"
echo "nomu visualizer"
echo "  serving  $(pwd)"
echo "  at       $URL"
echo "  using    $CMD"
echo
echo "Leave this window open while you use it. Ctrl-C here to stop."
echo

if [ "$DRY_RUN" = "1" ]; then
  echo "(dry run - nothing started)"
  exit 0
fi

# open the browser once the server is actually accepting connections
( for _ in 1 2 3 4 5 6 7 8 9 10; do
    if ! port_free "$PORT"; then break; fi
    sleep 0.3
  done
  if command -v open >/dev/null 2>&1; then open "$URL"; fi ) &

exec $CMD
