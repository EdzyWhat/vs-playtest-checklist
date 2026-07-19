# vs-playtest-checklist

A tiny local web app for turning a project's `TESTING.md` checklist into something
clickable: pass/fail/unsure per item, a notes field, and a Submit button that queues a
JSON report for an AI agent (or a teammate) to review later.

Originally built for a [Vintage Story](https://www.vintagestory.at/) mod project, but
it's project-agnostic — point it at any repo with a `TESTING.md`.

## Why

Scrolling back through a long chat session to find "what was I supposed to test again?"
doesn't scale. `TESTING.md` (see format below) is a small, git-tracked checklist that
survives across sessions. This app makes checking items off during a test pass fast —
tap a verdict, jot a note, submit — instead of hand-editing markdown mid-playtest.

**Checking a box in this app is a claim, not a confirmation.** Submitting queues your
report; it does not edit `TESTING.md` itself. The idea is a second pass (an agent, or a
teammate) reviews the claim against real evidence before it becomes an authoritative
checkmark. This mirrors how most bug trackers and QA sign-off processes work: the
reporter/tester claims a result, someone else verifies before closing it out.

## `TESTING.md` format

```markdown
# Testing checklist

## some-feature-area

- [ ] `7d808ca9` Do the thing and confirm X happens. *(3.5)*
- [x] `805e78a7` Do the other thing and confirm Y. *(6.6)*
      - **Confirmed 2026-07-19** via screenshot: caret held after hover.
```

- Group items under `## heading`s.
- Each item: `` - [ ] `<8-char fingerprint>` <description text> *(<source id>)` ``
- The fingerprint is opaque (a short hash) — it exists so tooling can detect whether an
  item's underlying text changed since a previous confirmation.
- A checked box only "counts" if there's a `**Confirmed ...**` (or `**Still broken
  ...**`) annotation underneath it. A bare `[x]` with no annotation is not treated as
  confirmed by design.

## Running it

```bash
# From within a project root that has a TESTING.md (searches upward, like git does for .git):
python3 /path/to/vs-playtest-checklist/server.py

# Or point it explicitly at another project:
python3 server.py --testing-file /path/to/project/TESTING.md
```

Then open http://localhost:8792/index.html (or whatever `--port` you passed).

### Double-click launcher

`start.command` mirrors the server's own defaults — double-click it (or edit the
`TESTING_FILE` variable near the top to pin it to one project) to start the server if
needed and open the page automatically. Make a Finder alias to it if you want one-click
access from the Dock/Launcher folder.

## Where submissions go

Submitting a report writes a JSON file to `.playtest-submissions/` **inside the
project being tested** (next to its `TESTING.md`), not inside this tool's own
directory — so an agent working in that project finds its own submissions locally.
Consider adding `.playtest-submissions/` to that project's `.gitignore`; these are
ephemeral working files, not something you'd normally want to commit.

## Attaching screenshots

Every item's note field (and the general-notes field) accepts a pasted clipboard
image — take a screenshot with `Cmd+Shift+Ctrl+4` (hold `Ctrl` on the usual
`Cmd+Shift+4`; grabs a selection straight to the clipboard, no file written to disk),
then click into the field and paste (`Cmd+V`).

Pasting uploads the image immediately (not held until Submit) to
`.playtest-submissions/screenshots/` in the project being tested, and shows a small
thumbnail under the field — click it to open full-size, or the "×" to detach it from
this report (the file itself is left on disk either way). The final submitted report
JSON references screenshots by filename, so a reviewing agent can open them directly
rather than unpacking base64 blobs.

## Promoting a screenshot to the project's playtest history

`.playtest-submissions/` is ephemeral and gitignored — it's a review queue, not a
record. `playtest-history/` (committed, alongside `TESTING.md`) is the opposite: a
curated, permanent visual changelog of the app's progression.

When a reviewing agent processes a submission and finds an item verdicted "pass"
("Looks good") with a screenshot attached, it's a judgment call whether that screenshot
is worth keeping — a first correct render of a feature, a regression now visibly fixed,
a notable UI milestone — versus routine day-to-day confirmation that isn't. Most
"pass" screenshots should **not** be promoted; only genuinely milestone-worthy ones. When
one is, run:

```bash
python3 promote_screenshot.py --testing-file /path/to/project/TESTING.md \
    --screenshot 2026-07-19T15-33-52-7d808ca9.png \
    --caption "Caret held steady while hovering a different row's icons (task 6.6)"
```

This copies the file into `<project>/playtest-history/screenshots/` and appends a dated
entry (image + caption) to `<project>/playtest-history/HISTORY.md`. The original in
`.playtest-submissions/` is left untouched.

## Stack

Deliberately stdlib-only Python (`http.server`) plus a static HTML/JS page — no build
step, no dependencies, no framework. This is a small personal tool, not a shipped
product.
