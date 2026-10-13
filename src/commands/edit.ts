// stale, confirm, set, append, supersede: commands that read or change existing notes.
import type { Args } from "../args.ts";
import { reviewPhrase, when } from "../dates.ts";
import {
  DEFAULT_REVIEW, SETTABLE, SOURCES, STANCES, checkType, normTags,
} from "../schema.ts";
import { dueNotes, getNote, graphDir, loadAll, resolve, save, touch } from "../store.ts";
import {
  clean, cmp, die, isoDate, lookup, padEnd, parseDate, print, readStdin, strip, stripNewlines, today,
} from "../util.ts";
import { emit } from "./types.ts";

export function cmdStale(a: Args): void {
  const g = graphDir(a.str("graph"));
  const notes = loadAll(g);
  const cutoff = parseDate(when(a.need("within")) ?? isoDate(today())) as number;
  const due = dueNotes(notes, cutoff);
  const undated = [...notes]
    .filter(([, n]) => n.status === "active" && !n.meta["review"])
    .map(([s]) => s)
    .sort(cmp);
  const text = due.map((r) =>
    `${padEnd(r.slug, 44)} review ${r.review} (${reviewPhrase(r.slug, r.review)})  ${r.source}${r.version ? "  " + r.version : ""}`);
  if (undated.length > 0) text.push("no review date: " + undated.join(", "));
  emit(a, { due, undated }, text.join("\n") || "nothing due");
}

export function cmdConfirm(a: Args): void {
  const g = graphDir(a.str("graph"));
  const notes = loadAll(g);
  const n = getNote(notes, resolve(notes, a.need("note")));
  const reviewFlag = a.str("review");
  const src = n.meta["source"] ?? "observed";
  const review = reviewFlag !== undefined
    ? when(reviewFlag)
    : when(lookup(DEFAULT_REVIEW, src) ?? "+60d");
  n.meta["confirmed"] = isoDate(today());
  if (review) n.meta["review"] = review;
  else delete n.meta["review"];
  const version = a.str("version");
  if (version) n.meta["version"] = clean(version);
  touch(n);
  save(g, n);
  print(`confirmed ${n.slug}${review ? ", next review " + review : ""}`);
}

export function cmdSet(a: Args): void {
  const g = graphDir(a.str("graph"));
  const notes = loadAll(g);
  const n = getNote(notes, resolve(notes, a.need("note")));
  const k = a.need("key");
  const v = a.need("value");
  if (!(SETTABLE as readonly string[]).includes(k)) die(2, `can set: ${SETTABLE.join(", ")}`);
  if (k === "type") {
    const newType = checkType(v);
    const head = newType.split(" ")[0];
    if (head === "person") die(2, "person notes are created with `add --type person --person-ok`");
    n.meta[k] = newType;
    if (n.meta["stance"] && head !== "assertion") delete n.meta["stance"];
  } else if (k === "stance") {
    if (n.kind !== "assertion") die(2, "stance only applies to assertions");
    if (v === "none") delete n.meta[k];
    else if ((STANCES as readonly string[]).includes(v)) n.meta[k] = v;
    else die(2, `stance must be one of: ${STANCES.join(", ")}, or none`);
  } else if (k === "source") {
    if (!(SOURCES as readonly string[]).includes(v)) die(2, `source must be one of: ${SOURCES.join(", ")}`);
    n.meta[k] = v;
  } else if (k === "review") {
    const r = when(v);
    if (r) n.meta[k] = r;
    else delete n.meta[k];
  } else if (k === "tags") {
    n.meta[k] = normTags([v]).join(", ");
    if (!n.meta[k]) delete n.meta[k];
  } else {
    n.meta[k] = clean(v);
  }
  touch(n);
  save(g, n);
  print(`set ${k} on ${n.slug}`);
}

export function cmdAppend(a: Args): void {
  const g = graphDir(a.str("graph"));
  const notes = loadAll(g);
  const n = getNote(notes, resolve(notes, a.need("note")));
  const parts = a.list("text");
  const text = parts.length === 1 && parts[0] === "-" ? readStdin() : parts.join(" ");
  if (!strip(text)) die(2, "nothing to append");
  n.body = stripNewlines(n.body.replace(/\n+$/, "") + "\n\n" + stripNewlines(text));
  touch(n);
  save(g, n);
  print(`appended to ${n.slug}`);
}

export function cmdSupersede(a: Args): void {
  const g = graphDir(a.str("graph"));
  const notes = loadAll(g);
  const old = resolve(notes, a.need("old"));
  const next = resolve(notes, a.need("new"));
  if (old === next) die(2, "a note cannot supersede itself");
  const o = getNote(notes, old);
  const n = getNote(notes, next);
  o.meta["status"] = "superseded";
  o.meta["superseded_by"] = next;
  const prior = (n.meta["supersedes"] ?? "").split(",").filter((x) => strip(x) !== "").map(strip);
  n.meta["supersedes"] = [...new Set([...prior, old])].sort(cmp).join(", ");
  touch(o);
  touch(n);
  save(g, o);
  save(g, n);
  print(`${old} is superseded by ${next}`);
}
