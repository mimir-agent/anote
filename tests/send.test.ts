// publish send, dry run. Every request goes to the fake PDS in fake-pds.ts;
// the runner replaces fetch and node:http/https/net so a real host cannot be
// reached, and logs any attempt (asserted empty after each run). All data is
// invented: the sourdough graph, alice.example.com, did:plc:abcdefghijklmnopqrstuvwx.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { Ctx, assert, snapshot, sourdough } from "./helpers.ts";
import { ACCOUNT, didDoc, emptyState, installNetworkGuard } from "./fake-pds.ts";
import type { FakeState, Logged, StoredRecord } from "./fake-pds.ts";
import { SEMBLE_SHAPES } from "./fixtures/semble-records.ts";
import { buildPlan } from "../src/publish.ts";
import { loadAll } from "../src/store.ts";
import { matchPlan } from "../src/send.ts";
import type { Json, JsonObject, Planned } from "../src/send.ts";

const RUNNER = path.resolve(import.meta.dirname, "send-runner.ts");
const FIXTURE = path.resolve(import.meta.dirname, "fixtures", "v030");
const SENTINEL = "sentinel-app-password-not-real";

interface SendOut {
  code: number;
  out: string;
  err: string;
  requests: Logged[];
  secretReads: number;
}

interface DryRun {
  graph: string;
  account: { handle: string; did: string; pds: string };
  records: Planned[];
  left_alone: Array<{ collection: string; uri: string; what: string }>;
  left_out: Array<{ kind: string; note?: string; log?: string; reason: string }>;
  counts: { create: number; update: number; unchanged: number; writes: number };
  hash: string;
}

let work = "";
let base = "";

/** A fresh copy of the sourdough graph. */
function graph(name: string): string {
  const g = path.join(work, name);
  fs.cpSync(base, g, { recursive: true });
  return g;
}

/** Run `anote publish send ARGS` in graph `g` against the fake PDS with `state`. */
function send(g: string, state: FakeState, args: string[] = [], config: unknown = ACCOUNT): SendOut {
  const dir = fs.mkdtempSync(path.join(work, "run-"));
  const stateFile = path.join(dir, "state.json");
  const logFile = path.join(dir, "log.jsonl");
  const configFile = path.join(dir, "publish.json");
  fs.writeFileSync(stateFile, JSON.stringify(state));
  fs.writeFileSync(logFile, "");
  if (config !== null) fs.writeFileSync(configFile, typeof config === "string" ? config : JSON.stringify(config));
  const env = {
    ...process.env, ANOTE_GRAPH: g, ANOTE_TODAY: "2026-10-09", ANOTE_PUBLISH_CONFIG: configFile,
    ANOTE_PUBLISH_APP_PASSWORD: SENTINEL, FAKE_PDS_STATE: stateFile, FAKE_PDS_LOG: logFile,
  };
  const r = spawnSync("node", ["--disable-warning=ExperimentalWarning", RUNNER, "publish", "send", ...args], { env, encoding: "utf8" });
  const lines = fs.readFileSync(logFile, "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as Logged & { secretRead?: boolean });
  const out: SendOut = {
    code: r.status ?? -1, out: r.stdout, err: r.stderr,
    requests: lines.filter((l) => !l.secretRead), secretReads: lines.filter((l) => l.secretRead).length,
  };
  assert.deepEqual(out.requests.filter((l) => l.via === "real"), [], "a real network request was attempted");
  assert.equal(out.secretReads, 0, "ANOTE_PUBLISH_APP_PASSWORD was read");
  assert.ok(!out.out.includes(SENTINEL) && !out.err.includes(SENTINEL), "the sentinel password was printed");
  assert.ok(out.requests.every((l) => l.method === "GET"), "a request other than GET was made");
  return out;
}

function dry(g: string, state: FakeState, args: string[] = []): DryRun {
  const r = send(g, state, ["--json", ...args]);
  assert.equal(r.code, 0, r.err);
  return JSON.parse(r.out) as DryRun;
}

const listCalls = (r: SendOut) => r.requests.filter((l) => l.url.includes("com.atproto.repo.listRecords"));

/**
 * What the repo would hold after a send of `records`: each gets a TID-like
 * rkey and a cid, strong refs are filled in from the records they point to,
 * and Semble's timestamps are added.
 */
function materialize(records: Planned[], did = ACCOUNT.did): Record<string, StoredRecord[]> {
  const out: Record<string, StoredRecord[]> = {};
  const urlCards = new Map<string, { uri: string; cid: string }>();
  const collections = new Map<string, { uri: string; cid: string }>();
  records.forEach((r, i) => {
    const uri = `at://${did}/${r.collection}/3kexample${String(i).padStart(4, "0")}`;
    const cid = `bafyexample${i}`;
    const v: JsonObject = JSON.parse(JSON.stringify(r.value)) as JsonObject;
    v["createdAt"] = "2026-10-09T00:00:00.000Z";
    if (r.collection === "network.cosmik.card" && v["type"] === "URL") {
      urlCards.set(r.identity["url"] as string, { uri, cid });
    } else if (r.collection === "network.cosmik.card") {
      v["parentCard"] = urlCards.get(v["url"] as string) as unknown as Json;
    } else if (r.collection === "network.cosmik.collection") {
      collections.set(r.identity["name"] as string, { uri, cid });
      v["updatedAt"] = v["createdAt"];
    } else if (r.collection === "network.cosmik.connection") {
      v["updatedAt"] = v["createdAt"];
    } else {
      v["collection"] = collections.get(r.identity["collectionName"] as string) as unknown as Json;
      v["card"] = urlCards.get(r.identity["cardUrl"] as string) as unknown as Json;
      v["addedAt"] = v["createdAt"];
    }
    (out[r.collection] ??= []).push({ uri, cid, value: v });
  });
  return out;
}

/** A state whose repo holds exactly what a send from `g` would write. */
function fullState(g: string): FakeState {
  return { ...emptyState(), records: materialize(dry(g, emptyState()).records) };
}

/** Key structure and $type values of a record, for comparing shapes. */
function shape(v: unknown): unknown {
  if (Array.isArray(v)) return "array";
  if (v === null || typeof v !== "object") return "value";
  const o = v as Record<string, unknown>;
  return Object.fromEntries(Object.keys(o).sort().map((k) => [k, k === "$type" ? o[k] : shape(o[k])]));
}

/** Real requests tried in this test process. The runner guards each child process the same way. */
const realAttempts: Logged[] = [];

before(() => {
  installNetworkGuard((l) => realAttempts.push(l));
  work = fs.mkdtempSync(path.join(os.tmpdir(), "anote-send-"));
  const c = new Ctx();
  c.tmp = path.join(work, "base");
  fs.mkdirSync(c.tmp);
  sourdough(c);
  base = c.tmp;
});

after(() => {
  fs.rmSync(work, { recursive: true, force: true });
  assert.deepEqual(realAttempts, [], "a real network request was attempted in the test process");
});

describe("publish send: story 1, see what would happen", () => {
  it("an empty repo gives 8 creates (2 URL, 2 NOTE, 1 connection, 1 collection, 2 links), GET only, and the password is never read", () => {
    const g = graph("s1-empty");
    const before = snapshot(g);
    const r = send(g, emptyState(), ["--json"]);
    assert.equal(r.code, 0, r.err);
    const d = JSON.parse(r.out) as DryRun;
    const kinds = d.records.map((x) => `${x.collection.slice("network.cosmik.".length)}${x.collection.endsWith(".card") ? " " + String(x.value["type"]) : ""}`);
    // The spec lists 2 URL cards, 2 NOTE cards, 1 connection, 1 collection and 2 links: 8 records
    // (its "7 total" is a miscount of that same list).
    assert.deepEqual(kinds, ["card URL", "card URL", "card NOTE", "card NOTE", "connection", "collection", "collectionLink", "collectionLink"]);
    assert.deepEqual(d.counts, { create: 8, update: 0, unchanged: 0, writes: 8 });
    assert.ok(d.records.every((x) => x.action === "create" && x.uri === null));
    const conn = d.records.find((x) => x.collection === "network.cosmik.connection");
    assert.equal(conn?.value["connectionType"], "RELATED");
    assert.equal(conn?.value["note"], "[expands-on] the rest step");
    assert.match(d.hash, /^[0-9a-f]{12}$/);
    assert.equal(d.graph, g);
    assert.deepEqual(d.account, ACCOUNT);
    assert.deepEqual(r.requests.map((l) => new URL(l.url).origin + new URL(l.url).pathname), [
      "https://alice.example.com/.well-known/atproto-did",
      `https://plc.directory/${ACCOUNT.did}`,
      ...Array(4).fill("https://pds.example.com/xrpc/com.atproto.repo.listRecords"),
    ]);
    assert.deepEqual(listCalls(r).map((l) => new URL(l.url).searchParams.get("collection")), [
      "network.cosmik.card", "network.cosmik.connection", "network.cosmik.collection", "network.cosmik.collectionLink",
    ]);
    assert.ok(listCalls(r).every((l) => new URL(l.url).searchParams.get("repo") === ACCOUNT.did));
    assert.deepEqual(snapshot(g), before);
  });

  it("the text output shows account, graph, every record, the full text, left alone, left out and the hash", () => {
    const g = graph("s1-text");
    const r = send(g, emptyState());
    assert.equal(r.code, 0, r.err);
    for (const line of [
      "dry run: nothing is sent and no secret is read",
      `graph:   ${g}`,
      `account: alice.example.com (${ACCOUNT.did}) on https://pds.example.com`,
      "  create     card URL https://example.org/hydration  \"Sourdough hydration ratios\"",
      "  create     card NOTE on https://example.org/autolyse",
      "      | Rest flour and water first.",
      "      | Water to flour, by weight.",
      "  create     connection https://example.org/autolyse -> https://example.org/hydration  RELATED",
      "      | [expands-on] the rest step",
      "  create     collection \"Baking basics\"  CLOSED",
      "      | Where to start.",
      "  create     collection link \"Baking basics\" <- https://example.org/hydration",
      "left alone (anote never deletes) (0):",
      "  note ada-baker: person",
      "  note wetter-dough-opens-the-crumb: no url",
      "  log 2026-10-09: log",
      "8 writes (8 create, 0 update)",
    ]) assert.ok(r.out.split("\n").includes(line), `missing line: ${line}\n${r.out}`);
    assert.match(r.out, /^confirmation hash: [0-9a-f]{12}$/m);
  });

  it("a repo already holding those records: all unchanged, nothing to send", () => {
    const g = graph("s1-full");
    const state = fullState(g);
    state.pageSize = 2; // page through the cards
    const r = send(g, state, ["--json"]);
    assert.equal(r.code, 0, r.err);
    const d = JSON.parse(r.out) as DryRun;
    assert.deepEqual(d.counts, { create: 0, update: 0, unchanged: 8, writes: 0 });
    assert.ok(d.records.every((x) => x.uri !== null && x.uri.startsWith(`at://${ACCOUNT.did}/`)));
    assert.deepEqual(d.left_alone, []);
    assert.ok(listCalls(r).length > 4, "listRecords was not paged");
    assert.match(send(g, state).out, /^nothing to send$/m);
  });

  it("records no marked note produces are listed under left alone with their AT URIs", () => {
    const g = graph("s1-alone");
    const state = fullState(g);
    const stray = { uri: `at://${ACCOUNT.did}/network.cosmik.card/3kstray00001`, cid: "bafystray", value: {
      $type: "network.cosmik.card", type: "URL", content: { $type: "network.cosmik.card#urlContent", url: "https://example.org/old" },
    } };
    state.records["network.cosmik.card"]?.push(stray);
    const d = dry(g, state);
    assert.deepEqual(d.left_alone, [{ collection: "network.cosmik.card", uri: stray.uri, what: "card URL https://example.org/old" }]);
    assert.equal(d.counts.writes, 0);
    assert.match(send(g, state).out, /^ {2}at:\/\/did:plc:abcdefghijklmnopqrstuvwx\/network\.cosmik\.card\/3kstray00001 {2}card URL https:\/\/example\.org\/old$/m);
  });

  it("a changed URL card is an update on the same record, and its NOTE card and collection link follow (cid cascade)", () => {
    const g = graph("s1-cascade");
    const state = fullState(g);
    const card = state.records["network.cosmik.card"]?.find((x) => (x.value as JsonObject)["type"] === "URL" &&
      JSON.stringify(x.value).includes("example.org/hydration")) as StoredRecord;
    ((card.value as JsonObject)["content"] as JsonObject)["metadata"] = { $type: "network.cosmik.card#urlMetadata", title: "Old title" };
    const d = dry(g, state);
    const changed = d.records.filter((x) => x.action !== "unchanged");
    assert.deepEqual(changed.map((x) => [x.collection, x.action, x.uri, x.cascade]), [
      ["network.cosmik.card", "update", card.uri, false],
      ["network.cosmik.card", "update", state.records["network.cosmik.card"]?.find((x) => JSON.stringify(x.value).includes(card.uri))?.uri, true],
      ["network.cosmik.collectionLink", "update", state.records["network.cosmik.collectionLink"]?.find((x) => JSON.stringify(x.value).includes(card.uri))?.uri, true],
    ]);
    assert.deepEqual(d.counts, { create: 0, update: 3, unchanged: 5, writes: 3 });
    assert.match(send(g, state).out, /\(a record it points to changes\)/);
  });

  it("refs to unchanged records carry the cid listed in the repo", () => {
    const g = graph("s1-refs");
    const state = fullState(g);
    const conn = state.records["network.cosmik.card"]?.find((x) => JSON.stringify(x.value).includes("Rest flour")) as StoredRecord;
    (((conn.value as JsonObject)["content"]) as JsonObject)["text"] = "older text";
    const d = dry(g, state);
    const note = d.records.find((x) => x.uri === conn.uri);
    assert.equal(note?.action, "update");
    assert.equal(note?.cascade, false);
    const parent = state.records["network.cosmik.card"]?.find((x) => x.uri === ((note?.value["parentCard"]) as JsonObject)["uri"]);
    assert.deepEqual(note?.value["parentCard"], { uri: parent?.uri, cid: parent?.cid });
  });

  it("a graph written by v0.3.0 is still valid and plans nothing", () => {
    const g = path.join(work, "v030");
    fs.cpSync(FIXTURE, g, { recursive: true });
    const d = dry(g, emptyState());
    assert.deepEqual(d.records, []);
    assert.equal(d.counts.writes, 0);
  });
});

describe("publish send: story 2, a clear stop when the account setup is wrong", () => {
  const cases: Array<[string, unknown, RegExp, (s: FakeState) => void]> = [
    ["missing config", null, /no publish config at .*publish\.json; create it with exactly the keys handle, did and pds/, () => {}],
    ["not JSON", "{handle", /publish config .* is not valid JSON/, () => {}],
    ["extra key", { ...ACCOUNT, name: "x" }, /publish config: unknown key 'name'/, () => {}],
    ["secret-looking key", { ...ACCOUNT, app_password: "x" }, /key 'app_password': secrets never go in this file; see Credential/, () => {}],
    ["token key", { ...ACCOUNT, accessToken: "x" }, /key 'accessToken': secrets never go in this file/, () => {}],
    ["missing did", { handle: ACCOUNT.handle, pds: ACCOUNT.pds }, /publish config: did is missing/, () => {}],
    ["http pds", { ...ACCOUNT, pds: "http://pds.example.com" }, /publish config: pds must use https/, () => {}],
    ["pds with a path", { ...ACCOUNT, pds: "https://pds.example.com/xrpc" }, /publish config: pds must be the server address only/, () => {}],
    ["pds with a port", { ...ACCOUNT, pds: "https://pds.example.com:8443" }, /publish config: pds must not name a port/, () => {}],
    ["pds with user info", { ...ACCOUNT, pds: "https://u:p@pds.example.com" }, /publish config: pds must not carry a user name or password/, () => {}],
    ["localhost pds", { ...ACCOUNT, pds: "https://localhost" }, /publish config: pds points at localhost/, () => {}],
    [".local pds", { ...ACCOUNT, pds: "https://pds.local" }, /publish config: pds points at a \.local name/, () => {}],
    ["private IP pds", { ...ACCOUNT, pds: "https://192.168.1.4" }, /publish config: pds points at a private or loopback IP/, () => {}],
    ["IPv6 loopback pds", { ...ACCOUNT, pds: "https://[::1]" }, /publish config: pds points at a private or loopback IP/, () => {}],
    ["did:web", { ...ACCOUNT, did: "did:web:alice.example.com" }, /publish config: did: did:web is not supported/, () => {}],
    ["not a did:plc", { ...ACCOUNT, did: "did:plc:short" }, /publish config: did must be a did:plc identifier/, () => {}],
    ["handle resolves to another DID", ACCOUNT, /^anote: handle: alice\.example\.com resolves to did:plc:zzzzzzzzzzzzzzzzzzzzzzzz, not the config did/m,
      (s) => { s.wellKnown[ACCOUNT.handle] = "did:plc:zzzzzzzzzzzzzzzzzzzzzzzz"; }],
    ["handle does not resolve", ACCOUNT, /^anote: handle: alice\.example\.com does not resolve/m, (s) => { s.wellKnown = {}; }],
    ["DID document names another PDS", ACCOUNT, /^anote: pds: the DID document names https:\/\/other\.example\.com\/ as the PDS, not https:\/\/pds\.example\.com/m,
      (s) => { s.didDocs[ACCOUNT.did] = didDoc(ACCOUNT.did, ACCOUNT.handle, "https://other.example.com"); }],
    ["DID not in the directory", ACCOUNT, /^anote: did: did:plc:abcdefghijklmnopqrstuvwx is not in the PLC directory/m, (s) => { s.didDocs = {}; }],
  ];
  for (const [name, config, message, tweak] of cases) {
    it(`${name}: exit 2 with one line, before any listRecords`, () => {
      const g = graph(`s2-${name.replace(/\W+/g, "-")}`);
      const state = emptyState();
      tweak(state);
      const r = send(g, state, [], config);
      assert.equal(r.code, 2, r.out + r.err);
      assert.match(r.err, message);
      assert.equal(r.err.trim().split("\n").length, 1, r.err);
      assert.equal(r.out, "");
      assert.deepEqual(listCalls(r), []);
    });
  }

  it("refused flags exit 2 without echoing their value, before reading the config", () => {
    const g = graph("s2-flags");
    for (const args of [["--password", "hunter2-value"], ["--token", "tok-value"], ["--did", "did:plc:zzzzzzzzzzzzzzzzzzzzzzzz"],
      ["--pds", "https://pds.example.com"], ["--delete"]]) {
      const r = send(g, emptyState(), args);
      assert.equal(r.code, 2, args.join(" "));
      assert.match(r.err, args[0] === "--delete" ? /--delete is refused: anote never deletes/ : new RegExp(`${args[0]} is refused`));
      if (args[1]) assert.ok(!(r.out + r.err).includes(args[1]), `${args[0]} value echoed`);
      assert.deepEqual(r.requests, []);
    }
  });

  it("--write is not available yet", () => {
    const r = send(graph("s2-write"), emptyState(), ["--write"]);
    assert.equal(r.code, 2);
    assert.match(r.err, /--write is not available yet/);
    assert.deepEqual(r.requests, []);
  });
});

describe("publish send: refusals", () => {
  it("two remote records with one identity: exit 2 naming both URIs", () => {
    const g = graph("dup");
    const state = fullState(g);
    const cards = state.records["network.cosmik.card"] as StoredRecord[];
    const first = cards[0] as StoredRecord;
    const twin = { ...first, uri: `at://${ACCOUNT.did}/network.cosmik.card/3ktwin000001`, cid: "bafytwin" };
    cards.push(twin);
    const r = send(g, state);
    assert.equal(r.code, 2);
    assert.ok(r.err.includes(first.uri) && r.err.includes(twin.uri), r.err);
    assert.match(r.err, /anote does not pick one/);
  });

  it("more writes than --max: exit 2; --max cannot raise the cap of 50", () => {
    const g = graph("cap");
    const r = send(g, emptyState(), ["--max", "7"]);
    assert.equal(r.code, 2);
    assert.match(r.err, /8 writes planned, over the cap of 7 per run/);
    assert.equal(send(g, emptyState(), ["--max", "8"]).code, 0);
    const high = send(g, emptyState(), ["--max", "51"]);
    assert.equal(high.code, 2);
    assert.match(high.err, /--max can only lower the cap of 50/);
  });

  it("over 50 planned writes is refused at the default cap", () => {
    const c = new Ctx();
    c.tmp = path.join(work, "cap50");
    fs.mkdirSync(c.tmp);
    for (let i = 0; i < 26; i++) {
      c.add(`Page ${i}`, ["--type", "reference", "--url", `https://example.org/p${i}`, "--body", `Body ${i}.`]);
      assert.equal(c.run(["publish", "mark", `page-${i}`]).code, 0);
    }
    const r = send(c.tmp, emptyState());
    assert.equal(r.code, 2);
    assert.match(r.err, /52 writes planned, over the cap of 50 per run/);
  });

  it("more than 1000 records in a collection: exit 2", () => {
    const g = graph("over1000");
    const state = emptyState();
    state.bulk = { "network.cosmik.collection": 1001 };
    const r = send(g, state);
    assert.equal(r.code, 2);
    assert.match(r.err, /network\.cosmik\.collection: more than 1000 records in the repo/);
  });

  it("publish check errors in the graph: exit 2 before any request", () => {
    const g = graph("checkerr");
    const p = path.join(g, "notes", "autolyse-before-salt.md");
    fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace("Rest flour", "Rest the flour"));
    const r = send(g, emptyState());
    assert.equal(r.code, 2);
    assert.match(r.err, /the graph has publishing errors/);
    assert.match(r.err, /autolyse-before-salt: changed since `anote publish mark`/);
    assert.deepEqual(r.requests, []);
  });
});

describe("publish send: network failures and the guard", () => {
  it("one 5xx is retried once; a second stops with exit 1 naming endpoint, status and server code only", () => {
    const g = graph("retry");
    const once = emptyState();
    once.failList = { status: 502, times: 1 };
    const ok = send(g, once);
    assert.equal(ok.code, 0, ok.err);
    assert.equal(listCalls(ok).length, 5);
    const twice = emptyState();
    twice.failList = { status: 500, times: 2 };
    const r = send(g, twice);
    assert.equal(r.code, 1);
    assert.equal(r.err, "anote: listRecords network.cosmik.card: GET https://pds.example.com/xrpc/com.atproto.repo.listRecords: HTTP 500 InternalServerError\n");
    assert.equal(listCalls(r).length, 2);
  });

  it("a 4xx is not retried", () => {
    const g = graph("no-retry");
    const state = emptyState();
    state.failList = { status: 400, times: 1 };
    const r = send(g, state);
    assert.equal(r.code, 1);
    assert.equal(listCalls(r).length, 1);
  });

  it("the guard refuses a real request and records it (in this process too)", async () => {
    const { fetchTransport } = await import("../src/send.ts");
    await assert.rejects(fetchTransport({ method: "GET", url: "https://pds.example.com/xrpc/x" }), /real network request refused/);
    const https = await import("node:https");
    assert.throws(() => https.request("https://pds.example.com/"), /real network request refused/);
    assert.deepEqual(realAttempts.splice(0).map((l) => l.via), ["real", "real"]);
  });
});

describe("publish send: person notes and daily logs never go out", () => {
  /** The sourdough graph with Ada Baker marked by hand (published and a hash edited in). */
  function adaMarked(name: string): string {
    const g = graph(name);
    const p = path.join(g, "notes", "ada-baker.md");
    const hash = "0".repeat(64);
    fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace("status: active\n", `status: active\npublished: yes\npublished_hash: ${hash}\n`));
    const log = path.join(g, "daily", "2026-10-09.md");
    fs.writeFileSync(log, "---\npublished: yes\ntype: reference\nurl: https://example.org/log\n---\n" + fs.readFileSync(log, "utf8"));
    return g;
  }

  it("send refuses the graph (check error G8) and requests nothing", () => {
    const r = send(adaMarked("ada-send"), emptyState());
    assert.equal(r.code, 2);
    assert.match(r.err, /ada-baker: a person note is marked published.*\(G8\)/);
    assert.deepEqual(r.requests, []);
  });

  it("the plan has no record for the person note or the log, whatever their frontmatter says", () => {
    const g = adaMarked("ada-plan");
    const plan = buildPlan(loadAll(g), ["2026-10-09"]);
    const { records } = matchPlan(plan, [], ACCOUNT.did);
    const all = JSON.stringify(records);
    assert.ok(!all.includes("example.org/ada") && !all.includes("Ada") && !all.includes("example.org/log"), all);
    assert.equal(records.length, 8);
    assert.ok(plan.left_out.some((l) => l.kind === "note" && l.note === "ada-baker" && l.reason === "person"));
    assert.ok(plan.left_out.some((l) => l.kind === "log" && l.log === "2026-10-09"));
  });
});

describe("publish send: confirmation hash", () => {
  it("is stable for the same graph, remote state and account", () => {
    const g = graph("hash-same");
    assert.equal(dry(g, emptyState()).hash, dry(g, emptyState()).hash);
  });

  it("changes when one byte of a note body changes", () => {
    const g = graph("hash-body");
    const h1 = dry(g, emptyState()).hash;
    const p = path.join(g, "notes", "autolyse-before-salt.md");
    fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace("Rest flour and water first.", "Rest flour and water first!"));
    const c = new Ctx();
    c.tmp = g;
    assert.equal(c.run(["publish", "mark", "autolyse-before-salt"]).code, 0);
    assert.notEqual(dry(g, emptyState()).hash, h1);
  });

  it("changes when the remote state changes", () => {
    const g = graph("hash-remote");
    const h1 = dry(g, emptyState()).hash;
    const state = emptyState();
    state.records["network.cosmik.card"] = [{ uri: `at://${ACCOUNT.did}/network.cosmik.card/3kremote0001`, cid: "bafyr", value: {
      $type: "network.cosmik.card", type: "URL",
      content: { $type: "network.cosmik.card#urlContent", url: "https://example.org/hydration", metadata: { $type: "network.cosmik.card#urlMetadata", title: "Old" } },
    } }];
    const d = dry(g, state);
    assert.equal(d.records.find((x) => x.identity["url"] === "https://example.org/hydration")?.action, "update");
    assert.notEqual(d.hash, h1);
  });

  it("changes when the config did changes", () => {
    const g = graph("hash-did");
    const h1 = dry(g, emptyState()).hash;
    const other = { ...ACCOUNT, did: "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb" };
    const state: FakeState = {
      ...emptyState(), repo: other.did,
      wellKnown: { [other.handle]: other.did },
      didDocs: { [other.did]: didDoc(other.did, other.handle, other.pds) },
    };
    const r = send(g, state, ["--json"], other);
    assert.equal(r.code, 0, r.err);
    assert.notEqual((JSON.parse(r.out) as DryRun).hash, h1);
  });

  it("changes with the graph path", () => {
    assert.notEqual(dry(graph("hash-path-a"), emptyState()).hash, dry(graph("hash-path-b"), emptyState()).hash);
  });
});

describe("publish send: record shapes match what Semble writes", () => {
  it("each record has the fields Semble's mappers set, without anote's own fields", () => {
    const g = graph("shape");
    const full = dry(g, fullState(g)).records; // unchanged records carry real refs
    const byKind = (pred: (r: Planned) => boolean) => full.find(pred) as Planned;
    const pairs: Array<[string, Planned, unknown]> = [
      ["urlCard", byKind((r) => r.collection === "network.cosmik.card" && r.value["type"] === "URL"), SEMBLE_SHAPES.urlCard],
      ["noteCard", byKind((r) => r.collection === "network.cosmik.card" && r.value["type"] === "NOTE"), SEMBLE_SHAPES.noteCard],
      ["connection", byKind((r) => r.collection === "network.cosmik.connection"), SEMBLE_SHAPES.connection],
      ["collection", byKind((r) => r.collection === "network.cosmik.collection"), SEMBLE_SHAPES.collection],
      ["collectionLink", byKind((r) => r.collection === "network.cosmik.collectionLink"), SEMBLE_SHAPES.collectionLink],
    ];
    for (const [name, rec, semble] of pairs) assert.deepEqual(shape(rec.value), shape(semble), name);
    const json = JSON.stringify(full.map((r) => r.value));
    for (const word of ["anote", "observed", "reference", "fragment", "review", "stance", "tags", "slug", "2026-",
      "sourdough-hydration-ratios", "autolyse-before-salt", "baking-basics"]) {
      assert.ok(!json.includes(word), `${word} leaked: ${json}`);
    }
    assert.equal(byKind((r) => r.collection === "network.cosmik.collectionLink").value["addedBy"], ACCOUNT.did);
  });
});
