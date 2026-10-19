# anote

Linked, provenance-stamped markdown notes for an agent, run from a single CLI.

Most note tools assume a person who remembers the context around a note. An agent
that persists across sessions does not. A stale note it trusts turns into a
confident wrong answer. anote is built around that problem: every note records
what kind of note it is, who said it, what it was true for, and when to look at it
again, and notes connect to each other with typed links.

- TypeScript on Node 24 or newer, run directly with Node's built-in type
  stripping. No runtime dependencies and no build step.
- Notes are plain markdown files. There is no database, so the files are the
  source of truth and anything else can be rebuilt from them.
- Output is short and has a `--json` mode, so an agent can read it cheaply.
- A ready-made skill for agents ships in the package as `skills/anote/SKILL.md` ([on GitHub](https://github.com/mimir-agent/anote/blob/main/skills/anote/SKILL.md)).

## Install

From npm (Node 24 or newer):

```sh
npm i -g @mimir-agent/anote
anote init
```

From source, which runs the TypeScript directly:

```sh
git clone https://github.com/mimir-agent/anote.git
cd anote && npm install      # only needed for the tests and typechecking
ln -s "$PWD/anote" ~/.local/bin/anote   # or any directory on your PATH
anote init
```

npm has the latest published release; `main` may be ahead of it.

Publishing needs `npm ci` first, because `prepack` builds `dist/` with the dev dependencies.

The graph lives in `~/.hermes/graph` by default. Set `ANOTE_GRAPH` or pass
`--graph DIR` to put it somewhere else. Commands that write take a lock
(the directory `<graph>/.lock`); if a crashed anote leaves it behind, remove it.

## Quick start

```sh
# New things go in the daily log first.
anote log "a job with deliver=origin and no origin went to email" --source observed
anote show "$(date +%F)"            # log lines are numbered

# Promote a line once it meets a type's definition.
anote promote "$(date +%F)" 1 "Cron jobs fall back to email" \
  --type assertion --stance held --version "hermes 0.19.0"

# Or write a typed note directly, and link it.
anote add "Always set deliver explicitly" --source inferred --type assertion \
  --link explains:cron-jobs-fall-back-to-email

anote search email --budget 200
anote neighbors cron-jobs-fall-back-to-email --depth 2
anote stale --within 14d
```

## Log first

New content goes in the daily log. A typed note is made only when the content
meets one of the type definitions below. If nothing fits, the content stays in
the log and the agent asks the person it works for, instead of forcing it into
the closest type. `anote promote` turns a numbered log line into a note later
and leaves a trail in the log.

## Session start: anote brief

`anote brief` prints what an agent should read when a session starts: notes
whose review date has passed, most overdue first, then the newest log lines.
It fills in that order and stops at the first line that does not fit, so it
prints whole lines only.

`--budget` is the size of the printed output in characters, newlines included
(roughly 4 characters per token). The default is 2000. A budget under 200 is an
error and exits non-zero. When anything was dropped, the last line says how many
lines were left out, and that line counts inside the budget too. If every due
note was dropped, the `due notes:` header is left out as well, and the same goes
for the `log lines:` header when every log line was dropped.

A small graph with two overdue notes, one note not yet due, and five log lines
over two days, on 2026-10-13:

```sh
$ anote brief --budget 400
due notes:
  deploy-runbook  "Deploy runbook"  review 2026-10-01
  cron-jobs-fall-back-to-email  "Cron jobs fall back to email"  review 2026-10-09
log lines:
  2026-10-13 10:15 [observed] token for the deploy account expires 2026-11-02
  2026-10-13 09:32 [inferred] the email fallback fires when deliver has no origin
(3 more left out)
```

## Note types

A note has exactly one type. The set is fixed, and `anote types` prints it.

| type | what it is |
|---|---|
| reference | a record of material read, watched or heard; only worth a note if other notes will mention it |
| fragment | a piece of a reference that is worth its own note; links back to that reference |
| assertion | one claim that can be challenged; it may come from a reference |
| question | something still unanswered; assertions answer it |
| concept | an abstraction other notes refer to by name, with no claim attached |
| artifact | writing you composed; a form such as `post` or `message` is added only once it is clear |
| hub | a hand-kept list of links between notes that share no other connection |
| protocol | instructions written in advance for a scenario |
| project | tasks directed at a goal with a defined output |
| cycle | one work cycle |
| person | someone likely to be referenced more than a few times |

A reference carries up to three tags, general to specific: `reference`, a media
tag (`audio`, `text`, `video`), then a form (`article` or `book` for text, `film`
for video). Pass them as `--type reference --media text --form article`. A form
only goes with its own media tag.

`check` enforces the structural rules: a fragment must link back to a
reference, reference tags must be in order, and stance belongs only on
assertions.

### Stance

An assertion is not anyone's position unless it says so. `--stance held` means
the writer stands behind it, and `--stance unheld` means it is recorded and not
endorsed. An assertion with no stance shows as "not anyone's position".

### People

Person notes need `--person-ok`, and are meant for someone likely to be
referenced often. Anyone else is written as plain text in the log.

## Provenance

`add` and `promote` refuse to run without a source:

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
optionally following one type. Assertions link to the question they answer with
`addresses`, and competing assertions link to each other with `opposes`.

## Commands

| command | what it does |
|---|---|
| `init` | create the graph directories |
| `types` | list note types and link types |
| `log TEXT` | append a line to today's daily log |
| `promote DATE N TITLE` | turn a numbered log line into a typed note |
| `add TITLE` | create a typed note (`--type` and `--source` required) |
| `link SRC TYPE DST` | add a typed link, with optional `--note` |
| `unlink SRC DST` | remove links between two notes |
| `show NOTE` | print a note with links in and out, or a daily log by date |
| `search WORDS` | ranked keyword search, with `--limit`, `--budget` and `--type` |
| `list` | list notes, newest first, with `--type` and `--tag` filters |
| `neighbors NOTE` | walk the link web |
| `stale` | notes whose review date has arrived |
| `confirm NOTE` | mark a note re-checked |
| `set NOTE KEY VALUE` | change title, type, source, stance, version, review or tags |
| `append NOTE TEXT` | add text to the end of a note |
| `supersede OLD NEW` | retire a note in favor of a newer one |
| `check` | lint the graph |
| `brief` | due notes, then recent log lines, cut to `--budget` characters (default 2000) |
| `skill install` | copy the bundled skill into `--agent hermes`, `--agent claude` or `--dir DIR` |
| `skill path` | print where the bundled skill file is |

A note can be named by slug, by exact title, or by a unique slug prefix.
Dates accept `YYYY-MM-DD`, `+30d`, `+6w` or `+3m`.

Exit codes: 0 ok, 1 runtime error or failed check, 2 usage error, 3 note not
found or ambiguous. Data goes to stdout and errors go to stderr.

## File format

```
---
title: Cron jobs fall back to email
type: assertion
created: 2026-10-09
updated: 2026-10-09
source: observed
stance: held
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

## For agents

`skills/anote/SKILL.md` is a plain skill file an agent can load: when to log,
how to pick a type, how to record provenance, and what to do with a note whose
review date has passed. `anote skill install` copies it into an agent's skills
directory, so the skill matches the installed CLI:

```sh
anote skill install --agent hermes   # $HERMES_HOME/skills, else ~/.hermes/skills
anote skill install --agent claude   # ~/.claude/skills
anote skill install --dir DIR        # any other agent: writes DIR/anote/SKILL.md
```

An identical file is left alone, a different one is only replaced with `--force`,
and if the agent already has another skill named anote, nothing is written.
`anote skill path` prints where the bundled file is. The same file is on GitHub:
[skills/anote/SKILL.md](https://github.com/mimir-agent/anote/blob/main/skills/anote/SKILL.md).

The `skill` command is on `main` and not yet in a release on npm. Until a
release published after it is, use it from source. v0.3.0 is tagged but not
published, and that tag predates the `skill` command, so a publish from it will
not include it.

## Limits

- Search is keyword scoring, not semantic search. It finds the words you used.
  Equal scores list the newest first.
- anote does not detect contradictions itself. When a fact changes, the agent
  promotes the old and new log lines and runs `anote supersede`; search and
  `anote show DATE` then mark the old log line with its replacement. The marker
  follows promote trails by line number, so a log hand-edited after a promote
  can put it on the wrong line.
- There is no sync, locking or history. Put the graph in git if you want those.
- Concurrent writers are not coordinated. Writes are atomic per file, but two
  processes editing the same note can still overwrite each other.

## Tests

```sh
npm install
npm test            # node:test, runs the real CLI against temp directories
npm run typecheck   # tsc --noEmit, strict
```

## Releasing

1. Bump `version` in `package.json` on `main`.
2. Push a tag `v` + that version, for example `git tag v0.3.1 && git push origin v0.3.1`.
   The `publish` workflow (`.github/workflows/publish.yml`) checks the tag matches
   the version and is on `main`, runs `npm ci` and `npm run check`, then runs
   `npm stage publish` through npm Trusted Publishing. No token is stored.
3. The version is now staged, not public. A maintainer opens Staged Packages on
   npmjs.com, checks it, and approves it with 2FA (or rejects it).

## License

MIT. See `LICENSE`.
