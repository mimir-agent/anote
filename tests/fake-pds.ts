// A fake PDS for `publish send` tests, and a guard that fails any real request.
// Every host here is invented (.example and .test names). The PLC directory url
// is the only real name: the fake answers it, so it is never contacted.
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { createRequire, syncBuiltinESMExports } from "node:module";
import type { HttpRequest, HttpResponse, Json, Transport } from "../src/send.ts";

/** The invented account every send test uses unless it says otherwise. */
export const ACCOUNT = { handle: "alice.example.com", did: "did:plc:abcdefghijklmnopqrstuvwx", pds: "https://pds.example.com" };

export interface StoredRecord {
  uri: string;
  cid: string;
  value: Json;
}

export interface FakeState {
  /** Body of https://HOST/.well-known/atproto-did, per handle host. Missing: 404. */
  wellKnown: Record<string, string>;
  /** DID documents served by the PLC directory. Missing: 404. */
  didDocs: Record<string, Json>;
  /** The repo the fake holds, and its records per collection. */
  repo: string;
  pds: string;
  records: Record<string, StoredRecord[]>;
  /** Extra generated records per collection, to test the 1000 limit without a huge file. */
  bulk?: Record<string, number>;
  pageSize?: number;
  /** Answer the first `times` listRecords calls with this status. */
  failList?: { status: number; times: number };
  /** The app password createSession accepts (a sentinel), the token it hands out, and the did it signs in as. */
  password?: string;
  accessJwt?: string;
  sessionDid?: string;
  /** Answer createSession with this status and server error code. */
  failSession?: { status: number; error: string };
  /**
   * Fail putRecord calls number `nth` to `nth + times - 1` (counting every
   * attempt, retries too): with `status` and `error`, or by dropping the
   * connection when `drop` is set.
   */
  failPut?: { nth: number; times: number; status?: number; error?: string; drop?: boolean; headers?: Record<string, string> };
  /** Treat every swapRecord as stale (InvalidSwap). */
  staleSwaps?: boolean;
}

/** A DID document naming `pds` as the account's PDS. */
export function didDoc(did: string, handle: string, pds: string): Json {
  return {
    id: did,
    alsoKnownAs: [`at://${handle}`],
    service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: pds }],
  };
}

/** An account set up correctly with an empty repo. */
export function emptyState(): FakeState {
  return {
    wellKnown: { [ACCOUNT.handle]: ACCOUNT.did },
    didDocs: { [ACCOUNT.did]: didDoc(ACCOUNT.did, ACCOUNT.handle, ACCOUNT.pds) },
    repo: ACCOUNT.did,
    pds: ACCOUNT.pds,
    records: {},
  };
}

export interface Logged {
  method: string;
  url: string;
  /** "fake" for a request the fake answered, "real" for one the guard caught. */
  via: "fake" | "real";
  /** putRecord: the request body. createSession: the identifier only (the fake never logs a password). */
  body?: Json;
  /** Whether the request carried `Bearer <the fake's token>`. */
  authed?: boolean;
}

/** Invented sentinels, JWT-shaped like a real access token. */
export const SENTINEL_PASSWORD = "sentinel-app-password-not-real";
export const SENTINEL_JWT = "eyJzZW50aW5lbC1oZWFkZXI.eyJzZW50aW5lbC1ub3QtcmVhbCJ9.c2VudGluZWwtc2lnbmF0dXJl";

const json = (status: number, body: unknown, headers: Record<string, string> = {}): HttpResponse => ({
  status, body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers },
});

/** A content-addressed stand-in for a cid: the same record always gets the same one. */
function fakeCid(record: Json): string {
  return "bafyfake" + createHash("sha256").update(JSON.stringify(record)).digest("hex").slice(0, 24);
}

/** The fake transport. Records every request (to `log`) before answering it. */
export function fakeTransport(state: FakeState, log: (l: Logged) => void): Transport {
  let listCalls = 0;
  let putCalls = 0;
  const jwt = state.accessJwt ?? SENTINEL_JWT;
  return async (req: HttpRequest) => {
    const u = new URL(req.url);
    if (req.method === "POST") {
      const body = JSON.parse(req.body ?? "null") as Record<string, Json>;
      const authed = req.headers?.["authorization"] === `Bearer ${jwt}`;
      if (u.origin === state.pds && u.pathname === "/xrpc/com.atproto.server.createSession") {
        log({ method: "POST", url: req.url, via: "fake", body: { identifier: body["identifier"] ?? null } });
        // Error bodies echo the secret and token on purpose: anote must never print a server message.
        if (state.failSession) return json(state.failSession.status, { error: state.failSession.error, message: `${body["password"]} ${jwt}` });
        if (body["identifier"] !== state.repo || body["password"] !== (state.password ?? SENTINEL_PASSWORD)) {
          return json(401, { error: "AuthenticationRequired", message: `Invalid identifier or password ${String(body["password"])}` });
        }
        return json(200, { did: state.sessionDid ?? state.repo, handle: "alice.example.com", accessJwt: jwt, refreshJwt: jwt + "r", active: true });
      }
      if (u.origin === state.pds && u.pathname === "/xrpc/com.atproto.repo.putRecord") {
        log({ method: "POST", url: req.url, via: "fake", body: body as Json, authed });
        putCalls++;
        const f = state.failPut;
        if (f && putCalls >= f.nth && putCalls < f.nth + f.times) {
          if (f.drop) throw new Error(`connection dropped (${jwt})`);
          return json(f.status ?? 500, { error: f.error ?? "InternalServerError", message: `${jwt} ${state.password ?? SENTINEL_PASSWORD}` }, f.headers);
        }
        if (!authed) return json(401, { error: "AuthenticationRequired" });
        const collection = String(body["collection"]);
        if (body["repo"] !== state.repo) return json(400, { error: "InvalidRequest" });
        const uri = `at://${state.repo}/${collection}/${String(body["rkey"])}`;
        const list = (state.records[collection] ??= []);
        const at = list.findIndex((r) => r.uri === uri);
        const swap = body["swapRecord"];
        if (swap !== undefined && swap !== null && (state.staleSwaps || at < 0 || list[at]?.cid !== swap)) {
          return json(400, { error: "InvalidSwap", message: `Record was at ${list[at]?.cid ?? "nothing"}` });
        }
        const cid = fakeCid(body["record"] ?? null);
        const stored = { uri, cid, value: body["record"] ?? null };
        if (at >= 0) list[at] = stored;
        else list.push(stored);
        return json(200, { uri, cid, validationStatus: "unknown" });
      }
      log({ method: "POST", url: req.url, via: "fake" });
      return json(400, { error: "UnexpectedRequest" });
    }
    log({ method: req.method, url: req.url, via: "fake" });
    if (req.method !== "GET") return json(405, { error: "MethodNotAllowed" });
    if (u.pathname === "/.well-known/atproto-did") {
      const body = state.wellKnown[u.hostname];
      return body === undefined ? { status: 404, body: "", headers: {} } : { status: 200, body, headers: {} };
    }
    if (u.origin === "https://plc.directory") {
      const doc = state.didDocs[decodeURIComponent(u.pathname.slice(1))];
      return doc === undefined ? json(404, { message: "DID not registered" }) : json(200, doc);
    }
    if (u.origin === state.pds && u.pathname === "/xrpc/com.atproto.repo.listRecords") {
      listCalls++;
      if (state.failList && listCalls <= state.failList.times) return json(state.failList.status, { error: "InternalServerError", message: "x" });
      const repo = u.searchParams.get("repo");
      const collection = u.searchParams.get("collection") ?? "";
      if (repo !== state.repo) return json(400, { error: "InvalidRequest" });
      const all: StoredRecord[] = [...(state.records[collection] ?? [])];
      for (let i = 0; i < (state.bulk?.[collection] ?? 0); i++) {
        all.push({ uri: `at://${repo}/${collection}/bulk${i}`, cid: `bafybulk${i}`, value: { $type: collection, name: `bulk ${i}` } });
      }
      const size = Math.min(Number(u.searchParams.get("limit") ?? "50"), state.pageSize ?? 100);
      const start = Number(u.searchParams.get("cursor") ?? "0");
      const page = all.slice(start, start + size);
      const out: Record<string, unknown> = { records: page };
      if (start + size < all.length) out["cursor"] = String(start + size);
      return json(200, out);
    }
    return json(400, { error: "UnexpectedRequest" });
  };
}

/**
 * Replace fetch and the node:http, node:https and node:net request functions
 * with ones that record the attempt and throw, so a real host cannot be
 * reached by mistake and the test sees that one was tried.
 */
export function installNetworkGuard(log: (l: Logged) => void): void {
  const refuse = (what: string) => (...args: unknown[]): never => {
    const target = typeof args[0] === "string" || args[0] instanceof URL ? String(args[0]) : what;
    log({ method: what, url: target, via: "real" });
    throw new Error(`test guard: real network request refused (${what} ${target})`);
  };
  globalThis.fetch = refuse("fetch") as typeof fetch;
  // The CommonJS module objects are writable; syncBuiltinESMExports copies the
  // changes to the ES module namespaces that `import` gives.
  const load = createRequire(import.meta.url);
  for (const name of ["node:http", "node:https"]) {
    const m = load(name) as Record<string, unknown>;
    m["request"] = refuse(`${name} request`);
    m["get"] = refuse(`${name} get`);
  }
  for (const name of ["node:net", "node:tls"]) {
    const m = load(name) as Record<string, unknown>;
    m["connect"] = refuse(`${name} connect`);
    if (name === "node:net") m["createConnection"] = refuse(`${name} createConnection`);
  }
  syncBuiltinESMExports();
}

/** Append one JSON line to a file. */
export function appendLine(file: string, data: unknown): void {
  fs.appendFileSync(file, JSON.stringify(data) + "\n");
}
