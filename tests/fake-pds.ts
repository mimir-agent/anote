// A fake PDS for `publish send` tests, and a guard that fails any real request.
// Every host here is invented (.example and .test names). The PLC directory url
// is the only real name: the fake answers it, so it is never contacted.
import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import * as net from "node:net";
import { syncBuiltinESMExports } from "node:module";
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
}

const json = (status: number, body: unknown): HttpResponse => ({
  status, body: JSON.stringify(body), headers: { "content-type": "application/json" },
});

/** The fake transport. Records every request (to `log`) before answering it. */
export function fakeTransport(state: FakeState, log: (l: Logged) => void): Transport {
  return async (req: HttpRequest) => {
    log({ method: req.method, url: req.url, via: "fake" });
    if (req.method !== "GET") return json(405, { error: "MethodNotAllowed" });
    const u = new URL(req.url);
    if (u.pathname === "/.well-known/atproto-did") {
      const body = state.wellKnown[u.hostname];
      return body === undefined ? { status: 404, body: "", headers: {} } : { status: 200, body, headers: {} };
    }
    if (u.origin === "https://plc.directory") {
      const doc = state.didDocs[decodeURIComponent(u.pathname.slice(1))];
      return doc === undefined ? json(404, { message: "DID not registered" }) : json(200, doc);
    }
    if (u.origin === state.pds && u.pathname === "/xrpc/com.atproto.repo.listRecords") {
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
  for (const m of [http, https] as Array<Record<string, unknown>>) {
    m["request"] = refuse("request");
    m["get"] = refuse("get");
  }
  (net as Record<string, unknown>)["connect"] = refuse("connect");
  (net as Record<string, unknown>)["createConnection"] = refuse("createConnection");
  syncBuiltinESMExports();
}

/** Append one JSON line to a file. */
export function appendLine(file: string, data: unknown): void {
  fs.appendFileSync(file, JSON.stringify(data) + "\n");
}
