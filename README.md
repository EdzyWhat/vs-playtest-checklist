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

- [ ] `7d808ca9` **Scroll the lectern.** Do the thing and confirm X happens. *(3.5)*
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
- **Optional:** an item's description may lead with a `**Up to four words.**` summary —
  a quick "what to actually do" flag before the fuller description (see
  `7d808ca9` above). The checklist page renders that fragment bolded and strips the
  `**` markers; items without it render exactly as plain text. This is purely a
  rendering convention this app understands — nothing upstream (parsing,
  fingerprinting, confirmation) treats it specially. Whatever agent/skill authors a
  project's `TESTING.md` decides whether to write these lead-ins; keep them imperative
  and concrete (`Scroll the lectern`, not `Verify that scrolling works correctly`).

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

## Running it on another computer (same network)

Playtesting on a second machine (say, a Windows box next to your Mac) while an agent on
the first machine does the bug-fixing: run the server on the machine that has the project
(and the agent), and open the checklist in a browser on the *other* machine. Reports
submit straight back into the project's `.playtest-submissions/` on the host machine — no
sync, no second copy of the repo. The agent reads them the moment you hit Submit.

```bash
# On the machine that has the project + the agent:
python3 server.py --testing-file /path/to/project/TESTING.md --lan
```

`--lan` binds all network interfaces (instead of localhost-only) and prints a URL and an
access token to open on the other machine, e.g.:

```
Open on the other computer (try the name first, fall back to the IP):
  http://my-mac.local:8792/index.html?token=jr8_63vDyOF7qratklGIZw
  http://192.168.1.42:8792/index.html?token=jr8_63vDyOF7qratklGIZw
```

- **Token:** because `--lan` opens the report-writing endpoints to the network, every
  `/api/*` request must carry a shared token. It's auto-generated and baked into the URL
  above (so you just open the link), or set your own with `--token`. Plain localhost use
  needs no token and is unchanged.
- **Which URL:** try the `.local` name first (works via Bonjour/mDNS, which Windows 10+
  resolves); fall back to the raw IP if it doesn't. The printed IP is a best guess — if
  the host has a VPN/Tailscale interface it may print that address instead of your Wi-Fi
  `192.168.x.x`; use the `.local` name or your real LAN IP (`ipconfig getifaddr en0` on
  macOS) in that case.
- **macOS firewall:** the first `--lan` launch triggers a one-time "allow incoming
  connections" prompt for Python — click **Allow**, or the other machine can't connect.
- **If the network blocks peer-to-peer traffic** (some corporate/guest Wi-Fi has "client
  isolation"), install [Tailscale](https://tailscale.com/) on both machines and use the
  Mac's Tailscale IP + `--lan` instead — same result over a private mesh.

Security note: the token guards against other devices on the network, but it does travel
in the URL (so it can land in the Windows browser's history). This is a home-LAN dev
tool, not an internet-facing service — don't expose it to the public internet.

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
