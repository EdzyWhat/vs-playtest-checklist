# Reviewing a playtest submission (agent contract)

This is the contract for the agent (or teammate) that **reviews** submitted playtest
reports. It's the other half of the app: the tester marks claims in the browser and hits
Submit; you turn those claims into recorded verdicts. The app never edits `TESTING.md` —
you do.

> **Where you run:** you run inside the *project being tested* (the one with `TESTING.md`
> and `.playtest-submissions/`), not inside this tool's directory. For the scribe project
> the mechanics below are implemented by the `what-to-test` skill — invoke it rather than
> re-deriving the file format. This doc is the project-agnostic statement of *what* has to
> happen; a project's own skill is *how*.

## The lifecycle: every item lives in exactly one bucket

An item's bucket is derived from the verdict annotation beneath it in `TESTING.md` (the
bold lead word). The page shows one tab per bucket:

| Verdict annotation under the item | Tab shown under | Box |
|---|---|---|
| `- **Confirmed <date>** …`   | **Completed** | `[x]` |
| `- **Still broken <date>:** …` | **To Test** (badged "broken · retest") | `[ ]` |
| `- **Backlogged <date>** …`  | **Backlog**   | `[ ]` |
| `- **Obsolete <date>** …`    | **Obsolete**  | `[ ]` |
| *(no annotation)*            | **To Test**   | `[ ]` |

Only `Confirmed` checks the box. The glyph is never the source of truth — the annotation
is (a bare `[x]` with no annotation is treated as unconfirmed and reset on regeneration).

### Multiple annotations per item (the timeline)

An item under active iteration accumulates *several* annotation bullets over successive
passes — you **append** a new bullet each turn rather than overwriting the last. Each
`- **<bold lead>:** <body>` bullet beneath an item is one timeline entry; the page renders
them stacked, newest last, with the latest expanded and focused. Two kinds of bullet:

- **Verdict bullets** lead with one of the four recognized words (`Confirmed`, `Still
  broken`, `Backlogged`, `Obsolete`) and set the item's lifecycle.
- **Progress notes** lead with anything else (`Deferred`, `Target defined`, `Debug aids
  staged`, …). They record what happened this pass but do *not* move the item between
  tabs.

The item's bucket is driven by its **most recent verdict bullet**, ignoring any progress
notes written after it. So an item can read `Still broken` → `Deferred` → `Debug aids
staged` and still sit on **To Test** (badged), because `Still broken` is the latest
*verdict*. When you reach a real outcome, append a fresh verdict bullet — that's what
moves the item to its new bucket.

Pick the bucket from evidence and judgment, not from what the tester clicked:

- **Confirmed** — you have first-hand evidence it works (a read screenshot, a described
  live result you watched). "Looks good" in a submission is a *claim*; confirm only when
  the evidence backs it.
- **Still broken** — evidence shows it's wrong. Say what's wrong and where. Stays on the
  working list because it needs a retest after the fix.
- **Backlogged** — can't be tested yet (blocked on a feature landing, a dependency, an
  environment you don't have). Say what it's waiting on.
- **Obsolete** — the thing it tested changed or was removed, so the test no longer
  applies. Say what changed. (Use this, not deletion — the record is kept, just off the
  working list.)
- **Leave untested** — a claim you can't yet verify either way. No annotation; it stays
  in To Test. Say what additional angle/state would resolve it.

Write every annotation in your own words from evidence in the current turn. Never write
one because the tester "said so," and never copy an annotation forward from a *different*
fingerprint (that confirms stale text, not the current item).

## Close the loop — the non-negotiable part

**A submission is not "reviewed" until every item it touched has been resolved.** For each
item in the report, you must end in one of:

1. A terminal bucket — **Confirmed / Backlogged / Obsolete** — with an annotation, or
2. **Still broken** (stays on To Test, badged), or
3. Explicitly left untested, having stated what would resolve it.

There is no "I'll get to it later" state for a touched item. If you can't resolve one,
that's a **Still broken** or an explicit untested-with-reason, not silence.

Then, and only then, **move the processed report file out of the review queue:**

```bash
mkdir -p .playtest-submissions/reviewed
mv .playtest-submissions/<timestamp>.json .playtest-submissions/reviewed/
```

Moving it to `reviewed/` is what clears the app's **"N submissions awaiting review"**
banner. That banner is the human's backstop: if you forget to resolve items or forget to
move the file, the count stays up and the human sees it. Don't move a report to
`reviewed/` while any item it touched is still unresolved — that defeats the signal.

## Screenshots

Reports reference screenshots by filename under
`.playtest-submissions/screenshots/`. Open them directly as evidence for the verdict —
they're the first-hand basis a `Confirmed`/`Still broken` annotation is meant to rest on.
(A milestone-worthy "pass" screenshot may be worth promoting to the project's permanent
`playtest-history/` — see this tool's README, "Promoting a screenshot".)
