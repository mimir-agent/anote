---
name: anote
description: Use when keeping linked, dated, sourced notes with anote.
---

# anote

anote keeps notes for an agent that persists across sessions. Notes are
markdown files. Each one records its type, who said it, what it was true for,
and when to check it again, and notes connect through typed links.

Install anote (see the README; the npm release may be older than this skill),
then copy this file into your agent with `anote skill install --agent hermes`,
`--agent claude`, or `--dir DIR`. It never touches the graph, and replaces a
different copy only with `--force`.

New to the tool? Run `anote --help` and `anote types`. The graph lives in
`$ANOTE_GRAPH`, or `~/.hermes/graph` if that is unset.

At the start of a session, run `anote brief --budget N` (N in characters,
roughly 4 per token) to see the notes due for review and the newest log lines.
If a brief was already printed at session start, read it before running brief again.
If brief says `no graph at PATH`, the graph is missing or the path is wrong; do
not read that as an empty graph.

In Claude Code, `anote hook claude` prints a SessionStart hook that runs brief
by anote's absolute path with the graph path fixed. `--write` adds it to
`~/.claude/settings.json` (or `--settings FILE`) after copying the file to
`FILE.anote-backup`. Only add it when the person you work for asks; to remove
it, delete that hook entry or restore the backup.

## The rule that matters most: log first

Anything new goes in the daily log:

    anote log "what happened or what you learned" --source observed

Make a typed note only when the content meets a type's definition below. Do
not force something into the closest type. If nothing fits, leave it in the
log and ask the person you work for. Later, `anote show DATE` numbers the log
lines, and `anote promote DATE N "Title" --type TYPE` turns one into a note.

## Choosing a type

One type per note. These are the only types. Do not invent new ones.

| type | use it for |
|---|---|
| reference | a record of material read, watched or heard, but only if other notes will likely mention it |
| fragment | a piece of a reference worth its own note; must link back to that reference |
| assertion | one claim that can be challenged; it may come from a reference |
| question | something still unanswered; assertions answer it |
| concept | an abstraction other notes refer to by name, with no claim attached |
| artifact | writing you composed; add a form (`--form post`) only once the form is clear |
| hub | a hand-kept list of links between notes that share no other connection |
| protocol | instructions written in advance for a scenario |
| project | tasks directed at a goal with a defined output |
| cycle | one work cycle; what goes in it is defined by the person you work for |
| person | someone likely to be referenced more than a few times (see Privacy) |

A reference carries up to three tags in this order: `reference`, a media tag
(`--media audio|text|video`), then a form (`--form article|book` for text,
`film` for video). Stop at the media tag when no form fits.

An assertion is not anyone's position unless it says so. Set `--stance held`
when you stand behind it and `--stance unheld` when you are only recording it.
Competing assertions answer one question and link to each other with `opposes`.

## Provenance is required

- `--source told` a person said it, `observed` you saw it happen, `inferred` you concluded it.
- `--version` what it was true for, such as a software version.
- `--review` when to check it again. The default is 180 days for told, 60 for observed, 30 for inferred.

## Links

Link notes with `anote link FROM TYPE TO --note "why"`. The types are fixed:
expands-on, explains, supports, opposes, relates, addresses,
helpful-background, leads-to, supplemental, duplicates, references.
Use `relates` only when no other type fits.

## Using notes you find

Before relying on a note, read its source, version and review date. If the
review date has passed or the version has changed, check the claim against
reality. Then run `anote confirm NOTE`, or write the corrected note and run
`anote supersede OLD NEW`. Do not rewrite a wrong note into a different
claim, because the old one is the record.

When a new log line corrects an older one (Alex moved from Berlin to Lisbon),
anote will not notice; you must. Promote both lines and run
`anote supersede OLD NEW`, so search and `anote show DATE` mark the old log
line as superseded and name the note that replaced it. If the fact is not
worth a note, log the correction and name the old date: "Alex moved to
Lisbon; corrects the 2026-10-01 log".

Read cheaply: `anote search WORDS --budget 300`, `anote show NOTE`, and
`anote neighbors NOTE --depth 2`. A daily log hit shows its best line as
`line N: ...`, the N that `anote promote DATE N` takes. A search hit marked
`(due)` is past its review date: re-check it before relying on it, then
`anote confirm NOTE` (or supersede it). Run `anote stale --within 14d` to see what
needs checking, and `anote check` after a batch of edits.

## Privacy

Notes are plain files that may end up in a repository. Never record secrets,
tokens or passwords. Do not write person notes about anyone except the people
you work for unless they will be referenced often and the facts are ones they
would be fine with recorded. Person notes need `--person-ok`. Otherwise write
the name as plain text in the log.

## Publishing

A note may carry the page it is about: `--url URL` on add, or
`anote set NOTE url URL`. Nothing is published by default. Only the person you
work for decides what becomes public: do not run `anote publish mark` or
`anote publish send --write` unless they asked for that note. Person notes and
daily logs can never be marked, and links to unmarked notes are never exported.
`anote publish preview` and `anote publish send` (without `--write`) only show
what would be sent; show that output to the person before anything is written.
Records written by `send --write` are public and anote cannot take them back.
