#!/usr/bin/env python3
"""Local dev server for the playtest checklist app: serves its own static files, parses
a project's TESTING.md into structured JSON for the page to render, and accepts
submitted test reports as a queue file for later review by an AI agent (or a human).

This tool is project-agnostic -- it doesn't live inside the project it tests. Point it
at any project's TESTING.md via --testing-file, or run it with your shell's cwd set to
a project root that has one (it searches upward from cwd, the way `git` finds `.git`).

Usage:
    python3 server.py [--testing-file PATH] [--port PORT]

    # From within a project root that has TESTING.md:
    python3 /path/to/vs-playtest-checklist/server.py

    # Or point it explicitly at another project:
    python3 server.py --testing-file ~/some-other-project/TESTING.md

Endpoints:
    GET  /api/meta       -> {"projectName": ..., "testingFilePath": ..., "found": bool}
    GET  /api/checklist  -> parsed TESTING.md as JSON (groups of items, each with its
                             fingerprint, task id, description text, current checked
                             state, and any existing agent-written annotation).
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

Deliberately stdlib-only, no build tooling -- this is a tiny local tool, not a shipped
app.
"""
import argparse
import http.server
import json
import os
import re
import sys
import time

TOOL_DIR = os.path.dirname(os.path.abspath(__file__))

ITEM_RE = re.compile(r"^- \[( |x)\] `([0-9a-f]{8})` (.*)$")
HEADING_RE = re.compile(r"^## (.+)$")
ANNOTATION_START_RE = re.compile(r"^\s+- \*\*(Confirmed|Still broken)([^*]*)\*\*:?\s*(.*)$")
TASK_ID_SUFFIX_RE = re.compile(r"\s*\*\(([^)]+)\)\*\s*$")


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
    collecting_annotation = False

    def flush_item():
        nonlocal current_item
        if current_item is None:
            return
        text = " ".join(current_item["text_parts"]).strip()
        m = TASK_ID_SUFFIX_RE.search(text)
        task_id = m.group(1) if m else None
        if m:
            text = text[: m.start()].strip()
        annotation = None
        if current_item["annotation_parts"]:
            annotation = {
                "kind": current_item["annotation_kind"],
                "text": " ".join(current_item["annotation_parts"]).strip(),
            }
        current_group["items"].append({
            "fingerprint": current_item["fingerprint"],
            "checked": current_item["checked"],
            "taskId": task_id,
            "text": text,
            "annotation": annotation,
        })
        current_item = None

    for line in lines:
        heading_match = HEADING_RE.match(line)
        item_match = ITEM_RE.match(line)

        if heading_match:
            flush_item()
            current_group = {"name": heading_match.group(1), "items": []}
            groups.append(current_group)
            collecting_annotation = False
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
                "annotation_parts": [],
                "annotation_kind": None,
            }
            collecting_annotation = False
            continue

        if current_item is None:
            continue

        annotation_match = ANNOTATION_START_RE.match(line)
        if annotation_match:
            collecting_annotation = True
            current_item["annotation_kind"] = (
                "confirmed" if annotation_match.group(1) == "Confirmed" else "broken"
            )
            rest = (annotation_match.group(2) + " " + annotation_match.group(3)).strip()
            if rest:
                current_item["annotation_parts"].append(rest)
            continue

        stripped = line.strip()
        if not stripped:
            continue

        if collecting_annotation:
            current_item["annotation_parts"].append(stripped)
        else:
            current_item["text_parts"].append(stripped)

    flush_item()
    return groups


def make_handler(testing_file_path):
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

        def _send_json(self, status, payload):
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            if self.path == "/api/meta":
                self._send_json(200, {
                    "projectName": project_name,
                    "testingFilePath": testing_file_path,
                    "found": bool(testing_file_path and os.path.isfile(testing_file_path)),
                })
                return
            if self.path == "/api/checklist":
                self._send_json(200, {"groups": parse_testing_md(testing_file_path)})
                return
            super().do_GET()

        def do_POST(self):
            if self.path != "/api/submit":
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

    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--testing-file", help="Path to a project's TESTING.md. Defaults to searching upward from the current directory.")
    parser.add_argument("--port", type=int, default=8792)
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

    handler = make_handler(testing_file_path)
    server = http.server.ThreadingHTTPServer(("localhost", args.port), handler)
    print(f"playtest checklist running at http://localhost:{args.port}/index.html")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
