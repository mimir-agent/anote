// publish send --write: the only code that writes to a repo. It is called
// after the confirmation hash matched. In order: the last check (every record
// traces to a publishable note in the graph as it is now), the app password
// from the environment, one session, then one putRecord per record in write
// order, each appended to the write log after its response.
//
// Hard limits, each checked in code before a request is built:
//   - the only write method is com.atproto.repo.putRecord;
//   - only the four network.cosmik collections (W7);
//   - repo is always the config did, and the session did must equal it (W5);
//   - create and update only. There is no delete: no deleteRecord, no
//     applyWrites, no delete action (W8).
// The password and the session token live in this module's locals for one
// run. They are never stored, logged or printed, and any message leaving this
// module has them (and anything shaped like a JWT) cut out first.
import { createHash, randomInt } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { Note } from "./frontmatter.ts";
import {
  CONNECTION_TYPES, MAX_HUB_DESCRIPTION, MAX_LINK_NOTE, bytes, connectionNote, cutBytes, exportReasons, hasHidingChars, isMarked,
  unpublishedMentions, urlKey,
} from "./publish.ts";
import {
  CAP, CARD, COLLECTION, COLLECTION_LINK, COLLECTIONS, CONNECTION, canonical, endpoint, rateReset, serverCode,
} from "./send.ts";
import type { Account, CollectionName, HttpResponse, Json, JsonObject, Planned, Transport } from "./send.ts";
import type { Notes } from "./store.ts";
import { Fail, die } from "./util.ts";

/** The environment variable the app password is read from, and nothing else. */
export const SECRET_ENV = "ANOTE_PUBLISH_APP_PASSWORD";
const ALLOWED: ReadonlySet<string> = new Set(COLLECTIONS);
const PUT = "com.atproto.repo.putRecord";
const SESSION = "com.atproto.server.createSession";

// --------------------------------------------------------------- redaction

const JWT = /eyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g;

/** `s` with every secret and anything shaped like a JWT replaced. */
export function redact(s: string, secrets: string[]): string {
  let out = s;
  for (const x of secrets) if (x.length > 0) out = out.split(x).join("[redacted]");
  return out.replace(JWT, "[redacted]");
}

// ---------------------------------------------------------------- record keys

const B32 = "234567abcdefghijklmnopqrstuvwxyz";
let lastMicros = 0;
const clock = randomInt(1024);

/** A new record key in the TID format the lexicons declare: 53 bits of microseconds, 10 bits of clock id. */
export function newTid(now = Date.now()): string {
  let micros = now * 1000;
  if (micros <= lastMicros) micros = lastMicros + 1;
  lastMicros = micros;
  let n = (BigInt(micros) << 10n) | BigInt(clock);
  let out = "";
  for (let i = 0; i < 13; i++) {
    out = (B32[Number(n & 31n)] as string) + out;
    n >>= 5n;
  }
  return out;
}

// ---------------------------------------------------------------- write log

/** $XDG_STATE_HOME/anote/publish-log.jsonl, else ~/.local/state/anote/publish-log.jsonl. Outside every graph. */
export function writeLogPath(): string {
  const xdg = process.env["XDG_STATE_HOME"];
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(os.homedir(), ".local", "state");
  return path.join(base, "anote", "publish-log.jsonl");
}

export interface LogLine {
  time: string;
  did: string;
  collection: string;
  uri: string;
  cid: string | null;
  action: "created" | "updated" | "failed";
  status?: number;
  /** sha256 of the note slug, never the slug. */
  note: string;
}

/** Append one line, mode 600. Only the fields in LogLine are written. */
function appendLog(file: string, l: LogLine): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(file, "a", 0o600);
  try {
    fs.fchmodSync(fd, 0o600);
    const line: LogLine = {
      time: l.time, did: l.did, collection: l.collection, uri: l.uri, cid: l.cid, action: l.action,
      ...(l.status === undefined ? {} : { status: l.status }), note: l.note,
    };
    fs.writeSync(fd, JSON.stringify(line) + "\n");
  } finally {
    fs.closeSync(fd);
  }
}

const slugHash = (s: string) => createHash("sha256").update(s).digest("hex");

// ------------------------------------------------------------ the last check

/** A note that may be sent now: active, marked, not a person, passing G1 to G10. */
function publishable(n: Note | undefined, reasons: Map<string, string | null>, slug: string): n is Note {
  return n !== undefined && reasons.get(slug) === null && isMarked(n) && n.status === "active" && n.kind !== "person";
}

const o = (v: Json | undefined): JsonObject => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const s = (v: Json | undefined): string => (typeof v === "string" ? v : "");

/**
 * The write path's own last check, independent of the plan code: every record
 * must be exactly what a publishable note in the graph produces now. Returns
 * the slug each record comes from (for the write log). Any record that does
 * not trace stops the whole run before anything is sent.
 */
export function traceRecords(notes: Notes, records: Planned[], did: string): string[] {
  const reasons = exportReasons(notes);
  const pages = new Map<string, string>();
  const hubs = new Map<string, string>();
  for (const [slug, n] of notes) {
    if (!publishable(n, reasons, slug)) continue;
    if (n.kind === "hub") hubs.set(n.title, slug);
    else if (n.meta["url"]) pages.set(urlKey(n.meta["url"]), slug);
  }
  return records.map((r, i) => {
    const bad = (why: string): never =>
      die(2, `record ${i + 1} (${r.collection}) does not trace to a publishable note (${why}); nothing was sent`);
    if (!ALLOWED.has(r.collection)) bad("collection not allowed");
    if (r.action !== "create" && r.action !== "update" && r.action !== "unchanged") bad("unknown action");
    const v = r.value;
    const page = (url: string): [string, Note] => {
      const slug = pages.get(urlKey(url));
      return slug === undefined ? bad("no publishable note has this url") : [slug, notes.get(slug) as Note];
    };
    const ref = (field: string, want: (p: Planned) => boolean): Planned => {
      const j = r.refs[field];
      const p = j === undefined || j >= i ? undefined : records[j];
      if (!p || !want(p) || s(o(v[field])["uri"]) !== s(p.uri as Json)) bad(`${field} does not point at the record before it`);
      return p as Planned;
    };
    let expected: JsonObject;
    let from: string;
    if (r.collection === CARD && v["type"] === "URL") {
      const [slug, n] = page(s(o(v["content"])["url"]));
      from = slug;
      expected = {
        $type: CARD, type: "URL",
        content: { $type: `${CARD}#urlContent`, url: n.meta["url"] as string, metadata: { $type: `${CARD}#urlMetadata`, title: n.title } },
      };
    } else if (r.collection === CARD && v["type"] === "NOTE") {
      const [slug, n] = page(s(v["url"]));
      from = slug;
      ref("parentCard", (p) => p.collection === CARD && p.value["type"] === "URL" && urlKey(s(o(p.value["content"])["url"])) === urlKey(s(v["url"])));
      expected = {
        $type: CARD, type: "NOTE", content: { $type: `${CARD}#noteContent`, text: n.body }, url: n.meta["url"] as string,
        parentCard: v["parentCard"] as Json,
      };
    } else if (r.collection === CONNECTION) {
      const [src, sn] = page(s(v["source"]));
      const [dst, dn] = page(s(v["target"]));
      from = src;
      const link = sn.links.find((l) => l.to === dst && CONNECTION_TYPES[l.type] === v["connectionType"] &&
        connectionNote(l.type, l.note) === (typeof v["note"] === "string" ? v["note"] : ""));
      if (!link) bad("no such link between the two notes");
      const l = link as Note["links"][number];
      const text = connectionNote(l.type, l.note);
      if (bytes(text) > MAX_LINK_NOTE || hasHidingChars(text) || unpublishedMentions(notes, text).length > 0) bad("its link note fails G5 or G10");
      expected = { $type: CONNECTION, source: sn.meta["url"] as string, target: dn.meta["url"] as string, connectionType: s(v["connectionType"]) };
      if (text) expected["note"] = text;
    } else if (r.collection === COLLECTION) {
      const slug = hubs.get(s(v["name"]));
      if (slug === undefined) bad("no publishable hub has this name");
      const n = notes.get(slug as string) as Note;
      from = slug as string;
      expected = { $type: COLLECTION, name: n.title };
      if (n.body) expected["description"] = cutBytes(n.body, MAX_HUB_DESCRIPTION);
      expected["accessType"] = "CLOSED";
      expected["collaborators"] = [];
    } else if (r.collection === COLLECTION_LINK) {
      const c = ref("collection", (p) => p.collection === COLLECTION);
      const card = ref("card", (p) => p.collection === CARD && p.value["type"] === "URL");
      const hub = hubs.get(s(c.value["name"]));
      const [member] = page(s(o(card.value["content"])["url"]));
      if (hub === undefined) bad("no publishable hub has this name");
      if (!(notes.get(hub as string) as Note).links.some((l) => l.to === member)) bad("the hub does not link to this card's note");
      from = hub as string;
      expected = { $type: COLLECTION_LINK, collection: v["collection"] as Json, card: v["card"] as Json, addedBy: did };
    } else {
      return bad("unknown record type");
    }
    if (canonical(v) !== canonical(expected)) bad("its content differs from the note");
    return from;
  });
}

// --------------------------------------------------------------- requests

export interface Session {
  did: string;
  accessJwt: string;
}

/** One write. `action` is create or update; there is no other. */
export interface WriteOp {
  action: "create" | "update";
  repo: string;
  collection: CollectionName;
  rkey: string;
  record: JsonObject;
  /** The listed cid of the record an update replaces. Null for a create. */
  swapRecord: string | null;
}

type Outcome = { ok: true; r: HttpResponse } | { ok: false; r: HttpResponse | null };

/** POST with one retry on a network error, a timeout or a 5xx; never on a 4xx. */
async function post(t: Transport, url: string, body: JsonObject, headers: Record<string, string>): Promise<Outcome> {
  let last: HttpResponse | null = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      last = await t({ method: "POST", url, body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });
    } catch {
      last = null;
      continue;
    }
    if (last.status < 500) return { ok: last.status === 200, r: last } as Outcome;
  }
  return { ok: false, r: last };
}

/** Why a request failed, without the request: endpoint, status and the server's error code only. */
function failure(url: string, r: HttpResponse | null): string {
  if (r === null) return `POST ${endpoint(url)}: network error or timeout`;
  const code = serverCode(r).trim();
  if (code === "InvalidSwap") return `POST ${endpoint(url)}: HTTP ${r.status} InvalidSwap: record changed in the repo since this run read it; re-run`;
  if (code === "ExpiredToken") return `POST ${endpoint(url)}: HTTP ${r.status} ExpiredToken: the session expired mid-run; re-run`;
  return `POST ${endpoint(url)}: HTTP ${r.status}${code ? " " + code : ""}${rateReset(r)}`;
}

function json(r: HttpResponse): JsonObject | null {
  try {
    const v = JSON.parse(r.body) as unknown;
    return v && typeof v === "object" && !Array.isArray(v) ? (v as JsonObject) : null;
  } catch {
    return null;
  }
}

/** createSession with identifier = the config did. The session did must be the config did. */
async function openSession(t: Transport, acct: Account, password: string): Promise<Session> {
  const url = `${acct.pds}/xrpc/${SESSION}`;
  const out = await post(t, url, { identifier: acct.did, password }, {});
  if (out.r && out.r.status === 401) die(1, `authentication failed (POST ${endpoint(url)}: HTTP 401)`);
  if (!out.ok) die(1, `session: ${failure(url, out.r)}`);
  const body = json(out.r);
  const did = body?.["did"];
  const jwt = body?.["accessJwt"];
  if (typeof did !== "string" || typeof jwt !== "string" || jwt === "") die(1, "session: malformed server response");
  if (did !== acct.did) die(2, `session: the account signed in as ${/^did:[a-z]{1,16}:[A-Za-z0-9._:%-]{1,200}$/.test(did as string) ? did : "something that is not a DID"}, not the config did ${acct.did}; nothing was sent`);
  return { did: did as string, accessJwt: jwt as string };
}

/**
 * The one function that writes. Every limit is checked before the request is
 * built, so a refused write never reaches the transport.
 */
export async function writeRecord(t: Transport, acct: Account, session: Session, op: WriteOp):
  Promise<{ ok: true; uri: string; cid: string } | { ok: false; status: number | null; message: string }> {
  if ((op.action as string) !== "create" && (op.action as string) !== "update") die(2, `refused: anote never deletes and only creates or updates records (got ${String(op.action).slice(0, 20)})`);
  if (!ALLOWED.has(op.collection)) die(2, `refused: anote writes only to ${COLLECTIONS.join(", ")}, not ${String(op.collection).slice(0, 80)}`);
  if (op.repo !== acct.did) die(2, `refused: writes go only to the config did's repo ${acct.did}`);
  if (session.did !== acct.did) die(2, `refused: the session is for another account than ${acct.did}`);
  if (op.action === "create" && !/^[2-7a-j][a-z2-7]{12}$/.test(op.rkey)) die(2, "refused: a new record key must be a TID");
  if (!/^[A-Za-z0-9._:~-]{1,512}$/.test(op.rkey)) die(2, "refused: record key is not valid");
  if (op.action === "update" && !op.swapRecord) die(2, "refused: an update must name the cid it replaces");
  const url = `${acct.pds}/xrpc/${PUT}`;
  const body: JsonObject = { repo: op.repo, collection: op.collection, rkey: op.rkey, record: op.record };
  if (op.action === "update") body["swapRecord"] = op.swapRecord;
  const out = await post(t, url, body, { authorization: `Bearer ${session.accessJwt}` });
  if (!out.ok) return { ok: false, status: out.r?.status ?? null, message: failure(url, out.r) };
  const res = json(out.r);
  const uri = res?.["uri"];
  const cid = res?.["cid"];
  if (uri !== `at://${acct.did}/${op.collection}/${op.rkey}` || typeof cid !== "string" || cid === "") {
    return { ok: false, status: out.r.status, message: `POST ${endpoint(url)}: malformed server response` };
  }
  return { ok: true, uri: uri as string, cid: cid as string };
}

// ------------------------------------------------------------------ the run

export interface SendWrites {
  transport: Transport;
  acct: Account;
  /** The graph as it is now, freshly read. */
  notes: Notes;
  /** The plan, in write order, as matched against the repo. */
  records: Planned[];
  /** Reads the app password. Called once, after the last check passes. */
  readSecret: () => string | undefined;
  logFile: string;
  now?: () => Date;
}

export interface Sent {
  action: "created" | "updated";
  collection: CollectionName;
  uri: string;
  cid: string;
}

/** What a human can recognise a record by, safe to print. */
function label(r: Planned): string {
  const id = Object.entries(r.identity).filter(([k, x]) => x !== null && k !== "parentCard" && k !== "collection" && k !== "card")
    .map(([, x]) => x as string).join(" ");
  const kind = r.collection === CARD ? `card ${s(r.value["type"])}` : r.collection.slice("network.cosmik.".length);
  return `${kind} ${id}`.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, " ").slice(0, 300);
}

/** Send the writes. Returns what was written; stops at the first failure with exit 1 and a summary. */
export async function sendWrites(w: SendWrites): Promise<Sent[]> {
  const secrets: string[] = [];
  try {
    return await run(w, secrets);
  } catch (e) {
    if (e instanceof Fail) throw new Fail(e.code, redact(e.message, secrets));
    throw new Fail(1, redact(`send stopped: ${(e as Error).name}`, secrets));
  }
}

async function run(w: SendWrites, secrets: string[]): Promise<Sent[]> {
  const { transport: t, acct, records } = w;
  const now = w.now ?? (() => new Date());
  const from = traceRecords(w.notes, records, acct.did);
  if (records.filter((r) => r.action !== "unchanged").length > CAP) die(2, `over the cap of ${CAP} writes per run; nothing was sent`);
  const password = w.readSecret();
  if (password === undefined || password === "") die(2, `set ${SECRET_ENV} for this run; nothing was sent`);
  secrets.push(password as string);
  const session = await openSession(t, acct, password as string);
  secrets.push(session.accessJwt);

  const done: Array<{ uri: string; cid: string } | null> = records.map((r) =>
    r.action === "unchanged" ? { uri: r.uri as string, cid: r.cid as string } : null);
  const sent: Sent[] = [];
  const todo = records.filter((r) => r.action !== "unchanged").length;
  let k = 0;
  for (const [i, r] of records.entries()) {
    if (r.action === "unchanged") continue;
    k++;
    const record: JsonObject = JSON.parse(JSON.stringify(r.value)) as JsonObject;
    for (const [field, j] of Object.entries(r.refs)) {
      const target = done[j];
      if (!target) die(1, `internal: ${label(r)} points at a record that was not written`);
      record[field] = { uri: (target as { uri: string }).uri, cid: (target as { cid: string }).cid };
    }
    const at = now().toISOString();
    record["createdAt"] = s(r.kept["createdAt"]) || at;
    if (r.collection === CONNECTION || r.collection === COLLECTION) record["updatedAt"] = at;
    if (r.collection === COLLECTION_LINK) record["addedAt"] = s(r.kept["addedAt"]) || at;
    const rkey = r.action === "update" ? (r.uri as string).slice((r.uri as string).lastIndexOf("/") + 1) : newTid(now().getTime());
    const op: WriteOp = { action: r.action, repo: acct.did, collection: r.collection, rkey, record, swapRecord: r.action === "update" ? r.cid : null };
    const res = await writeRecord(t, acct, session, op);
    const uri = `at://${acct.did}/${r.collection}/${rkey}`;
    const note = slugHash(from[i] as string);
    if (!res.ok) {
      appendLog(w.logFile, { time: now().toISOString(), did: acct.did, collection: r.collection, uri, cid: null, action: "failed",
        ...(res.status === null ? {} : { status: res.status }), note });
      const lines = [
        `send stopped at write ${k} of ${todo}: ${res.message}`,
        `first failing record: ${label(r)}`,
        `written before the stop (${sent.length}):`,
        ...sent.map((x) => `  ${x.uri}`),
        "re-run `anote publish send` to read the repo again and finish; records already written are matched, not repeated",
      ];
      die(1, lines.join("\n"));
    }
    const action = r.action === "create" ? "created" : "updated";
    appendLog(w.logFile, { time: now().toISOString(), did: acct.did, collection: r.collection, uri: res.uri, cid: res.cid, action, note });
    done[i] = { uri: res.uri, cid: res.cid };
    sent.push({ action, collection: r.collection, uri: res.uri, cid: res.cid });
  }
  return sent;
}
