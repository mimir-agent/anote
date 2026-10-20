// publish mark, publish unmark and publish preview. Local only: these open no
// network connection, and preview writes no file.
import * as fs from "node:fs";
import * as path from "node:path";
import type { Args } from "../args.ts";
import { DATE_RE } from "../schema.ts";
import { getNote, graphDir, loadAll, mdFiles, resolve, save, touch } from "../store.ts";
import type { Notes } from "../store.ts";
import { die, print, printErr } from "../util.ts";
import {
  MARKED, buildPlan, bytes, contentHash, isMarked, typeProblem, urlProblem, urlTakenBy,
} from "../publish.ts";
import type { LeftOut } from "../publish.ts";
import { emit } from "./types.ts";

/** Resolve the NOTE argument, refusing daily logs first (G3). */
function target(notes: Notes, raw: string): string {
  const ref = raw.trim();
  if (DATE_RE.test(ref)) die(2, `cannot publish ${ref}: daily logs are never published (G3)`);
  return resolve(notes, ref);
}

export function cmdPublishMark(a: Args): void {
  const g = graphDir(a.str("graph"));
  const notes = loadAll(g);
  const s = target(notes, a.need("note"));
  const n = getNote(notes, s);
  const no = `cannot mark ${s}:`;
  if (n.kind === "person") die(2, `${no} person notes are never published (G3)`);
  const tp = typeProblem(n);
  if (tp !== null) die(2, `${no} its type does not check (${tp}); fix the type first (G8)`);
  if (n.status !== "active") die(2, `${no} it is ${n.status}; only active notes are published`);
  if (n.kind !== "hub") {
    const url = n.meta["url"];
    if (!url) die(2, `${no} it has no url; set one with \`anote set ${s} url URL\` (G9)`);
    const p = urlProblem(url);
    if (p) die(2, `${no} ${p} (G9)`);
    const taken = urlTakenBy(notes, s, url);
    if (taken.length > 0) die(2, `${no} ${taken.join(", ")} is already marked with this url; one published note per url (G9)`);
  }
  const again = isMarked(n);
  n.meta["published"] = MARKED;
  n.meta["published_hash"] = contentHash(n);
  touch(n);
  save(g, n);
  print(again ? `marked ${s} again (content hash updated)` : `marked ${s} for publishing`);
}

export function cmdPublishUnmark(a: Args): void {
  const g = graphDir(a.str("graph"));
  const notes = loadAll(g);
  const s = target(notes, a.need("note"));
  const n = getNote(notes, s);
  if (n.meta["published"] === undefined && n.meta["published_hash"] === undefined) {
    print(`${s} is not marked`);
    return;
  }
  delete n.meta["published"];
  delete n.meta["published_hash"];
  touch(n);
  save(g, n);
  print(`unmarked ${s}`);
  printErr(`anote: warning: unmarking only stops future exports of ${s}; copies already sent may persist (G7)`);
}

function leftOutLine(l: LeftOut): string {
  if (l.kind === "note") return `  note ${l.note}: ${l.reason}`;
  if (l.kind === "log") return `  log ${l.log}: ${l.reason}`;
  return `  link ${l.from} ${l.type} ${l.to}: ${l.reason}`;
}

export function cmdPublishPreview(a: Args): void {
  const g = graphDir(a.str("graph"));
  const notes = loadAll(g);
  const dailyDir = path.join(g, "daily");
  const logs = fs.existsSync(dailyDir) ? mdFiles(dailyDir).map((f) => f.slice(0, -3)) : [];
  const plan = buildPlan(notes, logs);
  const records = { cards: plan.cards, connections: plan.connections, collections: plan.collections };
  const lines = ["preview only: nothing is sent and no file is written", "", `cards (${plan.cards.length}):`];
  for (const c of plan.cards) {
    if (c.type === "URL") lines.push(`  URL   ${c.url}  "${c.metadata.title}"`);
    else lines.push(`  NOTE  on ${c.parentCard.url}  (${bytes(c.text)} bytes)`);
  }
  lines.push("", `connections (${plan.connections.length}):`);
  for (const c of plan.connections) {
    lines.push(`  ${c.source} -> ${c.target}  ${c.connectionType}${c.note ? "  | " + c.note : ""}`);
  }
  lines.push("", `collections (${plan.collections.length}):`);
  for (const c of plan.collections) {
    lines.push(`  "${c.name}"  ${c.accessType}  ${c.memberships.length} membership(s)`);
    for (const m of c.memberships) lines.push(`    ${m.card}`);
  }
  lines.push("", `left out (${plan.left_out.length}):`, ...plan.left_out.map(leftOutLine));
  if (plan.notices.length > 0) lines.push("", "notes:", ...plan.notices.map((x) => "  " + x));
  emit(a, { records, left_out: plan.left_out, notices: plan.notices }, lines.join("\n"));
}
