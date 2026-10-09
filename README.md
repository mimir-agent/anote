# anote

Linked, provenance-stamped markdown notes for an agent, run from a single CLI.

Most note tools assume a person who remembers the context around a note. An agent
that persists across sessions does not. A stale note it trusts turns into a
confident wrong answer. anote is built around that problem: every note records
who said it, what it was true for, and when to look at it again, and notes
connect to each other with typed links.

- One Python file, standard library only, Python 3.9 or newer.
- Notes are plain markdown files. There is no database, so the files are the
  source of truth and anything else can be rebuilt from them.
- Output is short and has a `--json` mode, so an agent can read it cheaply.

## Install

```sh
git clone https://github.com/mimir-agent/anote.git
ln -s "$PWD/anote/anote" ~/.local/bin/anote   # or any directory on your PATH
anote init
```

The graph lives in `~/.hermes/graph` by default. Set `ANOTE_GRAPH` or pass
`--graph DIR` to put it somewhere else.

## Quick start

```sh
anote add "Cron jobs fall back to email" \
  --source observed --version "hermes 0.19.0" --tag cron \
  --body "deliver=origin with no origin sends to the email home channel."

anote add "Always set deliver explicitly" --source inferred \
  --link explains:cron-jobs-fall-back-to-email

anote show cron-jobs-fall-back
anote search email --budget 200
anote neighbors cron-jobs-fall-back-to-email --depth 2
anote stale --within 14d
```

## Provenance

`add` refuses to run without `--source`:

| source | meaning | default review |
|---|---|---|
| told | a person said it | 180 days |
| observed | you saw it happen | 60 days |
| inferred | you concluded it | 30 days |

`--version` records what the note was true for, such as a software version.
`anote stale` lists notes whose review date has arrived. `anote confirm` marks a
note re-checked and pushes the date out. When a claim is wrong, `anote supersede
OLD NEW` retires the old note instead of overwriting it. Superseded notes drop
out of search and lists, and stay on disk with a pointer to their replacement.

## Links

A link has a type that says how one note relates to another:

| type | meaning |
|---|---|
| expands-on | adds detail to, or builds out, the target |
| explains | makes the target understandable |
| supports | is evidence or argument for the target |
| opposes | is evidence or argument against the target |
| relates | is connected in a way no other type names |
| addresses | responds to a question, problem or request in the target |
| helpful-background | context worth reading before the target |
| leads-to | the target follows from this |
| supplemental | optional extra material for the target |
| duplicates | says the same thing as the target |
| references | cites or points at the target |

The set is fixed on purpose. An unknown type is rejected. Short forms such as
`background`, `leads` and `refs` are accepted. `anote show` prints a note with
its links out and in, and `anote neighbors` walks the web to a chosen depth,
optionally following one type.

## Commands

| command | what it does |
|---|---|
| `init` | create the graph directories |
| `types` | list link types |
| `add TITLE` | create a note (`--source` required) |
| `log TEXT` | append a line to today's daily log |
| `link SRC TYPE DST` | add a typed link, with optional `--note` |
| `unlink SRC DST` | remove links between two notes |
| `show NOTE` | print a note with links in and out, or a daily note by date |
| `search WORDS` | ranked keyword search, with `--limit` and `--budget` |
| `list` | list notes, newest first |
| `neighbors NOTE` | walk the link web |
| `stale` | notes whose review date has arrived |
| `confirm NOTE` | mark a note re-checked |
| `set NOTE KEY VALUE` | change title, source, version, review or tags |
| `append NOTE TEXT` | add text to the end of a note |
| `supersede OLD NEW` | retire a note in favor of a newer one |
| `check` | lint the graph |

A note can be named by slug, by exact title, or by a unique slug prefix.
Dates accept `YYYY-MM-DD`, `+30d`, `+6w` or `+3m`.

Exit codes: 0 ok, 1 runtime error or failed check, 2 usage error, 3 note not
found or ambiguous. Data goes to stdout and errors go to stderr.

## File format

```
---
title: Cron jobs fall back to email
created: 2026-10-09
updated: 2026-10-09
source: observed
version: hermes 0.19.0
review: 2026-12-08
status: active
tags: cron
links:
  - explains [[always-set-deliver-explicitly]] | why this matters
---

deliver=origin with no origin sends to the email home channel.
```

Daily logs live in `daily/YYYY-MM-DD.md`, one line per entry, each tagged with a
time and a source.

## Limits

- Search is keyword scoring, not semantic search. It finds the words you used.
- There is no sync, locking or history. Put the graph in git if you want those.
- Concurrent writers are not coordinated. Writes are atomic per file, but two
  processes editing the same note can still overwrite each other.

## Tests

```sh
python3 -I -m unittest discover -s tests
```

## License

MIT. See `LICENSE`.
