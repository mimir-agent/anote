// The note file format: a `---` block of `key: value` lines, an optional
// `links:` list, then a markdown body. Hand-written on purpose: this is not
// full YAML, and it must round-trip exactly like the original.
import { META_ORDER, typeWords } from "./schema.ts";
import { Fail, cmp, strip, stripNewlines } from "./util.ts";

export interface Link {
  type: string;
  to: string;
  note: string;
}

/** Frontmatter fields. All values are plain strings. */
export type Meta = Record<string, string>;

export class Note {
  slug: string;
  meta: Meta;
  body: string;
  links: Link[];

  constructor(slug: string, meta: Meta, body: string, links: Link[]) {
    this.slug = slug;
    this.meta = meta;
    this.body = body;
    this.links = links;
  }

  get title(): string {
    return this.meta["title"] || this.slug;
  }

  get tags(): string[] {
    return (this.meta["tags"] ?? "")
      .split(",")
      .map((t) => strip(t))
      .filter((t) => t !== "");
  }

  get status(): string {
    return this.meta["status"] ?? "active";
  }

  /** First word of the type line as checkType reads it (no '#', lowercase), or "". */
  get kind(): string {
    return typeWords(this.meta["type"] ?? "")[0] ?? "";
  }
}

const FRONTMATTER = /^---\n([\s\S]*?)\n---[ \t]*\n?([\s\S]*)$/;
const LINK_LINE = /^\s*-\s+([a-z][a-z-]*)\s+\[\[([^\]]+)\]\](?:\s*\|\s*([^\n]*))?$/;

/** A fresh, empty meta object (no inherited keys like "constructor"). */
export function newMeta(): Meta {
  return Object.create(null) as Meta;
}

export function parse(text: string, slug: string): Note {
  const m = FRONTMATTER.exec(text);
  if (!m) throw new Fail(1, `${slug}.md: no frontmatter block`);
  const meta = newMeta();
  const links: Link[] = [];
  let inLinks = false;
  for (const raw of (m[1] as string).split("\n")) {
    if (strip(raw) === "") continue;
    if (strip(raw) === "links:") {
      inLinks = true;
      continue;
    }
    const lm = LINK_LINE.exec(raw);
    if (inLinks && lm) {
      links.push({ type: lm[1] as string, to: strip(lm[2] as string), note: strip(lm[3] ?? "") });
      continue;
    }
    const i = raw.indexOf(":");
    if (i < 0) throw new Fail(1, `${slug}.md: cannot read line '${raw}'`);
    meta[strip(raw.slice(0, i))] = strip(raw.slice(i + 1));
    inLinks = false;
  }
  return new Note(slug, meta, stripNewlines(m[2] as string), links);
}

export function dump(n: Note): string {
  const lines = ["---"];
  for (const k of META_ORDER) {
    const v = n.meta[k];
    if (v) lines.push(`${k}: ${v}`);
  }
  const extra = Object.keys(n.meta).filter((k) => !META_ORDER.includes(k)).sort(cmp);
  for (const k of extra) lines.push(`${k}: ${n.meta[k]}`);
  if (n.links.length > 0) {
    lines.push("links:");
    for (const l of n.links) {
      let row = `  - ${l.type} [[${l.to}]]`;
      if (l.note) row += " | " + l.note;
      lines.push(row);
    }
  }
  lines.push("---");
  let out = lines.join("\n") + "\n";
  if (strip(n.body) !== "") out += "\n" + stripNewlines(n.body) + "\n";
  return out;
}
