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

npm has the latest published release; `main` may be ahead of it. The newest
release on npm is 0.2.1, which predates `brief`, `skill`, `hook`, the `url`
field, `publish` and the `(due)` search marker. Until a later release is
published, install from source to use them.

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

With no graph at the path, brief prints `anote: no graph at PATH (run anote
init)` to stderr and exits 1, instead of printing an empty brief.

### Claude Code: brief at every session start

Claude Code can run a command when a session starts (startup, resume, `/clear`
and compaction) and add what it prints to the context. `anote hook claude`
prints that hook, and `--write` adds it to your settings:

```sh
anote hook claude            # print the hook and the file it goes in; writes nothing
anote hook claude --write    # add it to ~/.claude/settings.json
anote hook claude --write --settings .claude/settings.json   # a project's settings
```

Without `--write` it prints the block it would add (the home, install and
graph paths below stand in for yours):

```sh
$ anote hook claude
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "'/path/to/anote' brief --budget 2000 --graph '/path/to/graph'"
          }
        ]
      }
    ]
  }
}
This goes in /home/you/.claude/settings.json; run `anote hook claude --write` to add it there.
```

With `--write` on an existing file:

```sh
$ anote hook claude --write
added the hook to /home/you/.claude/settings.json
backup: /home/you/.claude/settings.json.anote-backup
$ anote hook claude --write
unchanged: /home/you/.claude/settings.json already has this hook
```

The hook runs `'/abs/path/to/anote' brief --budget 2000 --graph '/abs/path/to/graph'`. The
graph path is fixed when you run the command (from `--graph`, `$ANOTE_GRAPH` or
`~/.hermes/graph`), because the hook's shell may not have `ANOTE_GRAPH` set.
`--budget` sets brief's budget, from 200 to 10000 characters (Claude Code adds
at most 10,000 characters of hook output).

`--write` creates the settings file if it is missing. Otherwise it first copies
the file to `settings.json.anote-backup` (replacing an older backup), then adds
one hook and keeps every other setting. The file is written back as JSON
indented with two spaces, so its formatting may change. Running it again
changes nothing. If a different `anote brief` hook is already there, it is
only replaced with `--force`. A file that is not
plain JSON (comments count) is refused and left as it was.

The hook names anote by the absolute path of the copy that wrote it (the repo's
`anote` launcher, or `bin/anote.js` in an npm install), so it works when Claude
Code's hook shell does not have anote on its PATH. If you move that copy, run
`anote hook claude --write --force` again. A hook written by an older anote
with the bare word `anote` is replaced only with `--force`.

`hook claude` never reads or creates the graph and does not run brief. If no
graph exists at the path yet, it still prints or writes the hook and warns on
stderr that the hook will report an error until you run `anote init`.

There is no remove command. To remove the hook, delete the object whose
`command` contains `brief --budget` from `hooks.SessionStart` in the settings
file (and the `SessionStart` entry around it if nothing else is left in it),
or restore the `.anote-backup` copy. The backup is the file as it was before
the most recent `--write` that changed it, so restoring it also undoes any
other edit made to the settings since. When `--write` created the file, there
is no backup.

### Codex CLI: brief at every session start

Codex can also run a command when a session starts (startup, resume, clear,
compact and fork) and add what it prints to the context. `anote hook codex`
works like `hook claude`, with the same flags, output and refusals, but writes
to Codex's hooks file:

```sh
anote hook codex             # print the hook and the file it goes in; writes nothing
anote hook codex --write     # add it to ~/.codex/hooks.json ($CODEX_HOME/hooks.json if set)
anote hook codex --write --settings .codex/hooks.json   # a project's hooks
```

Codex runs a new hook only after you trust it. After printing or writing the
hook, anote reminds you: open `/hooks` in Codex and approve it. A project's
hooks also need the project's `.codex` folder to be trusted.

`--budget` goes from 200 to 8000 characters here (default 2000). Codex moves
hook output over roughly 2,500 tokens to a file and shows the model only the
start and end of it, so 8000 characters (about 4 per token, an estimate)
keeps the brief whole.

`hook codex` reads and writes only the hooks file it names and its
`.anote-backup`. It never touches `config.toml`, `auth.json` or anything else
under `~/.codex`, and never runs codex or brief. If you added an `anote brief`
hook to `config.toml` by hand, remove it, or you get two briefs. The hook
names anote by its absolute path, as `hook claude` does, so anote does not
need to be on Codex's PATH; if you move that copy of anote, run
`anote hook codex --write --force` again.

To remove the hook, delete its object from `hooks.SessionStart` in the hooks
file, or restore the `.anote-backup` copy, as for Claude Code above.

Checked against the Codex hooks docs (2026-10-19); not yet run in a real Codex session.

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
note re-checked and pushes the date out. `anote search` marks the same notes
with `(due)` on their hit line, so a past-review note is not read as current
(`--json` output has no marker; it carries each hit's `review` date instead):

```sh
$ anote search starter --budget 300
sourdough-starter-guide  "Sourdough starter guide"  [observed, 2026-10-19]
    Feed the starter twice a day at room temperature.
a-starter-doubles-in-four-to-six-hours  "A starter doubles in four to six hours" (due)  [observed, 2026-10-19]
    Measured over a week at 22C.
daily/2026-10-19  "2026-10-19"  [log, 2026-10-19]
    # 2026-10-19 - 22:04 [observed] the starter rose faster after moving it near the oven
```

When a claim is wrong, `anote supersede OLD NEW` retires the old note instead
of overwriting it. Superseded notes drop out of search and lists, and stay on
disk with a pointer to their replacement.

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
| `set NOTE KEY VALUE` | change title, type, source, stance, version, review, tags or url |
| `append NOTE TEXT` | add text to the end of a note |
| `supersede OLD NEW` | retire a note in favor of a newer one |
| `check` | lint the graph |
| `brief` | due notes, then recent log lines, cut to `--budget` characters (default 2000) |
| `skill install` | copy the bundled skill into `--agent hermes`, `--agent claude` or `--dir DIR` |
| `skill path` | print where the bundled skill file is |
| `hook claude` | print, or add with `--write`, a Claude Code hook that runs brief at session start |
| `hook codex` | print, or add with `--write`, a Codex CLI hook that runs brief at session start |
| `publish mark NOTE` | mark one note for publishing (see Publishing) |
| `publish unmark NOTE` | clear that mark |
| `publish preview` | print the records an export would write, and what is left out |
| `publish send` | dry run: what a send to your own repo would create, update or leave alone; `--write` sends |

A note can be named by slug, by exact title, or by a unique slug prefix.
Dates accept `YYYY-MM-DD`, `+30d`, `+6w` or `+3m`.

Exit codes: 0 ok, 1 runtime error or failed check, 2 usage error, 3 note not
found or ambiguous. Data goes to stdout and errors go to stderr.

## Publishing

A note can carry the page it is about: `anote add ... --url URL` or
`anote set NOTE url URL` (`none` clears it). Any note type in any graph may
have one.

anote can work out which records a note would become, using Semble's record
types, and send them to your own repository. `publish mark`, `publish unmark`
and `publish preview` open no network connection, and `publish preview` writes
no file. `publish send` is a dry run that only reads, unless `--write` is given
with its confirmation hash (see below).

The guarantees, in short:

- Nothing is published unless you mark the note and then run
  `publish send --write` and confirm its hash. No other command sends anything.
- Person notes and daily logs can never be marked or sent.
- A link to or from a note that is not marked is never exported, and neither
  is a `[[mention]]` of one: `check` and `send` stop on it.
- The records use Semble's record types, but nothing here promises that Semble
  or any other app will display them.

A worked example in a graph with two notes that have urls, one linked to the
other, a concept with no url linked to one of them, a person note, and a log
line (all invented):

```sh
$ anote publish mark sourdough-starter-guide
marked sourdough-starter-guide for publishing
$ anote publish mark a-starter-doubles-in-four-to-six-hours
marked a-starter-doubles-in-four-to-six-hours for publishing
$ anote publish mark sam-example
anote: cannot mark sam-example: person notes are never published (G3)
$ anote publish mark kitchen-scratch-list
anote: cannot mark kitchen-scratch-list: it has no url; set one with `anote set kitchen-scratch-list url URL` (G9)
$ anote publish mark 2026-10-19
anote: cannot publish 2026-10-19: daily logs are never published (G3)
$ anote publish preview
preview only: nothing is sent and no file is written

cards (4):
  URL   https://example.org/starter-timing  "A starter doubles in four to six hours"
  NOTE  on https://example.org/starter-timing  (28 bytes)
  URL   https://example.com/starter-guide  "Sourdough starter guide"
  NOTE  on https://example.com/starter-guide  (49 bytes)

connections (1):
  https://example.org/starter-timing -> https://example.com/starter-guide  RELATED  | [expands-on] 

collections (0):

left out (4):
  note kitchen-scratch-list: no url
  note sam-example: person
  link kitchen-scratch-list relates sourdough-starter-guide: unpublished source
  log 2026-10-19: log
```

The three refusals exit 2. `set` will not change the mark either:

```sh
$ anote set sourdough-starter-guide published no
anote: published is changed only by `anote publish mark` and `anote publish unmark`
```

The rules in full:

- Nothing is published by default. Only `anote publish mark NOTE` sets
  `published: yes`, and only `anote publish unmark NOTE` clears it; `set`
  refuses those keys.
- `publish mark` refuses (exit 2) person notes (however the type is cased or
  written), notes whose type does not check, daily logs, notes without a url,
  urls that are not public http or https (localhost, `.local` names,
  private or loopback IPs), and a url another marked note already has.
- Marking records a hash of the title, body, url and links. A note changed
  afterwards is left out until it is marked again.
- A note becomes a URL card for its url plus a NOTE card with its body. A link
  between two marked notes becomes a connection (`expands-on` is sent as
  RELATED, with `[expands-on] ` at the start of its note). A marked hub becomes
  a closed collection of the marked notes it links to; its description is the
  first 500 bytes of its body, and hand order and link types are lost.
- Links to or from unmarked notes are never part of a record. Type, source,
  version, review date, stance, tags and slugs never are.
- `publish preview [--json]` lists the cards, connections and collections, then
  every note, link and daily log left out and why.
- In a graph with at least one marked note, `check` also errors on a marked
  person note or one whose type does not check, hash drift, `[[mentions]]`
  (also `[[slug|alias]]`, `[[slug#heading]]` and `[[slug#^block]]`) of unmarked
  notes in a marked title, body or link note, a url on a single-label host,
  duplicate urls, a body over 10000 bytes, a link note over 1000, a hub title
  over 100, and control or bidi characters (which can hide text on screen) in
  a marked title, body, url or link note. A graph with no marked notes is
  checked as before.
- Unmarking or superseding a marked note only stops future exports. It warns
  that copies already sent may persist.

### publish send

`anote publish send [--json]` shows what a send would do. Without `--write` it
is only a dry run: it makes GET requests, reads no secret and writes nothing.
`anote publish send --write` sends (see "Sending" below).

`send --write` writes records to your own AT Protocol repository on your PDS.
They are public as soon as they are written. Anyone can read them, and relays
and indexers may keep copies; anote cannot take them back.

The account goes in `$ANOTE_PUBLISH_CONFIG`, or `~/.config/anote/publish.json`
when that is unset, with exactly these three keys (invented example):

```json
{"handle": "alice.example.com", "did": "did:plc:abcdefghijklmnopqrstuvwx", "pds": "https://pds.example.com"}
```

Secrets never go in this file; a key named like a password, secret, token or
key is refused. `pds` must be a public https address with no path or port, and
`did` must be a `did:plc`. Before reading any records, `send` checks that the
handle resolves to that did and that the DID document names that pds; any
mismatch stops it (exit 2).

`send` first runs the same publishing checks as `anote check` and stops if any
fail. Then it reads the account's own `network.cosmik.*` records and prints:

- the graph path and the account;
- every record, as create, update or unchanged. A record is matched to one
  already in the repo by its url (URL cards), its parent card (NOTE cards), its
  source, target and type (connections), its name (collections), or its
  collection and card (collection links). When a URL card changes, its NOTE card
  and collection links are updated too, because they point at it;
- the full text of every NOTE card, connection note and collection description
  it would create or update;
- records already in the repo that no marked note produces, under "left alone
  (anote never deletes)", with their AT URIs. anote never deletes. Unmarking a
  note stops future sends only; the records already written stay, and `send`
  lists them there. A renamed hub or a link whose type changed becomes a new
  record, and the old one is left alone too;
- every note, link and daily log left out, and why;
- the number of writes and a 12-character confirmation hash of the exact
  writes, the records they replace, the account and the graph. `--write`
  refuses unless the hash still matches.

An update keeps the record and its `createdAt`. If the copy in the repo has
fields anote does not write (say a description Semble added to a URL card), the
dry run lists them under "drops fields the repo copy has", because the update
replaces the record with what the note says.

A run with no graph change since the last send plans no writes. More than 50
writes in one run is refused (`--max N` sets a lower cap), as is a collection
holding more than 1000 records, and two records in the repo with the same
identity (anote does not pick one). `--password`, `--token`, `--did`, `--pds`
and `--delete` are refused outright, and so is any unknown option, without
showing its value.

Read the dry run, including the full note text, before confirming. It is the
last check before something becomes public.

#### Sending

Create an app password in your PDS account settings and export it as
`ANOTE_PUBLISH_APP_PASSWORD`.

`anote publish send --write --confirm HASH` sends, where HASH is the
confirmation hash the dry run printed. On a terminal, `--confirm` can be left
off: `send --write` prints the dry run and asks you to type the hash; anything
else aborts. Without a terminal, `--confirm` is required.

- `--write` works everything out again from the graph and the repo, never from
  a saved dry run. If the hash differs, it stops with "plan changed since the
  dry run; run it again and read it" and sends nothing.
- With nothing to send it says "nothing to send" and reads no password.
- Only then does it read `ANOTE_PUBLISH_APP_PASSWORD` (unset or empty stops it,
  exit 2), and signs in once. The account it signs in as must be the config
  `did`. The password and the session are kept in memory for that run only and
  are never written or printed.
- It checks once more that every record comes from an active, marked note that
  is not a person note or a log and that passes the publish checks, and stops
  the whole run if one does not.
- It writes one record per request with `com.atproto.repo.putRecord`, only to
  the four `network.cosmik.*` collections and only to the config `did`'s repo:
  URL cards, then NOTE cards, connections, collections and collection links.
  New records get new keys; an update keeps the record's key and is refused by
  the server if the record changed since this run read it. anote never deletes.
- A failed request (network error or 5xx, after one retry; any 4xx; a 429 rate
  limit) stops the run with exit 1, naming the endpoint, the HTTP status, the
  server's error code, the first record that failed and the records already
  written. Run `send` again to finish: records already written are found in the
  repo and not repeated.
- Each write is logged, one JSON line per attempt, to
  `$XDG_STATE_HOME/anote/publish-log.jsonl` (else
  `~/.local/state/anote/publish-log.jsonl`), mode 600: time, did, collection,
  AT URI, cid, action and a sha256 of the note's slug. No text, titles, urls or
  credentials. Nothing reads it back; losing it loses nothing.

The records use Semble's record types (`network.cosmik.*`). anote does not talk
to Semble. Whether Semble, or any other app, shows or indexes them is up to that
app, and has not been tested.

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

It prints the path it wrote, and says so when there was nothing to do:

```sh
$ anote skill install --agent claude
/home/you/.claude/skills/anote/SKILL.md
$ anote skill install --agent claude
already up to date: /home/you/.claude/skills/anote/SKILL.md
```

It never touches the graph. An identical file is left alone, a different one is
only replaced with `--force`, and if the agent already has another skill named
anote, nothing is written.
`anote skill path` prints where the bundled file is. The same file is on GitHub:
[skills/anote/SKILL.md](https://github.com/mimir-agent/anote/blob/main/skills/anote/SKILL.md).

The `skill` command is on `main` and not yet in a release on npm. Until a
release published after it is, use it from source. v0.3.0 is tagged but not
published, and that tag predates the `skill`, `hook` and `publish` commands,
so a publish from it will not include them.

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
