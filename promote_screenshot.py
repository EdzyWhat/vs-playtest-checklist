#!/usr/bin/env python3
"""Promotes a playtest screenshot from a project's ephemeral .playtest-submissions/
queue into that project's committed, permanent playtest-history/ folder -- a lightweight
visual changelog of the app's progression over time.

This is a reviewing agent's tool, not something the checklist page itself calls. While
reviewing a submitted report (the JSON files server.py's POST /api/submit writes), if an
item's verdict is "pass" ("Looks good") and has a screenshot attached that's judged a
meaningful visual milestone -- first correct render of a feature, a regression visibly
fixed, a notable UI state -- rather than routine day-to-day confirmation, run this to
promote it. Most "pass" screenshots should NOT be promoted; this is a curated record, not
an automatic archive of every attachment.

Usage:
    python3 promote_screenshot.py --testing-file /path/to/project/TESTING.md \
        --screenshot 2026-07-19T15-33-52-7d808ca9.png \
        --caption "Caret held steady while hovering a different row's icons (task 6.6)"

    # Or search upward from cwd for TESTING.md, like server.py does:
    python3 promote_screenshot.py --screenshot <file> --caption "..."

Writes:
    <project-root>/playtest-history/screenshots/<file>  (copy of the source -- the
        ephemeral original in .playtest-submissions/ is left alone)
    <project-root>/playtest-history/HISTORY.md           (one entry appended per
        promotion: date, embedded image, caption)
"""
import argparse
import os
import shutil
import sys
import time


def find_testing_file_upward(start_dir):
    """Same upward search server.py uses to locate TESTING.md from cwd."""
    current = os.path.abspath(start_dir)
    while True:
        candidate = os.path.join(current, "TESTING.md")
        if os.path.isfile(candidate):
            return candidate
        parent = os.path.dirname(current)
        if parent == current:
            return None
        current = parent


def main():
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument(
        "--testing-file",
        help="Path to the project's TESTING.md. Defaults to searching upward from the current directory.",
    )
    parser.add_argument(
        "--screenshot",
        required=True,
        help="Bare filename as referenced in a submitted report's screenshots[] (e.g. from .playtest-submissions/screenshots/).",
    )
    parser.add_argument(
        "--caption",
        required=True,
        help="One-line description of what this screenshot shows and why it's a meaningful milestone.",
    )
    args = parser.parse_args()

    testing_file_path = (
        os.path.abspath(args.testing_file)
        if args.testing_file
        else find_testing_file_upward(os.getcwd())
    )
    if not testing_file_path or not os.path.isfile(testing_file_path):
        print(
            "No TESTING.md found -- pass --testing-file or run from within the project.",
            file=sys.stderr,
        )
        sys.exit(1)

    project_root = os.path.dirname(testing_file_path)
    source = os.path.join(
        project_root, ".playtest-submissions", "screenshots", args.screenshot
    )
    if not os.path.isfile(source):
        print(f"Screenshot not found: {source}", file=sys.stderr)
        sys.exit(1)

    history_dir = os.path.join(project_root, "playtest-history")
    screenshots_dir = os.path.join(history_dir, "screenshots")
    os.makedirs(screenshots_dir, exist_ok=True)
    dest = os.path.join(screenshots_dir, args.screenshot)

    if os.path.exists(dest):
        print(f"Already promoted: {dest}", file=sys.stderr)
        sys.exit(1)

    shutil.copyfile(source, dest)

    history_md = os.path.join(history_dir, "HISTORY.md")
    if not os.path.isfile(history_md):
        with open(history_md, "w", encoding="utf-8") as f:
            f.write(
                "# Playtest history\n\n"
                "A visual record of this app's progression over time, curated from "
                "playtest screenshots judged worth keeping -- see vs-playtest-checklist's "
                "README for the promotion criteria.\n"
            )

    date = time.strftime("%Y-%m-%d")
    with open(history_md, "a", encoding="utf-8") as f:
        f.write(f"\n## {date}\n\n![](screenshots/{args.screenshot})\n\n{args.caption}\n")

    print(f"Promoted to {dest}")
    print(f"Logged in {history_md}")


if __name__ == "__main__":
    main()
