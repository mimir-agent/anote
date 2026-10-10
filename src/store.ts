// Reading and writing the graph directory, and finding notes by reference.
import * as fs from "node:fs";
import * as path from "node:path";
import { Note, dump, parse } from "./frontmatter.ts";
import type { Link } from "./frontmatter.ts";
import { Fail, clean, cmp, die, expandPath, readText, slugify, today, isoDate, writeText } from "./util.ts";

export type Notes = Map<string, Note>;

/** Where the graph lives: --graph, else $ANOTE_GRAPH, else ~/.hermes/graph. */
export function graphDir(flag: string | undefined): string {
  const raw = flag || process.env["ANOTE_GRAPH"] || "~/.hermes/graph";
  return expandPath(raw);
}

function isDir(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/** Names of the `*.md` files in a directory, sorted. */
export function mdFiles(dir: string): string[] {
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md") && isDir(path.join(dir, f)) === false)
    .sort(cmp);
}

/**
 * Load every note. With `errors`, unreadable files are reported there instead
 * of aborting (used by `check`).
 */
export function loadAll(g: string, errors?: string[]): Notes {
  const d = path.join(g, "notes");
  const notes: Notes = new Map();
  if (!isDir(d)) return notes;
  for (const f of mdFiles(d)) {
    if (f.startsWith(".")) continue;
    const slug = f.slice(0, -3);
    try {
      notes.set(slug, parse(readText(path.join(d, f)), slug));
    } catch (e) {
      if (!(e instanceof Fail) || !errors) throw e;
      errors.push(e.message);
    }
  }
  return notes;
}

export function save(g: string, n: Note): void {
  writeText(path.join(g, "notes", n.slug + ".md"), dump(n));
}

/** Turn a slug, title or unique slug prefix into a slug. Exit 3 if none or several. */
export function resolve(notes: Notes, refRaw: string): string {
  const ref = refRaw.trim();
  if (notes.has(ref)) return ref;
  const low = clean(ref).toLowerCase();
  const byTitle = [...notes].filter(([, n]) => clean(n.title).toLowerCase() === low).map(([s]) => s);
  if (byTitle.length === 1) return byTitle[0] as string;
  const slugged = slugify(ref);
  if (notes.has(slugged)) return slugged;
  const prefix = [...notes.keys()].filter((s) => slugged !== "" && s.startsWith(slugged));
  if (prefix.length === 1) return prefix[0] as string;
  const cands = [...new Set([...byTitle, ...prefix])].sort(cmp);
  if (cands.length > 0) die(3, `'${ref}' is ambiguous: ${cands.slice(0, 8).join(", ")}`);
  die(3, `no note matches '${ref}'`);
}

export function getNote(notes: Notes, slug: string): Note {
  const n = notes.get(slug);
  if (!n) throw new Error(`internal: note ${slug} missing`);
  return n;
}

export interface Incoming {
  from: string;
  type: string;
  note: string;
}

/** Map from slug to the links that point at it, in file order. */
export function incoming(notes: Notes): Map<string, Incoming[]> {
  const inc = new Map<string, Incoming[]>();
  for (const [s, n] of notes) {
    for (const l of n.links) {
      if (notes.has(l.to)) {
        const list = inc.get(l.to) ?? [];
        list.push({ from: s, type: l.type, note: l.note });
        inc.set(l.to, list);
      }
    }
  }
  return inc;
}

export function touch(n: Note): void {
  n.meta["updated"] = isoDate(today());
}

export type { Link };
