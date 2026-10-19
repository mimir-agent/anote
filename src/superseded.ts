// Which daily log lines were promoted to a note that has since been superseded.
// Read only: the mapping comes from promote trails in the log
// ("promoted line N of DATE to [[slug]]") and each note's status and superseded_by.
import * as fs from "node:fs";
import * as path from "node:path";
import { DATE_RE, LOG_LINE } from "./schema.ts";
import { dailyBullets, mdFiles, type Notes } from "./store.ts";
import { cmp } from "./util.ts";

/** Log line `line` was promoted to `note`, which is superseded; `by` is the end of the chain. */
export interface SupersededLine {
  line: number;
  note: string;
  by: string;
}

/** Superseded lines per log date, each list sorted by line then note. */
export type SupersededLog = Map<string, SupersededLine[]>;

const TRAIL = /^promoted line (\d+) of (\d{4}-\d{2}-\d{2}) to \[\[([^\]|]+)\]\]$/;

/** The note's superseded_by when it is superseded, else undefined. */
function successor(notes: Notes, slug: string): string | undefined {
  const n = notes.get(slug);
  return n?.status === "superseded" ? n.meta["superseded_by"] || undefined : undefined;
}

/**
 * End of the superseded_by chain from `slug`, or undefined when `slug` is not
 * superseded. A hand-edited cycle (A by B, B by A) stops before it repeats.
 */
function replacement(notes: Notes, slug: string): string | undefined {
  let by = successor(notes, slug);
  if (by === undefined) return undefined;
  const seen = new Set([slug]);
  for (;;) {
    const after = successor(notes, by);
    if (after === undefined || seen.has(after)) return by;
    seen.add(by);
    by = after;
  }
}

/** Read every promote trail in the log and keep the ones whose note is superseded. */
export function supersededLog(g: string, notes: Notes): SupersededLog {
  const out: SupersededLog = new Map();
  const dd = path.join(g, "daily");
  if (!fs.existsSync(dd) || !fs.statSync(dd).isDirectory()) return out;
  const days = mdFiles(dd).map((f) => f.slice(0, -3)).filter((d) => DATE_RE.test(d));
  const bulletCount = new Map(days.map((d) => [d, dailyBullets(path.join(dd, d + ".md")).length]));
  for (const day of days) {
    for (const raw of dailyBullets(path.join(dd, day + ".md"))) {
      const text = LOG_LINE.exec(raw)?.[3];
      const t = text === undefined ? null : TRAIL.exec(text);
      if (!t) continue;
      const line = Number(t[1]);
      const date = t[2] as string;
      const note = t[3] as string;
      const count = bulletCount.get(date);
      if (count === undefined || line < 1 || line > count) continue;
      const by = replacement(notes, note);
      if (by === undefined) continue;
      const list = out.get(date) ?? [];
      if (!list.some((s) => s.line === line && s.note === note)) list.push({ line, note, by });
      out.set(date, list);
    }
  }
  for (const list of out.values()) list.sort((x, y) => x.line - y.line || cmp(x.note, y.note));
  return out;
}

/** The marker printed next to a superseded log line. */
export function marker(s: SupersededLine): string {
  return `(superseded: ${s.note} by ${s.by})`;
}
