// check: lint the graph. Exit 1 if any errors.
import type { Args } from "../args.ts";
import { Fail } from "../util.ts";
import { LINK_TYPES, SOURCES, STANCES, WIKILINK, checkType } from "../schema.ts";
import { getNote, graphDir, incoming, loadAll } from "../store.ts";
import { cmp, padEnd, parseDate, slugify } from "../util.ts";
import { emit } from "./types.ts";

type Level = "error" | "warn" | "info";
interface Issue {
  level: Level;
  note: string;
  message: string;
}

export function cmdCheck(a: Args): number {
  const g = graphDir(a.str("graph"));
  const errs: string[] = [];
  const notes = loadAll(g, errs);
  const issues: Issue[] = errs.map((message) => ({ level: "error", note: "", message }));
  const inc = incoming(notes);
  const add = (level: Level, note: string, message: string) => issues.push({ level, note, message });

  for (const [s, n] of notes) {
    if (!(SOURCES as readonly string[]).includes(n.meta["source"] ?? "")) {
      add("error", s, `source is missing or not one of ${SOURCES.join("/")}`);
    }
    const head = n.kind;
    if (!n.meta["type"]) add("warn", s, "no type");
    else {
      try {
        checkType(n.meta["type"]);
      } catch (e) {
        if (!(e instanceof Fail)) throw e;
        add("error", s, e.message);
      }
    }
    const stance = n.meta["stance"];
    if (stance && (!(STANCES as readonly string[]).includes(stance) || head !== "assertion")) {
      add("error", s, "stance is only for assertions and must be held or unheld");
    }
    if (head === "fragment" &&
        !n.links.some((l) => notes.has(l.to) && getNote(notes, l.to).kind === "reference")) {
      add("error", s, "a fragment must link back to the reference it came from");
    }
    if (head === "artifact" && n.links.length === 0) add("warn", s, "an artifact should link to what it draws on");
    if (head === "hub" && n.links.length < 2) add("warn", s, "a hub should link to at least two notes");
    if (head === "assertion" && n.title.trim().endsWith("?")) {
      add("warn", s, "title reads as a question; is this a question note?");
    }
    for (const k of ["created", "updated", "review", "confirmed"]) {
      const v = n.meta[k];
      if (v && parseDate(v) === null) add("error", s, `${k} is not a date: ${v}`);
    }
    for (const l of n.links) {
      if (!Object.hasOwn(LINK_TYPES, l.type)) add("error", s, `unknown link type '${l.type}'`);
      if (!notes.has(l.to)) add("error", s, `link to missing note '${l.to}'`);
    }
    if (n.status === "superseded") {
      const sb = n.meta["superseded_by"];
      if (!sb) add("error", s, "superseded but superseded_by is not set");
      else if (!notes.has(sb)) add("error", s, `superseded_by points at missing note '${sb}'`);
    }
    const mentioned = new Set([...n.body.matchAll(WIKILINK)].map((m) => m[1] as string));
    for (const w of [...mentioned].sort(cmp)) {
      if (!notes.has(slugify(w)) && !notes.has(w.trim())) add("warn", s, `body mentions [[${w}]] but no such note`);
    }
    if (n.status === "active" && !n.meta["review"]) add("warn", s, "no review date");
    if (n.status === "active" && n.links.length === 0 && !inc.get(s)) add("info", s, "no links in or out");
  }

  const order: Record<Level, number> = { error: 0, warn: 1, info: 2 };
  issues.sort((x, y) => order[x.level] - order[y.level] || cmp(x.note, y.note)); // stable
  const counts = { error: 0, warn: 0, info: 0 };
  for (const i of issues) counts[i.level]++;
  const text = issues.map((i) => `${padEnd(i.level, 5)} ${i.note ? i.note + ": " : ""}${i.message}`);
  text.push(`${notes.size} notes, ${counts.error} errors, ${counts.warn} warnings, ${counts.info} info`);
  emit(a, { notes: notes.size, counts, issues }, text.join("\n"));
  return counts.error ? 1 : 0;
}
