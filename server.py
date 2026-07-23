#!/usr/bin/env python3
"""Local dev server for the playtest checklist app: serves its own static files, parses
a project's TESTING.md into structured JSON for the page to render, and accepts
submitted test reports as a queue file for later review by an AI agent (or a human).

This tool is project-agnostic -- it doesn't live inside the project it tests. Point it
at any project's TESTING.md via --testing-file, or run it with your shell's cwd set to
a project root that has one (it searches upward from cwd, the way `git` finds `.git`).

Usage:
    python3 server.py [--testing-file PATH] [--port PORT] [--lan] [--token TOKEN]

    # From within a project root that has TESTING.md:
    python3 /path/to/vs-playtest-checklist/server.py

    # Or point it explicitly at another project:
    python3 server.py --testing-file ~/some-other-project/TESTING.md

    # Serve to another computer on the same network (prints a URL + access token to
    # open there). Binds all interfaces and requires a token on /api/* requests; plain
    # localhost use is unchanged and needs no token.
    python3 server.py --lan

By default the server binds localhost only. --lan binds all interfaces so another
machine on the same network can run the checklist in its browser and submit reports
straight back into this project's .playtest-submissions/ (no sync). Because that opens
the write endpoints to the network, --lan auto-generates a shared token that every
/api/* request must carry (in the ?token= query param or an X-Playtest-Token header).

Endpoints:
    GET  /api/meta       -> {"projectName": ..., "testingFilePath": ..., "found": bool,
                             "pendingSubmissions": int} -- the last is the count of
                             submitted reports not yet moved to .playtest-submissions/
                             reviewed/, i.e. still awaiting an agent's review.
    GET  /api/checklist  -> parsed TESTING.md as JSON (groups of items, each with its
                             fingerprint, task id, description text, current checked
                             state, the list of agent-written annotation entries (one per
                             timeline bullet: {label, kind, text}), and latestKind -- the
                             kind of the most recent verdict-bearing entry, which drives
                             the item's tab bucket).
    POST /api/submit     -> body is the full submitted form (per-item pass/fail/unsure
                             + notes, plus general notes); written verbatim (plus a
                             server-stamped timestamp) to
                             <project-root>/.playtest-submissions/<timestamp>.json --
                             stored alongside the *project*, not this tool, so an
                             agent reviewing that project finds its own submissions
                             there. Never writes to TESTING.md directly -- that file's
                             checkmarks are meant to be agent-written only (confirmed
                             from real evidence), so a submission here is a claim/report
                             queued for review, not an authoritative confirmation on its
                             own.
    POST /api/screenshot?fingerprint=<id> -> body is the raw image bytes (paste target
                             on the page uploads immediately, not held until Submit).
                             Written to
                             <project-root>/.playtest-submissions/screenshots/
                             <timestamp>-<fingerprint>[-N].<ext>. Returns
                             {"ok": true, "file": "<name>"} (bare filename, relative to
                             that screenshots/ dir); the page stores it on the item and
                             includes it in the submitted report JSON, and can re-fetch
                             it for a thumbnail via GET /api/screenshots/<name> below --
                             an agent reviewing the report can open the file directly
                             instead of unpacking a blob.
    GET  /api/screenshots/<name> -> serves a previously-uploaded screenshot back
                             (thumbnail preview on the page). Bare filename only --
                             rejects anything containing a path separator.

Deliberately stdlib-only, no build tooling -- this is a tiny local tool, not a shipped
app.
"""
import argparse
import http.server
import json
import mimetypes
import os
import re
import secrets
import socket
import sys
import time
import urllib.parse

TOOL_DIR = os.path.dirname(os.path.abspath(__file__))

ITEM_RE = re.compile(r"^- \[( |x)\] `([0-9a-f]{8})` (.*)$")
HEADING_RE = re.compile(r"^## (.+)$")
# A bullet under an item is one timeline entry: `- **<bold label>:** <body...>`. The label
# is whatever the agent bolded (e.g. "Still broken 2026-07-22", "Deferred 2026-07-22", "Debug
# aids staged 2026-07-22"); the body is the prose after it, which may itself contain **bold**
# runs -- hence the non-greedy `(.+?)` stops at the FIRST `**`, so only the lead is the label.
# An item accumulates a LIST of these across passes; the page renders each on its own line
# (see app.js) instead of mashing the whole history into one blob.
ANNOTATION_ENTRY_RE = re.compile(r"^\s+- \*\*(.+?)\*\*:?\s*(.*)$")
# When an entry's label STARTS with one of these verdict phrases, that entry carries a
# lifecycle kind (below); the item's bucket is derived from its most recent kinded entry.
# Entries with any other lead (e.g. "Deferred", "Target defined") are freeform progress
# notes -- kind stays null, they don't move the item between tabs. `\b` so "Confirmed" and
# "Confirmedish" don't collide.
#   Confirmed    -> "completed" bucket (the item passed)
#   Still broken -> stays on the active "to test" list, badged for a retest
#   Backlogged   -> "backlog" bucket (deferred; not ready to test yet)
#   Obsolete     -> "obsolete" bucket (the feature changed; the test no longer applies)
# Kept backward-compatible: files that only ever used Confirmed/Still broken parse the same.
VERDICT_LEAD_RE = re.compile(r"^(Confirmed|Still broken|Backlogged|Obsolete)\b")
ANNOTATION_KINDS = {
    "Confirmed": "confirmed",
    "Still broken": "broken",
    "Backlogged": "backlog",
    "Obsolete": "obsolete",
}
TASK_ID_SUFFIX_RE = re.compile(r"\s*\*\(([^)]+)\)\*\s*$")

# Loose on purpose: real fingerprints are 8 hex chars, but "general" notes (not tied to
# a specific item) use this literal token instead -- both are safe to embed in a
# filename.
FINGERPRINT_RE = re.compile(r"^[0-9a-f]{8}$|^general$")

MAX_SCREENSHOT_BYTES = 20 * 1024 * 1024  # generous cap; a paste is a single screen grab

# Clipboard image paste in a browser is essentially always PNG, but keep a couple of
# other sane defaults in case a browser/OS ever hands over something else.
CONTENT_TYPE_TO_EXT = {
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/gif": ".gif",
    "image/webp": ".webp",
}


def find_testing_file_upward(start_dir):
    """Searches `start_dir` and its parents for a TESTING.md, the way `git` searches
    upward for `.git`. Returns the resolved path if found, else None."""
    current = os.path.abspath(start_dir)
    while True:
        candidate = os.path.join(current, "TESTING.md")
        if os.path.isfile(candidate):
            return candidate
        parent = os.path.dirname(current)
        if parent == current:
            return None
        current = parent


def parse_testing_md(testing_file_path):
    """Parses TESTING.md's own format into a list of {name, items: [...]} groups.
    Tolerant of the file not existing -- returns an empty list rather than erroring,
    since "no checklist generated yet" is a valid, expected state, not a bug."""
    if not testing_file_path or not os.path.isfile(testing_file_path):
        return []

    with open(testing_file_path, "r", encoding="utf-8") as f:
        lines = f.read().splitlines()

    groups = []
    current_group = None
    current_item = None
    # Points at the annotation entry (a dict in current_item["annotations"]) whose body
    # we're currently appending continuation lines to. None until the first `- **...**`
    # bullet under an item is seen.
    current_entry = None

    def flush_item():
        nonlocal current_item, current_entry
        if current_item is None:
            return
        text = " ".join(current_item["text_parts"]).strip()
        m = TASK_ID_SUFFIX_RE.search(text)
        task_id = m.group(1) if m else None
        if m:
            text = text[: m.start()].strip()
        # Each annotation entry is one timeline bullet: {label, text, kind}. Finalize the
        # per-entry text_parts into a single string here.
        annotations = []
        for entry in current_item["annotations"]:
            annotations.append({
                "label": entry["label"],
                "kind": entry["kind"],
                "text": " ".join(entry["text_parts"]).strip(),
            })
        # The item's bucket is driven by its most recent KINDED entry (a recognized verdict).
        # Freeform progress notes (kind=None) don't move it between tabs. `latestKind` mirrors
        # what the old single `annotation.kind` field meant, so bucketForItem/badges are unchanged.
        latest_kind = next((e["kind"] for e in reversed(annotations) if e["kind"]), None)
        current_group["items"].append({
            "fingerprint": current_item["fingerprint"],
            "checked": current_item["checked"],
            "taskId": task_id,
            "text": text,
            "annotations": annotations,
            "latestKind": latest_kind,
        })
        current_item = None
        current_entry = None

    for line in lines:
        heading_match = HEADING_RE.match(line)
        item_match = ITEM_RE.match(line)

        if heading_match:
            flush_item()
            current_group = {"name": heading_match.group(1), "items": []}
            groups.append(current_group)
            current_entry = None
            continue

        if item_match:
            flush_item()
            if current_group is None:
                # A checklist item appeared before any "## group" heading -- tolerate
                # it under an "Ungrouped" bucket rather than dropping it silently.
                current_group = {"name": "Ungrouped", "items": []}
                groups.append(current_group)
            current_item = {
                "fingerprint": item_match.group(2),
                "checked": item_match.group(1) == "x",
                "text_parts": [item_match.group(3)],
                "annotations": [],
            }
            current_entry = None
            continue

        if current_item is None:
            continue

        entry_match = ANNOTATION_ENTRY_RE.match(line)
        if entry_match:
            # A new `- **label:** body` bullet -- start a fresh timeline entry. Its kind is
            # set only when the label leads with a recognized verdict phrase; otherwise it's
            # a freeform progress note (kind stays None).
            label = entry_match.group(1).strip()
            verdict_match = VERDICT_LEAD_RE.match(label)
            current_entry = {
                "label": label,
                "kind": ANNOTATION_KINDS[verdict_match.group(1)] if verdict_match else None,
                "text_parts": [],
            }
            body = entry_match.group(2).strip()
            if body:
                current_entry["text_parts"].append(body)
            current_item["annotations"].append(current_entry)
            continue

        stripped = line.strip()
        if not stripped:
            continue

        if current_entry is not None:
            # A continuation line of the current entry's body (wrapped prose under a bullet).
            current_entry["text_parts"].append(stripped)
        else:
            # Still in the item's own description (no annotation bullet seen yet).
            current_item["text_parts"].append(stripped)

    flush_item()
    return groups


def count_pending_submissions(submissions_dir):
    """How many submitted reports haven't been reviewed yet -- the count of loose
    `<timestamp>.json` files sitting directly in .playtest-submissions/. A reviewing
    agent moves each report into .playtest-submissions/reviewed/ once it has resolved
    every item that report touched into a terminal bucket (see REVIEW.md), so this count
    is the backstop signal the page surfaces: non-zero means work is queued for review.
    The reviewed/ subdir and the screenshots/ subdir are directories, not loose files, so
    they're naturally excluded by the isfile + .json filter."""
    if not submissions_dir or not os.path.isdir(submissions_dir):
        return 0
    return sum(
        1 for name in os.listdir(submissions_dir)
        if name.endswith(".json") and os.path.isfile(os.path.join(submissions_dir, name))
    )


def make_handler(testing_file_path, token=None):
    submissions_dir = None
    if testing_file_path:
        submissions_dir = os.path.join(os.path.dirname(testing_file_path), ".playtest-submissions")

    project_name = (
        os.path.basename(os.path.dirname(testing_file_path)) if testing_file_path else None
    )

    class Handler(http.server.SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=TOOL_DIR, **kwargs)

        def end_headers(self):
            self.send_header("Cache-Control", "no-store")
            super().end_headers()

        def _token_ok(self):
            # When no token is configured (plain localhost use), everything is allowed --
            # this is a no-op and existing local usage is unaffected. When a token IS set
            # (LAN mode), every /api/* request must present it, either as a `token` query
            # param (so a pasted URL just works on the other machine) or an
            # X-Playtest-Token header. Only the /api/* surfaces are gated; the static
            # shell (index.html/app.js) stays open since gating it buys no security --
            # the sensitive reads/writes all live under /api/.
            if not token:
                return True
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            supplied = (qs.get("token") or [None])[0] or self.headers.get("X-Playtest-Token")
            return bool(supplied) and secrets.compare_digest(supplied, token)

        def _send_json(self, status, payload):
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            # Compare against the path WITHOUT the query string -- the token travels as a
            # ?token= param, so an exact `self.path == "/api/checklist"` match would miss
            # once a token is appended. Static requests fall through to super().do_GET(),
            # which reads self.path itself.
            parsed_url = urllib.parse.urlparse(self.path)
            path = parsed_url.path
            # Gate the data endpoints (checklist contents, screenshots) but leave the
            # static app shell open -- see _token_ok.
            if path.startswith("/api/") and not self._token_ok():
                self._send_json(401, {"error": "missing or invalid token"})
                return
            if path == "/api/meta":
                self._send_json(200, {
                    "projectName": project_name,
                    "testingFilePath": testing_file_path,
                    "found": bool(testing_file_path and os.path.isfile(testing_file_path)),
                    "pendingSubmissions": count_pending_submissions(submissions_dir),
                })
                return
            if path == "/api/checklist":
                self._send_json(200, {"groups": parse_testing_md(testing_file_path)})
                return
            if path.startswith("/api/screenshots/"):
                self._serve_screenshot(parsed_url)
                return
            super().do_GET()

        def _serve_screenshot(self, parsed_url):
            # Screenshots live under the *project's* .playtest-submissions/, outside
            # this tool's own static directory (TOOL_DIR) that SimpleHTTPRequestHandler
            # otherwise serves from -- so they need their own small static handler
            # rather than falling through to super().do_GET().
            if not submissions_dir:
                self._send_json(404, {"error": "not found"})
                return
            filename = urllib.parse.unquote(parsed_url.path[len("/api/screenshots/"):])
            # Reject anything that isn't a plain filename -- no path traversal via "..",
            # no absolute paths, no nested directories.
            if not filename or "/" in filename or "\\" in filename or filename in (".", ".."):
                self._send_json(400, {"error": "invalid filename"})
                return
            screenshots_dir = os.path.join(submissions_dir, "screenshots")
            path = os.path.join(screenshots_dir, filename)
            if not os.path.isfile(path):
                self._send_json(404, {"error": "not found"})
                return
            content_type = mimetypes.guess_type(path)[0] or "application/octet-stream"
            with open(path, "rb") as f:
                data = f.read()
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_POST(self):
            parsed_url = urllib.parse.urlparse(self.path)
            if parsed_url.path.startswith("/api/") and not self._token_ok():
                self._send_json(401, {"error": "missing or invalid token"})
                return
            if parsed_url.path == "/api/screenshot":
                self._handle_screenshot(parsed_url)
                return
            if parsed_url.path != "/api/submit":
                self._send_json(404, {"error": "not found"})
                return

            if not submissions_dir:
                self._send_json(400, {"error": "no TESTING.md resolved -- nothing to submit against"})
                return

            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length)
            try:
                parsed = json.loads(raw)
            except json.JSONDecodeError as exc:
                self._send_json(400, {"error": f"invalid JSON: {exc}"})
                return

            if not isinstance(parsed, dict) or "items" not in parsed:
                self._send_json(400, {"error": "expected an object with an 'items' field"})
                return

            os.makedirs(submissions_dir, exist_ok=True)
            timestamp = time.strftime("%Y-%m-%dT%H-%M-%S")
            path = os.path.join(submissions_dir, f"{timestamp}.json")
            # Extremely unlikely (same-second double submit) but cheap to guard: don't
            # silently overwrite a prior submission if one lands in the same second.
            suffix = 2
            while os.path.exists(path):
                path = os.path.join(submissions_dir, f"{timestamp}-{suffix}.json")
                suffix += 1

            parsed["submittedAt"] = time.strftime("%Y-%m-%dT%H:%M:%S%z")
            with open(path, "w", encoding="utf-8") as f:
                json.dump(parsed, f, indent=2)

            self._send_json(200, {"ok": True, "file": os.path.basename(path)})

        def _handle_screenshot(self, parsed_url):
            if not submissions_dir:
                self._send_json(400, {
                    "error": "no TESTING.md resolved -- nothing to attach a screenshot to",
                })
                return

            qs = urllib.parse.parse_qs(parsed_url.query)
            fingerprint = (qs.get("fingerprint") or [None])[0] or "general"
            if not FINGERPRINT_RE.match(fingerprint):
                self._send_json(400, {"error": "invalid fingerprint"})
                return

            length = int(self.headers.get("Content-Length", 0))
            if length <= 0:
                self._send_json(400, {"error": "empty body"})
                return
            if length > MAX_SCREENSHOT_BYTES:
                self._send_json(413, {"error": "screenshot too large"})
                return
            raw = self.rfile.read(length)

            content_type = (self.headers.get("Content-Type") or "").split(";")[0].strip().lower()
            ext = CONTENT_TYPE_TO_EXT.get(content_type) or mimetypes.guess_extension(content_type) or ".png"

            screenshots_dir = os.path.join(submissions_dir, "screenshots")
            os.makedirs(screenshots_dir, exist_ok=True)
            timestamp = time.strftime("%Y-%m-%dT%H-%M-%S")
            base = f"{timestamp}-{fingerprint}"
            filename = f"{base}{ext}"
            path = os.path.join(screenshots_dir, filename)
            # Same same-second collision guard as /api/submit -- e.g. two quick pastes
            # onto different items within one second.
            suffix = 2
            while os.path.exists(path):
                filename = f"{base}-{suffix}{ext}"
                path = os.path.join(screenshots_dir, filename)
                suffix += 1

            with open(path, "wb") as f:
                f.write(raw)

            # "file" is a bare filename (relative to .playtest-submissions/screenshots/),
            # servable back to the page at GET /api/screenshots/<file> and, in the
            # submitted report JSON, resolvable by an agent as
            # <project>/.playtest-submissions/screenshots/<file>.
            self._send_json(200, {"ok": True, "file": filename})

    return Handler


def lan_ip():
    """Best-effort LAN IP for this machine, printed so the other computer can connect
    even when mDNS (<host>.local) doesn't resolve. Uses the standard UDP-connect trick:
    no packets are actually sent -- connect() on a datagram socket just picks the
    outbound interface, and getsockname() reads back its address. Works offline; falls
    back to loopback if there's no route at all."""
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    try:
        s.connect(("192.0.2.1", 1))  # TEST-NET-1: guaranteed-unroutable, just for interface selection
        return s.getsockname()[0]
    except OSError:
        return "127.0.0.1"
    finally:
        s.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--testing-file", help="Path to a project's TESTING.md. Defaults to searching upward from the current directory.")
    parser.add_argument("--port", type=int, default=8792)
    parser.add_argument("--lan", action="store_true", help="Bind to all interfaces so another computer on the same network can reach it. Auto-generates an access token unless --token is given. macOS shows a one-time firewall prompt -- click Allow.")
    parser.add_argument("--host", help="Explicit bind address (advanced; overrides --lan's 0.0.0.0). Default is localhost.")
    parser.add_argument("--token", help="Shared secret required on /api/* requests. Defaults to a random token when --lan is set, or none for localhost-only use.")
    args = parser.parse_args()

    testing_file_path = (
        os.path.abspath(args.testing_file) if args.testing_file else find_testing_file_upward(os.getcwd())
    )

    if not testing_file_path:
        print("No TESTING.md found (searched upward from the current directory).", file=sys.stderr)
        print("Run this from a project root that has one, or pass --testing-file.", file=sys.stderr)
    elif not os.path.isfile(testing_file_path):
        print(f"Warning: --testing-file {testing_file_path} does not exist yet.", file=sys.stderr)
    else:
        print(f"Serving checklist from: {testing_file_path}")

    # Bind address: localhost by default (safe), all-interfaces when serving to the LAN.
    bind_host = args.host if args.host else ("0.0.0.0" if args.lan else "localhost")
    # A token is auto-generated for LAN use (write endpoints are otherwise unauthenticated)
    # but never forced on plain localhost use, which stays a zero-config open tool.
    token = args.token or (secrets.token_urlsafe(16) if args.lan else None)

    handler = make_handler(testing_file_path, token=token)
    server = http.server.ThreadingHTTPServer((bind_host, args.port), handler)

    query = f"?token={token}" if token else ""
    if bind_host in ("localhost", "127.0.0.1"):
        print(f"playtest checklist running at http://localhost:{args.port}/index.html{query}")
    else:
        # Print both the mDNS name and the raw IP -- open the .local one on the other
        # machine first; fall back to the IP if Bonjour/mDNS doesn't resolve there.
        hostname = socket.gethostname()
        if not hostname.endswith(".local"):
            hostname = hostname.split(".")[0] + ".local"
        ip = lan_ip()
        print(f"playtest checklist running on the LAN (bound to {bind_host}:{args.port})")
        print("Open on the other computer (try the name first, fall back to the IP):")
        print(f"  http://{hostname}:{args.port}/index.html{query}")
        print(f"  http://{ip}:{args.port}/index.html{query}")
        if token:
            print(f"Access token: {token}")
        print("Note: macOS may show a one-time firewall prompt for Python -- click Allow.")

    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
