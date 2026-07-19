#!/usr/bin/env bash
# Double-clickable launcher (Finder runs .command files in Terminal on double-click).
# Starts the playtest checklist server if it isn't already running, waits for it to
# actually respond, then opens the page in the default browser.
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

if ! curl -s -o /dev/null "$URL"; then
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
fi

open "$URL"

# Keep the server alive for as long as this Terminal window stays open (closing it
# stops the server via the trap above); if we didn't start one (already running from a
# prior launch), just exit immediately.
if [[ -n "${SERVER_PID:-}" ]]; then
  wait "$SERVER_PID"
fi
