// search and list.
import * as fs from "node:fs";
import * as path from "node:path";
import type { Args } from "../args.ts";
import { graphDir, incoming, loadAll, mdFiles } from "../store.ts";
import { cmp, cpLen, padEnd, print, readText, slugify, words } from "../util.ts";
import { emit } from "./types.ts";

interface Doc {
  slug: string;
  title: string;
  body: string;
  tags: string[];
  kind: "note" | "daily";
  type?: string;
  source: string;
  updated: string;
  status: string;
  review: string;
}

/** Count non-overlapping occurrences of `needle` (Python str.count). */
function count(hay: string, needle: string): number {
  if (needle === "") return hay.length + 1;
  let n = 0;
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) n++;
  return n;
}

function score(doc: Doc, toks: string[]): number {
  const t = doc.title.toLowerCase();
  const b = doc.body.toLowerCase();
  const tg = doc.tags.join(" ").toLowerCase();
  let s = 0;
  for (const k of toks) {
    if (t.includes(k)) s += 5;
    if (tg.includes(k)) s += 3;
    s += Math.min(count(b, k), 5);
  }
  if (s && toks.every((k) => (t + " " + b + " " + tg).includes(k))) s += 3;
  return s;
}

function snippet(body: string, toks: string[], width = 140): string {
  const flat = words(body).join(" ");
  const low = flat.toLowerCase();
  const hits = toks.map((k) => low.indexOf(k)).filter((i) => i >= 0);
  const pos = hits.length > 0 ? Math.min(...hits) : 0;
  const start = Math.max(0, pos - 40);
  const chunk = flat.slice(start, start + width);
  return (start > 0 ? "..." : "") + chunk + (start + width < flat.length ? "..." : "");
}

export function cmdSearch(a: Args): void {
  const g = graphDir(a.str("graph"));
  const notes = loadAll(g);
  const toks = a.list("query").filter((t) => t.trim() !== "").map((t) => t.toLowerCase());
  const typeFlag = a.str("type");
  const docs: Doc[] = [];
  for (const [s, n] of notes) {
    if ((n.status === "active" || a.flag("all")) && (!typeFlag || n.kind === typeFlag)) {
      docs.push({
        slug: s, title: n.title, body: n.body, tags: n.tags, kind: "note", type: n.kind,
        source: n.meta["source"] ?? "", updated: n.meta["updated"] ?? "", status: n.status,
        review: n.meta["review"] ?? "",
      });
    }
  }
  const dd = path.join(g, "daily");
  if (fs.existsSync(dd) && fs.statSync(dd).isDirectory() && !typeFlag) {
    for (const f of mdFiles(dd)) {
      const stem = f.slice(0, -3);
      docs.push({
        slug: "daily/" + stem, title: stem, tags: [], body: readText(path.join(dd, f)), kind: "daily",
        source: "log", updated: stem, status: "active", review: "",
      });
    }
  }
  const ranked = docs
    .map((d) => ({ sc: score(d, toks), d }))
    .sort((x, y) => y.sc - x.sc || cmp(x.d.slug, y.d.slug));
  const limit = a.num("limit");
  const budget = a.num("budget");
  const results: Array<Doc & { score: number; snippet: string }> = [];
  let used = 0;
  for (const { sc, d } of ranked) {
    if (sc <= 0 || results.length >= limit) break;
    const r = { ...d, score: sc, snippet: snippet(d.body, toks) };
    const cost = Math.floor((cpLen(r.slug) + cpLen(r.title) + cpLen(r.snippet) + 30) / 4);
    if (budget && results.length > 0 && used + cost > budget) break;
    used += cost;
    results.push(r);
  }
  if (a.flag("json")) {
    // Same keys and order as the original, minus the body.
    const rows = results.map((r) => {
      const row: Record<string, unknown> = {
        slug: r.slug, title: r.title, tags: r.tags, kind: r.kind,
      };
      if (r.kind === "note") row["type"] = r.type;
      Object.assign(row, {
        source: r.source, updated: r.updated, status: r.status, review: r.review,
        score: r.score, snippet: r.snippet,
      });
      return row;
    });
    emit(a, rows, "");
    return;
  }
  if (results.length === 0) {
    print("no matches");
    return;
  }
  const out: string[] = [];
  for (const r of results) {
    const flag = r.status === "active" ? "" : ` (${r.status})`;
    out.push(`${r.slug}  "${r.title}"${flag}  [${r.source}, ${r.updated}]`);
    out.push("    " + r.snippet);
  }
  print(out.join("\n"));
}

export function cmdList(a: Args): void {
  const g = graphDir(a.str("graph"));
  const notes = loadAll(g);
  const inc = incoming(notes);
  const status = a.need("status");
  const tag = a.str("tag");
  const typeFlag = a.str("type");
  let rows = [];
  for (const [s, n] of notes) {
    if (status !== "all" && n.status !== status) continue;
    if (tag && !n.tags.includes(slugify(tag))) continue;
    if (typeFlag && n.kind !== typeFlag) continue;
    rows.push({
      slug: s, title: n.title, type: n.kind, source: n.meta["source"] ?? "",
      updated: n.meta["updated"] ?? "", status: n.status, out: n.links.length, in: (inc.get(s) ?? []).length,
    });
  }
  // newest first: updated descending, then slug descending
  rows.sort((x, y) => cmp(y.updated, x.updated) || cmp(y.slug, x.slug));
  const limit = a.num("limit");
  if (limit) rows = rows.slice(0, limit);
  const text = rows
    .map((r) =>
      `${padEnd(r.slug, 44)} ${r.updated}  ${padEnd(r.source, 9)} ${padEnd(r.type || "-", 10)} ` +
      `o:${r.out} i:${r.in}  ${r.title}`)
    .join("\n") || "no notes";
  emit(a, rows, text);
}
