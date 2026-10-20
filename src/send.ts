// publish send, dry run: check the account, read the records already in its
// repo, match them against the plan, and say what a send would create, update
// or leave unchanged. Every request is a GET through one injected transport.
// Nothing here reads a secret or writes anything, locally or remotely.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { hostProblem, urlKey } from "./publish.ts";
import type { Plan } from "./publish.ts";
import { die } from "./util.ts";

export const CARD = "network.cosmik.card";
export const CONNECTION = "network.cosmik.connection";
export const COLLECTION = "network.cosmik.collection";
export const COLLECTION_LINK = "network.cosmik.collectionLink";
/** The only collections anote reads (and, later, writes). In write order. */
export const COLLECTIONS = [CARD, CONNECTION, COLLECTION, COLLECTION_LINK] as const;
export type CollectionName = (typeof COLLECTIONS)[number];

/** Most writes (create plus update) in one run. `--max` can lower it, never raise it. */
export const CAP = 50;
/** Most records anote will read from one collection before refusing. */
export const MAX_REMOTE = 1000;
const PAGE = 100;
/** Where did:plc documents are resolved. */
export const PLC_DIRECTORY = "https://plc.directory";
/** Record fields set at write time. They are left out of comparisons and the hash. */
const TIMESTAMPS = new Set(["createdAt", "updatedAt", "addedAt"]);

export type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
export type JsonObject = { [k: string]: Json };

// ------------------------------------------------------------------ config

export interface Account {
  handle: string;
  did: string;
  pds: string;
}

const CONFIG_KEYS = ["handle", "did", "pds"] as const;
const SECRET_NAME = /pass|secret|token|key/i;
const HANDLE = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$/;
const PLC_DID = /^did:plc:[a-z2-7]{24}$/;

/** $ANOTE_PUBLISH_CONFIG, else ~/.config/anote/publish.json. */
export function configPath(): string {
  return process.env["ANOTE_PUBLISH_CONFIG"] || path.join(os.homedir(), ".config", "anote", "publish.json");
}

function pdsOrigin(raw: string): string {
  const bad = (what: string): never => die(2, `publish config: pds ${what}`);
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return bad("must be an https address like https://pds.example.com");
  }
  if (u.protocol !== "https:") bad("must use https");
  if (u.username || u.password) bad("must not carry a user name or password");
  if (u.port) bad("must not name a port");
  if (u.pathname !== "/" || u.search || u.hash || /[?#]/.test(raw)) bad("must be the server address only, with no path, query or fragment");
  const p = hostProblem(u.hostname);
  if (p) bad(`points at ${p}`);
  if (!u.hostname.includes(".")) bad("must be a public host name");
  return u.origin;
}

/** Read and check the publish config. Every problem is exit 2 with one line naming the field. */
export function readConfig(file: string): Account {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      die(2, `no publish config at ${file}; create it with exactly the keys handle, did and pds (no secrets)`);
    }
    die(2, `cannot read publish config ${file}: ${(e as NodeJS.ErrnoException).code ?? "error"}`);
  }
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    die(2, `publish config ${file} is not valid JSON`);
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    die(2, `publish config ${file} must be a JSON object with handle, did and pds`);
  }
  const obj = data as Record<string, unknown>;
  for (const k of Object.keys(obj)) {
    if (SECRET_NAME.test(k)) die(2, `publish config: key '${k}': secrets never go in this file; see Credential`);
  }
  for (const k of Object.keys(obj)) {
    if (!(CONFIG_KEYS as readonly string[]).includes(k)) {
      die(2, `publish config: unknown key '${k}'; the file holds exactly handle, did and pds`);
    }
  }
  for (const k of CONFIG_KEYS) {
    if (!Object.hasOwn(obj, k)) die(2, `publish config: ${k} is missing`);
    if (typeof obj[k] !== "string") die(2, `publish config: ${k} must be a string`);
  }
  const handle = (obj["handle"] as string).toLowerCase();
  if (!HANDLE.test(handle)) die(2, "publish config: handle must be a domain name like alice.example.com");
  const hp = hostProblem(handle);
  if (hp) die(2, `publish config: handle points at ${hp}`);
  const did = obj["did"] as string;
  if (did.startsWith("did:web:")) die(2, "publish config: did: did:web is not supported; use the account's did:plc");
  if (!PLC_DID.test(did)) die(2, "publish config: did must be a did:plc identifier (did:plc: and 24 characters)");
  return { handle, did, pds: pdsOrigin(obj["pds"] as string) };
}

// --------------------------------------------------------------- transport

export interface HttpRequest {
  method: "GET";
  url: string;
}
export interface HttpResponse {
  status: number;
  body: string;
  /** Lower-case header names. */
  headers: Record<string, string>;
}
/** The one way anote talks to the network. Tests pass a fake. */
export type Transport = (req: HttpRequest) => Promise<HttpResponse>;

/** The real transport: fetch, no redirects, 15 second timeout. */
export const fetchTransport: Transport = async (req) => {
  const r = await fetch(req.url, { method: req.method, redirect: "error", signal: AbortSignal.timeout(15_000) });
  const headers: Record<string, string> = {};
  r.headers.forEach((v, k) => {
    headers[k] = v;
  });
  return { status: r.status, body: await r.text(), headers };
};

/** scheme, host and path of a url, without the query. */
function endpoint(url: string): string {
  const u = new URL(url);
  return u.origin + u.pathname;
}

/** The server's error code from an XRPC error body, if it is a plain word. */
function serverCode(r: HttpResponse): string {
  try {
    const e = (JSON.parse(r.body) as { error?: unknown }).error;
    return typeof e === "string" && /^[A-Za-z0-9]{1,64}$/.test(e) ? ` ${e}` : "";
  } catch {
    return "";
  }
}

function httpFailure(what: string, url: string, r: HttpResponse): never {
  const reset = r.status === 429 && /^\d{1,12}$/.test(r.headers["ratelimit-reset"] ?? "")
    ? ` (rate limit resets at ${new Date(Number(r.headers["ratelimit-reset"]) * 1000).toISOString()})`
    : "";
  die(1, `${what}: GET ${endpoint(url)}: HTTP ${r.status}${serverCode(r)}${reset}`);
}

/** GET with one retry on a network error, a timeout or a 5xx; never on a 4xx. */
async function get(t: Transport, url: string, what: string): Promise<HttpResponse> {
  for (let attempt = 1; ; attempt++) {
    let r: HttpResponse | null = null;
    try {
      r = await t({ method: "GET", url });
    } catch {
      r = null;
    }
    if (r && r.status < 500) return r;
    if (attempt === 2) {
      if (r) httpFailure(what, url, r);
      die(1, `${what}: GET ${endpoint(url)}: network error or timeout`);
    }
  }
}

function parseJson(r: HttpResponse, what: string): unknown {
  try {
    return JSON.parse(r.body);
  } catch {
    return die(1, `${what}: malformed server response`);
  }
}

// ----------------------------------------------------------------- account

/** A DID from the network, shown only if it looks like one. */
function shownDid(s: string): string {
  return /^did:[a-z]{1,16}:[A-Za-z0-9._:%-]{1,200}$/.test(s) ? s : "something that is not a DID";
}

/**
 * W5, the read half: the handle's .well-known/atproto-did must name the config
 * did, and the DID document must name the config pds. Runs before any listRecords.
 */
export async function checkAccount(t: Transport, acct: Account): Promise<void> {
  const wk = `https://${acct.handle}/.well-known/atproto-did`;
  const h = await get(t, wk, "handle");
  if (h.status === 429) httpFailure("handle", wk, h);
  if (h.status !== 200) die(2, `handle: ${acct.handle} does not resolve (GET ${wk}: HTTP ${h.status})`);
  const did = h.body.trim();
  if (did !== acct.did) die(2, `handle: ${acct.handle} resolves to ${shownDid(did)}, not the config did ${acct.did}`);

  const docUrl = `${PLC_DIRECTORY}/${acct.did}`;
  const d = await get(t, docUrl, "did");
  if (d.status === 404) die(2, `did: ${acct.did} is not in the PLC directory`);
  if (d.status !== 200) httpFailure("did", docUrl, d);
  const doc = parseJson(d, "did") as { id?: unknown; service?: unknown };
  if (typeof doc !== "object" || doc === null || doc.id !== acct.did) die(1, "did: malformed DID document");
  const services = Array.isArray(doc.service) ? (doc.service as Array<Record<string, unknown>>) : [];
  const svc = services.find((s) => typeof s === "object" && s !== null &&
    (s["id"] === "#atproto_pds" || s["id"] === `${acct.did}#atproto_pds`) && s["type"] === "AtprotoPersonalDataServer");
  const ep = svc?.["serviceEndpoint"];
  if (typeof ep !== "string") die(2, "pds: the DID document names no PDS");
  let named: string;
  try {
    named = new URL(ep).href;
  } catch {
    return die(2, "pds: the DID document names a PDS that is not a valid URL");
  }
  if (named !== new URL(acct.pds).href) die(2, `pds: the DID document names ${named.slice(0, 200)} as the PDS, not ${acct.pds}`);
}

// ---------------------------------------------------------------- records

export interface RemoteRecord {
  uri: string;
  cid: string;
  rkey: string;
  collection: CollectionName;
  value: JsonObject;
}

const RKEY = /^[A-Za-z0-9._:~-]{1,512}$/;

/** Every record in one collection of the account's own repo (paged; refuses over MAX_REMOTE). */
export async function listAll(t: Transport, acct: Account, collection: CollectionName): Promise<RemoteRecord[]> {
  const out: RemoteRecord[] = [];
  const prefix = `at://${acct.did}/${collection}/`;
  const what = `listRecords ${collection}`;
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const q = new URLSearchParams({ repo: acct.did, collection, limit: String(PAGE) });
    if (cursor !== undefined) q.set("cursor", cursor);
    const url = `${acct.pds}/xrpc/com.atproto.repo.listRecords?${q}`;
    const r = await get(t, url, what);
    if (r.status !== 200) httpFailure(what, url, r);
    const page = parseJson(r, what) as { records?: unknown; cursor?: unknown };
    if (typeof page !== "object" || page === null || !Array.isArray(page.records)) die(1, `${what}: malformed server response`);
    for (const rec of page.records as Array<Record<string, unknown>>) {
      const uri = rec?.["uri"];
      const cid = rec?.["cid"];
      const value = rec?.["value"];
      if (typeof uri !== "string" || !uri.startsWith(prefix) || !RKEY.test(uri.slice(prefix.length)) ||
          typeof cid !== "string" || cid === "" || typeof value !== "object" || value === null || Array.isArray(value)) {
        die(1, `${what}: malformed server response`);
      }
      out.push({ uri, cid, rkey: uri.slice(prefix.length), collection, value: value as JsonObject });
    }
    if (out.length > MAX_REMOTE) {
      die(2, `${collection}: more than ${MAX_REMOTE} records in the repo; anote refuses to plan against a repo this large`);
    }
    const next = page.cursor;
    if (typeof next !== "string" || next === "" || page.records.length === 0) break;
    if (seen.has(next)) die(1, `${what}: malformed server response (cursor repeats)`);
    seen.add(next);
    cursor = next;
  }
  return out;
}

// -------------------------------------------------------------- matching

export type Action = "create" | "update" | "unchanged";

/** A strong ref. Null parts are not known until the record they point to is written. */
export interface Ref {
  uri: string | null;
  cid: string | null;
}

export interface Planned {
  collection: CollectionName;
  action: Action;
  /** The remote record this updates or leaves unchanged; null for a create. */
  uri: string | null;
  /** What makes two records the same record (see the spec's identity rules). */
  identity: Record<string, string | null>;
  /** The record value without timestamps (they are set at write time). */
  value: JsonObject;
  /** True when the update is only because a record it points to is created or updated. */
  cascade: boolean;
}

export interface LeftAlone {
  collection: CollectionName;
  uri: string;
  what: string;
}

/** JSON with keys sorted at every level: the same value always gives the same text. */
export function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

function withoutTimestamps(v: JsonObject): JsonObject {
  return Object.fromEntries(Object.entries(v).filter(([k]) => !TIMESTAMPS.has(k)));
}

/** A copy with the cid of each named strong ref removed, to tell a cascade from a content change. */
function withoutRefCids(v: JsonObject, refs: string[]): JsonObject {
  const out: JsonObject = { ...v };
  for (const k of refs) {
    const r = out[k];
    if (r && typeof r === "object" && !Array.isArray(r)) out[k] = { ...r, cid: null };
  }
  return out;
}

const str = (v: Json | undefined): string | null => (typeof v === "string" ? v : null);
const obj = (v: Json | undefined): JsonObject | null => (v && typeof v === "object" && !Array.isArray(v) ? v : null);

/** The identity key of a remote record, or null when anote would never produce it. */
function remoteKey(r: RemoteRecord): string | null {
  const v = r.value;
  if (r.collection === CARD) {
    if (v["type"] === "URL") {
      const url = str(obj(v["content"])?.["url"]);
      return url === null ? null : JSON.stringify(["URL", urlKey(url)]);
    }
    if (v["type"] === "NOTE") {
      const parent = str(obj(v["parentCard"])?.["uri"]);
      return parent === null ? null : JSON.stringify(["NOTE", parent]);
    }
    return null;
  }
  if (r.collection === CONNECTION) {
    const s = str(v["source"]);
    const t = str(v["target"]);
    return s === null || t === null ? null : JSON.stringify([urlKey(s), urlKey(t), str(v["connectionType"]) ?? ""]);
  }
  if (r.collection === COLLECTION) {
    const n = str(v["name"]);
    return n === null ? null : JSON.stringify([n]);
  }
  const c = str(obj(v["collection"])?.["uri"]);
  const d = str(obj(v["card"])?.["uri"]);
  return c === null || d === null ? null : JSON.stringify([c, d]);
}

/** Text from the network, safe to print: control characters out, at most 200 characters. */
function shown(s: string): string {
  const t = s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ");
  return t.length > 200 ? t.slice(0, 200) + "..." : t;
}

function describeRemote(r: RemoteRecord): string {
  return shown(describeRaw(r));
}

function describeRaw(r: RemoteRecord): string {
  const v = r.value;
  if (r.collection === CARD) {
    const url = str(obj(v["content"])?.["url"]) ?? str(v["url"]) ?? "";
    return v["type"] === "NOTE" ? `card NOTE on ${url}` : `card ${str(v["type"]) ?? "?"} ${url}`;
  }
  if (r.collection === CONNECTION) return `connection ${str(v["source"]) ?? "?"} -> ${str(v["target"]) ?? "?"} ${str(v["connectionType"]) ?? ""}`.trimEnd();
  if (r.collection === COLLECTION) return `collection "${str(v["name"]) ?? "?"}"`;
  return "collection link";
}

export interface Matched {
  records: Planned[];
  left_alone: LeftAlone[];
}

/**
 * Match the plan against the remote records by identity, in write order (URL
 * cards, NOTE cards, connections, collections, collection links). A record
 * that points at a record being created or updated is itself an update (its
 * strong ref cid changes), or a create when that target is new.
 */
export function matchPlan(plan: Plan, remote: RemoteRecord[], did: string): Matched {
  const index = new Map<string, RemoteRecord[]>();
  for (const r of remote) {
    const k = remoteKey(r);
    if (k === null) continue;
    const full = `${r.collection} ${k}`;
    index.set(full, [...(index.get(full) ?? []), r]);
  }
  const used = new Set<string>();
  const plannedKeys = new Set<string>();
  const records: Planned[] = [];

  const place = (collection: CollectionName, key: string | null, identity: Record<string, string | null>, value: JsonObject, refs: string[]): Planned => {
    let found: RemoteRecord | null = null;
    if (key !== null) {
      const full = `${collection} ${key}`;
      if (plannedKeys.has(full)) die(2, `two planned ${collection} records have the same identity (${Object.values(identity).filter((x) => x !== null).join(", ")})`);
      plannedKeys.add(full);
      const hits = index.get(full) ?? [];
      if (hits.length > 1) {
        die(2, `two records in the repo have one identity, ${hits[0]?.uri} and ${hits[1]?.uri}; anote does not pick one`);
      }
      found = hits[0] ?? null;
    }
    let action: Action = "create";
    let cascade = false;
    if (found) {
      used.add(found.uri);
      const remoteValue = withoutTimestamps(found.value);
      if (canonical(remoteValue) === canonical(value)) action = "unchanged";
      else {
        action = "update";
        cascade = canonical(withoutRefCids(remoteValue, refs)) === canonical(withoutRefCids(value, refs));
      }
    }
    const p: Planned = { collection, action, uri: found?.uri ?? null, identity, value, cascade };
    records.push(p);
    return p;
  };
  /** The strong ref a later record uses to point at `p`. */
  const refOf = (p: Planned): Ref => {
    const hit = p.uri === null ? null : remote.find((r) => r.uri === p.uri) ?? null;
    return { uri: p.uri, cid: p.action === "unchanged" && hit ? hit.cid : null };
  };

  const urlCards = new Map<string, Ref>();
  for (const c of plan.cards) {
    if (c.type !== "URL") continue;
    const value: JsonObject = {
      $type: CARD,
      type: "URL",
      content: { $type: `${CARD}#urlContent`, url: c.url, metadata: { $type: `${CARD}#urlMetadata`, title: c.metadata.title } },
    };
    const p = place(CARD, JSON.stringify(["URL", urlKey(c.url)]), { url: c.url }, value, []);
    urlCards.set(urlKey(c.url), refOf(p));
  }
  for (const c of plan.cards) {
    if (c.type !== "NOTE") continue;
    const parent = urlCards.get(urlKey(c.parentCard.url)) as Ref;
    const value: JsonObject = {
      $type: CARD,
      type: "NOTE",
      content: { $type: `${CARD}#noteContent`, text: c.text },
      url: c.parentCard.url,
      parentCard: { uri: parent.uri, cid: parent.cid },
    };
    const key = parent.uri === null ? null : JSON.stringify(["NOTE", parent.uri]);
    place(CARD, key, { parentCard: parent.uri, url: c.parentCard.url }, value, ["parentCard"]);
  }
  for (const c of plan.connections) {
    const value: JsonObject = { $type: CONNECTION, source: c.source, target: c.target, connectionType: c.connectionType };
    if (c.note !== undefined) value["note"] = c.note;
    const key = JSON.stringify([urlKey(c.source), urlKey(c.target), c.connectionType]);
    place(CONNECTION, key, { source: c.source, target: c.target, connectionType: c.connectionType }, value, []);
  }
  const links: Array<{ collection: Ref; name: string; card: Ref; url: string }> = [];
  for (const c of plan.collections) {
    const value: JsonObject = { $type: COLLECTION, name: c.name };
    if (c.description !== undefined) value["description"] = c.description;
    value["accessType"] = c.accessType;
    value["collaborators"] = [];
    const p = place(COLLECTION, JSON.stringify([c.name]), { name: c.name }, value, []);
    for (const m of c.memberships) links.push({ collection: refOf(p), name: c.name, card: urlCards.get(urlKey(m.card)) as Ref, url: m.card });
  }
  for (const l of links) {
    const value: JsonObject = {
      $type: COLLECTION_LINK,
      collection: { uri: l.collection.uri, cid: l.collection.cid },
      card: { uri: l.card.uri, cid: l.card.cid },
      addedBy: did,
    };
    const key = l.collection.uri === null || l.card.uri === null ? null : JSON.stringify([l.collection.uri, l.card.uri]);
    place(COLLECTION_LINK, key, { collection: l.collection.uri, card: l.card.uri, collectionName: l.name, cardUrl: l.url }, value, ["collection", "card"]);
  }
  const left_alone = remote.filter((r) => !used.has(r.uri)).map((r) => ({ collection: r.collection, uri: r.uri, what: describeRemote(r) }));
  return { records, left_alone };
}

// -------------------------------------------------------------------- hash

/**
 * The confirmation hash: the first 12 hex of sha256 over the canonical JSON of
 * the ordered planned writes (collection, action, rkey or "new", identity, full
 * value without timestamps), the config did and the graph path. Any change in
 * graph text, remote state, account or graph gives a different hash.
 */
export function confirmationHash(records: Planned[], did: string, graph: string): string {
  const writes = records.filter((r) => r.action !== "unchanged").map((r) => ({
    collection: r.collection,
    action: r.action,
    rkey: r.uri === null ? "new" : r.uri.slice(r.uri.lastIndexOf("/") + 1),
    identity: r.identity,
    value: r.value,
  }));
  return createHash("sha256").update(canonical({ did, graph, writes })).digest("hex").slice(0, 12);
}
