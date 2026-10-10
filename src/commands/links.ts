// link, unlink and neighbors.
import type { Args } from "../args.ts";
import { normType } from "../schema.ts";
import { getNote, graphDir, incoming, loadAll, resolve, save, touch } from "../store.ts";
import { clean, die, padEnd, print } from "../util.ts";
import { emit } from "./types.ts";

export function cmdLink(a: Args): void {
  const g = graphDir(a.str("graph"));
  const notes = loadAll(g);
  const src = resolve(notes, a.need("src"));
  const dst = resolve(notes, a.need("dst"));
  const t = normType(a.need("type"));
  if (src === dst) die(2, "a note cannot link to itself");
  const n = getNote(notes, src);
  if (n.links.some((l) => l.to === dst && l.type === t)) {
    print(`already linked: ${src} ${t} ${dst}`);
    return;
  }
  n.links.push({ type: t, to: dst, note: clean(a.str("note") ?? "") });
  touch(n);
  save(g, n);
  print(`${src} --${t}--> ${dst}`);
}

export function cmdUnlink(a: Args): void {
  const g = graphDir(a.str("graph"));
  const notes = loadAll(g);
  const src = resolve(notes, a.need("src"));
  const dst = resolve(notes, a.need("dst"));
  const typeFlag = a.str("type");
  const t = typeFlag ? normType(typeFlag) : null;
  const n = getNote(notes, src);
  const keep = n.links.filter((l) => !(l.to === dst && (t === null || l.type === t)));
  const removed = n.links.length - keep.length;
  if (!removed) die(3, `no link from ${src} to ${dst}`);
  n.links = keep;
  touch(n);
  save(g, n);
  print(`removed ${removed} link(s) from ${src} to ${dst}`);
}

interface Edge {
  from: string;
  dir: "out" | "in";
  type: string;
  other: string;
  depth: number;
}

export function cmdNeighbors(a: Args): void {
  const g = graphDir(a.str("graph"));
  const notes = loadAll(g);
  const s = resolve(notes, a.need("note"));
  const inc = incoming(notes);
  const typeFlag = a.str("type");
  const tf = typeFlag ? normType(typeFlag) : null;
  const maxDepth = a.num("depth");
  const edges: Edge[] = [];
  const lines = [`${s}  "${getNote(notes, s).title}"`];
  const seen = new Set([s]);

  const walk = (cur: string, depth: number): void => {
    if (depth > maxDepth) return;
    const found: Array<{ dir: "out" | "in"; type: string; other: string; note: string }> = [];
    for (const l of getNote(notes, cur).links) {
      if (notes.has(l.to) && (tf === null || l.type === tf)) {
        found.push({ dir: "out", type: l.type, other: l.to, note: l.note });
      }
    }
    for (const i of inc.get(cur) ?? []) {
      if (tf === null || i.type === tf) found.push({ dir: "in", type: i.type, other: i.from, note: i.note });
    }
    for (const f of found) {
      edges.push({ from: cur, dir: f.dir, type: f.type, other: f.other, depth });
      lines.push(
        `${"  ".repeat(depth)}${f.dir === "out" ? "->" : "<-"} ${padEnd(f.type, 18)} ${f.other}  ` +
          `"${getNote(notes, f.other).title}"${f.note ? "  | " + f.note : ""}`,
      );
      if (!seen.has(f.other)) {
        seen.add(f.other);
        walk(f.other, depth + 1);
      }
    }
  };

  walk(s, 1);
  if (lines.length === 1) lines.push("  (no links)");
  emit(a, edges.map((e) => ({ from: e.from, dir: e.dir, type: e.type, other: e.other, depth: e.depth })), lines.join("\n"));
}
