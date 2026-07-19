#!/usr/bin/env bash
# Double-clickable launcher (Finder runs .command files in Terminal on double-click).
# Always kills anything already on PORT and starts a fresh server, then opens the page
# in the default browser. Deliberately does NOT reuse an already-running server on that
# port -- server.py has no state worth preserving (submissions are written to disk
# immediately, the checklist is re-parsed from TESTING.md on every request), so reusing
# a stale process just means silently serving old code after a `git pull`/edit to this
# app. Killing and restarting every launch keeps that from ever being a surprise.
#
# By default, serves whichever project's TESTING.md this script was set up for -- see
# TESTING_FILE below. Copy/symlink this script per-project and edit that one line, or
# just run `python3 server.py` yourself from within a project root.
set -euo pipefail

PORT=8792
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
URL="http://localhost:${PORT}/index.html"

# Edit this to point at a specific project, or leave blank to search upward from
# wherever this script happens to be run from.
TESTING_FILE=""

EXISTING_PID="$(lsof -ti "tcp:${PORT}" 2>/dev/null || true)"
if [[ -n "$EXISTING_PID" ]]; then
  kill $EXISTING_PID 2>/dev/null || true
  sleep 0.3
fi

if [[ -n "$TESTING_FILE" ]]; then
  python3 "$DIR/server.py" --testing-file "$TESTING_FILE" --port "$PORT" &
else
  python3 "$DIR/server.py" --port "$PORT" &
fi
SERVER_PID=$!
trap 'kill "$SERVER_PID" 2>/dev/null' EXIT

for _ in $(seq 1 30); do
  if curl -s -o /dev/null "$URL"; then
    break
  fi
  sleep 0.2
done

open "$URL"

# Keep the server alive for as long as this Terminal window stays open -- closing it
# stops the server via the trap above.
wait "$SERVER_PID"
