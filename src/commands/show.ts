// show: one note with its links, or a daily log by date.
import * as fs from "node:fs";
import * as path from "node:path";
import type { Args } from "../args.ts";
import { reviewPhrase } from "../dates.ts";
import { DATE_RE } from "../schema.ts";
import { getNote, graphDir, incoming, loadAll, resolve } from "../store.ts";
import { die, padEnd, print, readText, splitlines } from "../util.ts";
import { emit } from "./types.ts";

/** "#reference #text" from "reference text". */
function hashtags(raw: string): string {
  return raw.split(/\s+/).filter((x) => x !== "").map((x) => "#" + x.replace(/^#+/, "")).join(" ");
}

function showDaily(a: Args, g: string, ref: string): void {
  const p = path.join(g, "daily", ref + ".md");
  if (!fs.existsSync(p)) die(3, `no daily note for ${ref}`);
  const text = readText(p);
  let count = 0;
  const view: string[] = [];
  for (let line of splitlines(text.replace(/\n+$/, ""))) {
    if (line.startsWith("- ")) {
      count++;
      line = `[${count}] ${line}`;
    }
    view.push(line);
  }
  emit(a, { daily: ref, content: text }, view.join("\n"));
}

export function cmdShow(a: Args): void {
  const g = graphDir(a.str("graph"));
  const ref = a.need("note").trim();
  if (DATE_RE.test(ref)) {
    showDaily(a, g, ref);
    return;
  }
  const notes = loadAll(g);
  const s = resolve(notes, ref);
  const n = getNote(notes, s);
  const inc = incoming(notes);
  const outLinks = n.links.map((l) => ({
    type: l.type,
    to: l.to,
    note: l.note,
    title: notes.has(l.to) ? getNote(notes, l.to).title : null,
  }));
  const inLinks = (inc.get(s) ?? []).map((i) => ({
    type: i.type,
    from: i.from,
    note: i.note,
    title: getNote(notes, i.from).title,
  }));
  if (a.flag("json")) {
    emit(a, { slug: s, meta: { ...n.meta }, body: n.body, links_out: outLinks, links_in: inLinks }, "");
    return;
  }
  const lines = [`# ${n.title}  [${s}]`];
  if (n.meta["type"]) lines.push("type: " + hashtags(n.meta["type"]));
  if (n.kind === "assertion") {
    lines.push("stance: " + (n.meta["stance"] || "not stated (not anyone's position)"));
  }
  const bits = ["source: " + (n.meta["source"] ?? "?")];
  for (const k of ["version", "created", "updated", "confirmed"]) {
    if (n.meta[k]) bits.push(`${k}: ${n.meta[k]}`);
  }
  const rev = n.meta["review"];
  if (rev) bits.push(`review: ${rev} (${reviewPhrase(n.slug, rev)})`);
  lines.push(bits.join(" | "));
  if (n.tags.length > 0) lines.push("tags: " + n.tags.join(", "));
  if (n.status !== "active") {
    const by = n.meta["superseded_by"];
    lines.push(`STATUS: ${n.status}${by ? ` by [${by}]` : ""}`);
  }
  if (n.meta["supersedes"]) lines.push("supersedes: " + n.meta["supersedes"]);
  if (n.body) lines.push("", n.body);
  if (outLinks.length > 0) {
    lines.push("", "links out:");
    for (const l of outLinks) {
      lines.push(
        `  ${padEnd(l.type, 18)} -> ${l.to}${l.title ? `  "${l.title}"` : "  (MISSING)"}${l.note ? "  | " + l.note : ""}`,
      );
    }
  }
  if (inLinks.length > 0) {
    lines.push("", "links in:");
    for (const l of inLinks) {
      lines.push(`  ${padEnd(l.type, 18)} <- ${l.from}  "${l.title}"${l.note ? "  | " + l.note : ""}`);
    }
  }
  print(lines.join("\n"));
}
