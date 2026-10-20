// Publishing, local part only: which notes are marked, the content hash, the
// url rules, and the plan of records a later export would write (the mapping
// in the publish spec). Nothing here opens a connection or writes a file.
import { createHash } from "node:crypto";
import type { Note } from "./frontmatter.ts";
import type { Notes } from "./store.ts";
import { checkType } from "./schema.ts";
import { Fail, cmp, slugify } from "./util.ts";

function getNoteOrNull(notes: Notes, slug: string): Note | null {
  return notes.get(slug) ?? null;
}

/** The only value of `published` that publishes (G1). Anything else is private. */
export const MARKED = "yes";

/** Size limits from the record schemas, in UTF-8 bytes (how AT Protocol counts maxLength). */
export const MAX_BODY = 10000;
export const MAX_LINK_NOTE = 1000;
export const MAX_HUB_TITLE = 100;
export const MAX_HUB_DESCRIPTION = 500;

/** anote link type -> connection type. expands-on has no match and is sent as RELATED with a prefix. */
export const CONNECTION_TYPES: Record<string, string> = {
  "expands-on": "RELATED",
  explains: "EXPLAINER",
  supports: "SUPPORTS",
  opposes: "OPPOSES",
  relates: "RELATED",
  addresses: "ADDRESSES",
  "helpful-background": "HELPFUL",
  "leads-to": "LEADS_TO",
  supplemental: "SUPPLEMENT",
  duplicates: "SAME_AS",
  references: "REFERENCES",
};

/** Link types whose meaning is lost in the mapping; the link note starts with "[type] ". */
const LOSSY = new Set(["expands-on"]);

export function isMarked(n: Note): boolean {
  return n.meta["published"] === MARKED;
}

/** Hash of what a published note sends: title, body, url and its links (with their notes). */
export function contentHash(n: Note): string {
  const parts = [n.meta["title"] ?? "", n.body, n.meta["url"] ?? "", n.links.map((l) => [l.type, l.to, l.note])];
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/**
 * Why a note's type line fails checkType, or null when it passes. A note whose
 * type does not check is never exported (G8 fails closed): a variant like
 * `people` must not slip past the person rule.
 */
export function typeProblem(n: Note): string | null {
  try {
    checkType(n.meta["type"] ?? "");
    return null;
  } catch (e) {
    if (e instanceof Fail) return e.message;
    throw e;
  }
}

export function hashDrifted(n: Note): boolean {
  return n.meta["published_hash"] !== contentHash(n);
}

export function bytes(s: string): number {
  return Buffer.byteLength(s, "utf8");
}

/** The first `max` UTF-8 bytes of `s`, never splitting a character. */
export function cutBytes(s: string, max: number): string {
  let out = "";
  let used = 0;
  for (const ch of s) {
    const b = bytes(ch);
    if (used + b > max) break;
    out += ch;
    used += b;
  }
  return out;
}

/** An absolute http or https URL with no whitespace, or null. Used when a url is stored. */
export function parseWebUrl(raw: string): URL | null {
  if (/\s/.test(raw)) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  return u.protocol === "http:" || u.protocol === "https:" ? u : null;
}

function privateV4(a: number, b: number): boolean {
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
}

/** Why a host is not public (G9), or null. `host` is URL.hostname. */
export function hostProblem(hostRaw: string): string | null {
  const host = hostRaw.replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost")) return "localhost";
  if (host.endsWith(".local")) return "a .local name";
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(host);
  if (v4 && privateV4(Number(v4[1]), Number(v4[2]))) return "a private or loopback IP";
  if (host.startsWith("[")) {
    const h = host.slice(1, -1);
    if (h === "::1" || h === "::") return "a private or loopback IP";
    const first = parseInt(h.split(":")[0] || "0", 16);
    if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80) return "a private or loopback IP";
    const mapped = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(h);
    if (mapped) {
      const hi = parseInt(mapped[1] as string, 16);
      if (privateV4(hi >> 8, hi & 0xff)) return "a private or loopback IP";
    }
  }
  return null;
}

/**
 * Characters that can hide or reorder text on a terminal: C0 controls other
 * than tab and newline, DEL, C1 controls, the line and paragraph separators,
 * and the bidi embedding, override and isolate controls. A dry run that shows
 * them raw can show different text from what is sent, so a published title,
 * body, url or link note may not carry them (G10).
 */
const HIDING = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;

export function hasHidingChars(s: string): boolean {
  return HIDING.test(s);
}

/** Why a url cannot be published (G9), or null when it can. */
export function urlProblem(raw: string): string | null {
  const u = parseWebUrl(raw);
  if (!u) return "url must be an absolute http or https URL";
  if (u.username || u.password) return "url must not carry a user name or password";
  const host = hostProblem(u.hostname);
  if (host) return `url points at ${host}`;
  if (!u.hostname.startsWith("[") && !u.hostname.replace(/\.$/, "").includes(".")) return "url points at a single-label host";
  return null;
}

/** The form urls are compared in (one published note per url). */
export function urlKey(raw: string): string {
  return parseWebUrl(raw)?.href ?? raw;
}

/**
 * A [[mention]] for G5, including the [[slug|alias]], [[slug#heading]] and
 * [[slug#^block]] forms: the slug goes out in the text just the same. Wider
 * than schema's WIKILINK on purpose; `check` keeps that one for its
 * no-such-note warning on every graph.
 */
const MENTION = /\[\[([^\]|#^]+)(?:[#^][^\]|]*)?(?:\|[^\]]*)?\]\]/g;

/** Slugs of notes that `text` mentions as [[...]] and that exist but are not marked. */
export function unpublishedMentions(notes: Notes, text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(MENTION)) {
    const w = m[1] as string;
    const s = notes.has(slugify(w)) ? slugify(w) : notes.has(w.trim()) ? w.trim() : null;
    const t = s === null ? null : getNoteOrNull(notes, s);
    if (s !== null && t && !isMarked(t)) out.add(s);
  }
  return [...out].sort(cmp);
}

/** Marked, active, non-person notes: the ones the url uniqueness rule counts. */
function urlOwners(notes: Notes): Map<string, string[]> {
  const owners = new Map<string, string[]>();
  for (const [s, n] of notes) {
    const url = n.meta["url"];
    if (!isMarked(n) || n.status !== "active" || n.kind === "person" || n.kind === "hub" || !url) continue;
    const k = urlKey(url);
    owners.set(k, [...(owners.get(k) ?? []), s]);
  }
  return owners;
}

/** Other marked notes that already carry this url. */
export function urlTakenBy(notes: Notes, slug: string, url: string): string[] {
  return (urlOwners(notes).get(urlKey(url)) ?? []).filter((s) => s !== slug);
}

/** The text a link becomes as a connection note. */
export function connectionNote(type: string, note: string): string {
  return LOSSY.has(type) ? `[${type}] ${note}` : note;
}

// ------------------------------------------------------------------ plan

export interface UrlCard {
  type: "URL";
  url: string;
  metadata: { title: string };
}
export interface NoteCard {
  type: "NOTE";
  parentCard: { url: string };
  text: string;
}
export interface Connection {
  source: string;
  target: string;
  connectionType: string;
  note?: string;
}
export interface Collection {
  name: string;
  description?: string;
  accessType: "CLOSED";
  collaborators: [];
  memberships: Array<{ card: string }>;
}
export type LeftOut =
  | { kind: "note"; note: string; reason: string }
  | { kind: "link"; from: string; type: string; to: string; reason: string }
  | { kind: "log"; log: string; reason: string };

export interface Plan {
  cards: Array<UrlCard | NoteCard>;
  connections: Connection[];
  collections: Collection[];
  left_out: LeftOut[];
  notices: string[];
}

/** Why a note is not exported, or null when it is. Order decides which reason shows. */
function noteReason(notes: Notes, owners: Map<string, string[]>, s: string, n: Note): string | null {
  if (n.kind === "person") return "person";
  if (typeProblem(n) !== null) return "type does not check";
  if (n.status !== "active") return n.status;
  const url = n.meta["url"];
  if (!isMarked(n)) return n.kind !== "hub" && !url ? "no url" : "not marked";
  if (hashDrifted(n)) return "hash drift: changed since `anote publish mark`";
  if (n.kind === "hub") {
    if (bytes(n.title) > MAX_HUB_TITLE) return `hub title over ${MAX_HUB_TITLE}`;
  } else {
    if (!url) return "no url";
    const p = urlProblem(url);
    if (p) return p;
    const others = (owners.get(urlKey(url)) ?? []).filter((x) => x !== s);
    if (others.length > 0) return `duplicate url (also on ${others.join(", ")})`;
  }
  if (bytes(n.body) > MAX_BODY) return `body over ${MAX_BODY}`;
  if (hasHidingChars(n.title) || hasHidingChars(n.body) || hasHidingChars(url ?? "")) return "control or bidi characters";
  if (unpublishedMentions(notes, n.title).length > 0) return "title mentions an unpublished note";
  if (unpublishedMentions(notes, n.body).length > 0) return "body mentions an unpublished note";
  return null;
}

/** For every note: why it is not exported, or null when it is (the rules buildPlan applies). */
export function exportReasons(notes: Notes): Map<string, string | null> {
  const owners = urlOwners(notes);
  return new Map([...notes].map(([s, n]) => [s, noteReason(notes, owners, s, n)]));
}

/** Why a link from a non-hub note is not a connection, or null when it is. */
function linkReason(notes: Notes, out: Set<string>, s: string, to: string, type: string, note: string): string | null {
  const t = getNoteOrNull(notes, to);
  if (!t) return "target missing";
  if (t.kind === "hub") return "target is a hub (a hub has no card)";
  if (!isMarked(getNoteOrNull(notes, s) as Note)) return "unpublished source";
  if (!isMarked(t)) return "unpublished target";
  if (!out.has(s)) return "source left out";
  if (!out.has(to)) return "target left out";
  const text = connectionNote(type, note);
  if (bytes(text) > MAX_LINK_NOTE) return `link note over ${MAX_LINK_NOTE}`;
  if (hasHidingChars(text)) return "link note has control or bidi characters";
  if (unpublishedMentions(notes, text).length > 0) return "link note mentions an unpublished note";
  return null;
}

/** Build the records an export would write, and everything left out with its reason. */
export function buildPlan(notes: Notes, logs: string[]): Plan {
  const plan: Plan = { cards: [], connections: [], collections: [], left_out: [], notices: [] };
  const owners = urlOwners(notes);
  const slugs = [...notes.keys()].sort(cmp);
  const out = new Set<string>();
  for (const s of slugs) {
    const n = notes.get(s) as Note;
    const reason = noteReason(notes, owners, s, n);
    if (reason === null) out.add(s);
    else plan.left_out.push({ kind: "note", note: s, reason });
  }
  for (const s of slugs) {
    const n = notes.get(s) as Note;
    if (!out.has(s) || n.kind === "hub") continue;
    const url = n.meta["url"] as string;
    plan.cards.push({ type: "URL", url, metadata: { title: n.title } });
    if (n.body) plan.cards.push({ type: "NOTE", parentCard: { url }, text: n.body });
    else plan.notices.push(`${s} has no body, so it sends a URL card only`);
  }
  for (const s of slugs) {
    const n = notes.get(s) as Note;
    const hub = n.kind === "hub" && out.has(s);
    const collection: Collection | null = hub
      ? { name: n.title, accessType: "CLOSED", collaborators: [], memberships: [] }
      : null;
    for (const l of n.links) {
      const t = getNoteOrNull(notes, l.to);
      if (!isMarked(n) && !(t && isMarked(t))) continue; // nothing here can go out
      const leave = (reason: string) => plan.left_out.push({ kind: "link", from: s, type: l.type, to: l.to, reason });
      if (n.kind === "hub") {
        if (!collection) leave(isMarked(n) ? "source left out" : "unpublished source");
        else if (!t) leave("target missing");
        else if (t.kind === "hub") leave("target is a hub (a hub has no card)");
        else if (!isMarked(t)) leave("unpublished target");
        else if (!out.has(l.to)) leave("target left out");
        else collection.memberships.push({ card: t.meta["url"] as string });
        continue;
      }
      const reason = linkReason(notes, out, s, l.to, l.type, l.note);
      if (reason) {
        leave(reason);
        continue;
      }
      const c: Connection = {
        source: n.meta["url"] as string,
        target: (t as Note).meta["url"] as string,
        connectionType: CONNECTION_TYPES[l.type] as string,
      };
      const text = connectionNote(l.type, l.note);
      if (text) c.note = text;
      plan.connections.push(c);
    }
    if (collection) {
      if (n.body) collection.description = cutBytes(n.body, MAX_HUB_DESCRIPTION);
      if (bytes(n.body) > MAX_HUB_DESCRIPTION) plan.notices.push(`${s}: hub description cut to the first ${MAX_HUB_DESCRIPTION} bytes`);
      plan.collections.push(collection);
    }
  }
  if (plan.collections.length > 0) plan.notices.push("collections keep no hand order and no link types");
  for (const log of logs) plan.left_out.push({ kind: "log", log, reason: "log" });
  return plan;
}
