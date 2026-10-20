# Changelog

User-visible changes in each release. Releases before 0.4.0 are described in
their GitHub release notes: https://github.com/mimir-agent/anote/releases

## 0.4.0

New commands and flags. Notes written by 0.3.0 still work as they are; no
migration is needed.

### New

- `anote skill install (--agent hermes|claude | --dir DIR)` copies the bundled
  agent skill into an agent's skills folder. It never overwrites a different
  file unless you pass `--force`, and it refuses if the agent already has
  another skill named anote. `anote skill path` prints where the bundled file
  is.
- `anote hook claude` prints a Claude Code SessionStart hook that runs
  `anote brief` at the start of every session. `--write` adds it to
  `~/.claude/settings.json` (or the file given with `--settings`), keeps every
  other setting, and saves a backup of the old file first. The hook names
  anote and the graph by their absolute paths, so it works when Claude Code
  starts with a short PATH.
- A note can carry the page it is about: `anote add ... --url URL`, or
  `anote set NOTE url URL` (`none` clears it).
- `anote publish mark NOTE` and `anote publish unmark NOTE` choose which notes
  may be published. `anote publish preview` shows the records the marked notes
  would become, and everything left out with the reason. Neither opens a
  network connection.
- `anote publish send` shows what a send to your own AT Protocol repository
  would create, update or leave alone. It only reads, and prints a
  confirmation hash. `anote publish send --write --confirm HASH` sends those
  records. Records are public once written and anote never deletes them;
  read the README's Publishing section before using it. Person notes and daily
  logs can never be marked or sent.

### Changed

- `anote search` marks a note hit whose review date has arrived with `(due)`,
  the same rule `anote stale` and `anote brief` use. `--json` output is
  unchanged.
- `anote search` lists equal-scoring hits newest first, so a small `--budget`
  keeps the newest fact.
- When a log line was promoted to a note that has since been superseded,
  `anote search` and `anote show DATE` say so next to that line, naming the
  note that replaced it. `search --json` and `show DATE --json` gain a
  `superseded` key.
- `anote brief` on a graph folder that does not exist now prints
  `anote: no graph at PATH (run anote init)` and exits 1. Before, it printed
  "nothing due" and exited 0, which looked like a healthy empty graph.
  `anote hook claude` warns when the graph it points at does not exist yet.
- `anote check` reports publishing problems, but only in a graph with at least
  one marked note.
