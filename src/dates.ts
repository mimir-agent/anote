// Review-date parsing and phrasing.
import { addDays, daysBetween, die, isoDate, parseDate, today } from "./util.ts";

const UNIT_DAYS: Record<string, number> = { d: 1, w: 7, m: 30 };

/**
 * Parse a review value. 'none' or '' gives null; '+30d' / '2w' / '3m'
 * (30-day months) count from today; otherwise a YYYY-MM-DD date.
 */
export function when(value: string | undefined | null): string | null {
  if (value === undefined || value === null) return null;
  const v = value.trim().toLowerCase();
  if (v === "" || v === "none") return null;
  const m = /^\+?(\d+)([dwm])$/.exec(v);
  if (m) {
    const days = Number(m[1]) * (UNIT_DAYS[m[2] as string] as number);
    return isoDate(addDays(today(), days));
  }
  if (parseDate(v) !== null) return v;
  die(2, `cannot read date '${value}' (use YYYY-MM-DD, +30d, +6w, +3m or none)`);
}

/** Parse a note's stored review date, or fail (exit 1) naming the note. `anote check` reports the same fault. */
export function reviewDate(slug: string, rev: string): number {
  const d = parseDate(rev);
  if (d === null) die(1, `${slug}: review is not a date: '${rev}' (run anote check)`);
  return d;
}

/** "overdue by 3d", "due today" or "in 5d". */
export function reviewPhrase(slug: string, rev: string): string {
  const days = daysBetween(reviewDate(slug, rev), today());
  if (days < 0) return `overdue by ${-days}d`;
  if (days === 0) return "due today";
  return `in ${days}d`;
}
