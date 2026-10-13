// brief: what is due for review and the latest log lines, cut to a character budget.
import * as fs from "node:fs";
import * as path from "node:path";
import type { Args } from "../args.ts";
import { DATE_RE } from "../schema.ts";
import { dailyBullets, dueNotes, graphDir, loadAll } from "../store.ts";
import { cmp, cpLen, die, print, today } from "../util.ts";

export const MIN_BUDGET = 200;

/** Daily log bullets across every day, newest first, each prefixed with its date. */
function logLinesNewestFirst(g: string): string[] {
  const dd = path.join(g, "daily");
  if (!fs.existsSync(dd)) return [];
  const days = fs
    .readdirSync(dd)
    .filter((f) => f.endsWith(".md") && DATE_RE.test(f.slice(0, -3)))
    .sort(cmp)
    .reverse();
  const out: string[] = [];
  for (const f of days) {
    const day = f.slice(0, -3);
    for (const b of dailyBullets(path.join(dd, f)).reverse()) out.push(`  ${day} ${b.slice(2)}`);
  }
  return out;
}

/** Length of `lines` once printed, one newline after each. */
function printedLen(lines: string[]): number {
  return lines.reduce((n, l) => n + cpLen(l) + 1, 0);
}

export function cmdBrief(a: Args): void {
  if (a.flag("json")) die(2, "brief has no --json output");
  const budget = a.num("budget");
  if (budget < MIN_BUDGET) die(2, `--budget must be at least ${MIN_BUDGET} characters, got ${budget}`);
  const g = graphDir(a.str("graph"));
  const due = dueNotes(loadAll(g), today()).map((d) => `  ${d.slug}  "${d.title}"  review ${d.review}`);
  const logs = logLinesNewestFirst(g);

  const dueHead = ["due notes:", ...(due.length === 0 ? ["  nothing due"] : [])];
  const logHead = ["log lines:", ...(logs.length === 0 ? ["  no log lines"] : [])];
  // Whole lines in fill order: due notes first, then log lines. Stop at the first that does not fit.
  const candidates = [...due, ...logs];
  const fixed = printedLen(dueHead) + printedLen(logHead);
  let used = fixed;
  let kept = 0;
  for (const line of candidates) {
    const cost = cpLen(line) + 1;
    if (used + cost > budget) break;
    used += cost;
    kept++;
  }
  // The "(N more left out)" line counts inside the budget, so give back lines until it fits.
  // MIN_BUDGET leaves room for both headers plus the trailer, so this never gives back more than it kept.
  const trailer = (n: number) => `(${n} more left out)`;
  while (kept < candidates.length && used + cpLen(trailer(candidates.length - kept)) + 1 > budget) {
    kept--;
    used -= cpLen(candidates[kept] as string) + 1;
  }
  const keptDue = due.slice(0, Math.min(kept, due.length));
  const keptLogs = logs.slice(0, Math.max(0, kept - due.length));
  const lines = [...dueHead, ...keptDue, ...logHead, ...keptLogs];
  if (kept < candidates.length) lines.push(trailer(candidates.length - kept));
  print(lines.join("\n"));
}
