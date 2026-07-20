#!/usr/bin/env bash
# Double-clickable LAN launcher -- the cross-machine counterpart to start.command.
# Serves the checklist to another computer on the same network (e.g. a Windows box next
# to this Mac) so that machine's browser can run the test pass and submit reports
# straight back into the project's .playtest-submissions/ here. See README.md's
# "Running it on another computer" section for the full story.
#
# Like start.command it always kills anything already on PORT and starts fresh (the
# server has no state worth preserving), then prints the URL to open on the other
# machine. Unlike start.command it does NOT open a browser here -- the page is meant to
# be opened over there, not on this Mac.
#
# TESTING_FILE and TOKEN are pinned below so tomorrow is a double-click, not a
# copy-paste of a long command. Edit TESTING_FILE to point at a different project, or
# TOKEN to rotate the shared secret (the Windows URL changes when you do).
set -euo pipefail

PORT=8792
# Pinned so this is zero-argument -- the one project with a TESTING.md today. Change to
# retarget; blank falls back to searching upward from this script's directory.
TESTING_FILE="/Users/nick.edises/claude/vintagestory-scribe/TESTING.md"
# Fixed shared token so the URL you open on Windows stays stable (bookmark it once).
# This is a home-LAN dev secret, not an internet-facing credential -- see README.
TOKEN="playtest2026"

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

EXISTING_PID="$(lsof -ti "tcp:${PORT}" 2>/dev/null || true)"
if [[ -n "$EXISTING_PID" ]]; then
  kill $EXISTING_PID 2>/dev/null || true
  sleep 0.3
fi

# -u (unbuffered) so the URL + token print immediately, not when the buffer flushes --
# the bug that hid the token when we first ran this in the background.
if [[ -n "$TESTING_FILE" ]]; then
  python3 -u "$DIR/server.py" --testing-file "$TESTING_FILE" --lan --token "$TOKEN" --port "$PORT"
else
  python3 -u "$DIR/server.py" --lan --token "$TOKEN" --port "$PORT"
fi
