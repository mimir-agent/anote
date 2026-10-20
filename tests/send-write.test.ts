// publish send --write, against the fake PDS in fake-pds.ts. The runner
// replaces fetch and node:http/https/net/tls so a real host cannot be reached,
// and logs any attempt (asserted empty after each run). All data is invented:
// the sourdough graph, alice.example.com, did:plc:abcdefghijklmnopqrstuvwx,
// and sentinel password and token values that are not real.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, describe, it } from "node:test";
import { Ctx, assert, sourdough } from "./helpers.ts";
import { ACCOUNT, SENTINEL_JWT, SENTINEL_PASSWORD, emptyState, installNetworkGuard } from "./fake-pds.ts";
import type { FakeState, Logged, StoredRecord } from "./fake-pds.ts";
import { SEMBLE_SHAPES, SEMBLE_TIMESTAMPS } from "./fixtures/semble-records.ts";
import { buildPlan } from "../src/publish.ts";
import { loadAll } from "../src/store.ts";
import { matchPlan } from "../src/send.ts";
import type { HttpRequest, JsonObject, Planned, Transport } from "../src/send.ts";
import { newTid, redact, sendWrites, traceRecords, writeRecord } from "../src/write.ts";
import type { WriteOp } from "../src/write.ts";
import { Fail } from "../src/util.ts";

const RUNNER = path.resolve(import.meta.dirname, "send-runner.ts");
const PUT = "com.atproto.repo.putRecord";
const SESSION = "com.atproto.server.createSession";
const TID = /^[2-7a-j][a-z2-7]{12}$/;

interface Out {
  code: number;
  out: string;
  err: string;
  requests: Logged[];
  secretReads: number;
  /** The fake's state after the run (records written included). */
  state: FakeState;
  /** The write log's lines, and its mode (null when no log was written). */
  log: Array<Record<string, unknown>>;
  logRaw: string;
  logMode: number | null;
}

let work = "";
let base = "";

function graph(name: string): string {
  const g = path.join(work, name);
  fs.cpSync(base, g, { recursive: true });
  return g;
}

interface Opts {
  config?: unknown;
  password?: string | null;
  tty?: string;
  /** Keep the write log between runs (its directory). */
  stateHome?: string;
}

/** Run `anote publish send ARGS` in graph `g` against the fake PDS holding `state`. */
function send(g: string, state: FakeState, args: string[] = [], o: Opts = {}): Out {
  const dir = fs.mkdtempSync(path.join(work, "run-"));
  const stateFile = path.join(dir, "state.json");
  const logFile = path.join(dir, "log.jsonl");
  const configFile = path.join(dir, "publish.json");
  const stateHome = o.stateHome ?? path.join(dir, "xdg-state");
  fs.writeFileSync(stateFile, JSON.stringify(state));
  fs.writeFileSync(logFile, "");
  fs.writeFileSync(configFile, JSON.stringify(o.config ?? ACCOUNT));
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>), HOME: dir, ANOTE_GRAPH: g, ANOTE_TODAY: "2026-10-09", ANOTE_PUBLISH_CONFIG: configFile,
    FAKE_PDS_STATE: stateFile, FAKE_PDS_LOG: logFile, XDG_STATE_HOME: stateHome,
  };
  delete env["ANOTE_PUBLISH_APP_PASSWORD"];
  if (o.password !== null) env["ANOTE_PUBLISH_APP_PASSWORD"] = o.password ?? SENTINEL_PASSWORD;
  if (o.tty !== undefined) env["FAKE_TTY"] = "1";
  const r = spawnSync("node", ["--disable-warning=ExperimentalWarning", RUNNER, "publish", "send", ...args], {
    env, encoding: "utf8", input: o.tty ?? "",
  });
  const lines = fs.readFileSync(logFile, "utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as Logged & { secretRead?: boolean });
  const wlog = path.join(stateHome, "anote", "publish-log.jsonl");
  const has = fs.existsSync(wlog);
  const logRaw = has ? fs.readFileSync(wlog, "utf8") : "";
  const out: Out = {
    code: r.status ?? -1, out: r.stdout, err: r.stderr,
    requests: lines.filter((l) => !l.secretRead), secretReads: lines.filter((l) => l.secretRead).length,
    state: JSON.parse(fs.readFileSync(stateFile, "utf8")) as FakeState,
    log: logRaw.split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as Record<string, unknown>),
    logRaw, logMode: has ? fs.statSync(wlog).mode & 0o777 : null,
  };
  assert.deepEqual(out.requests.filter((l) => l.via === "real"), [], "a real network request was attempted");
  noLeak(out);
  return out;
}

/** The sentinel password and token appear nowhere a person or a file could see them. */
function noLeak(r: Out): void {
  for (const [where, text] of [["stdout", r.out], ["stderr", r.err], ["write log", r.logRaw]] as const) {
    assert.ok(!text.includes(SENTINEL_PASSWORD), `the password appeared in ${where}`);
    assert.ok(!text.includes(SENTINEL_JWT), `the access token appeared in ${where}`);
    assert.ok(!text.includes(SENTINEL_JWT.split(".")[1] as string), `part of the access token appeared in ${where}`);
  }
}

function dryHash(g: string, state: FakeState, o: Opts = {}): string {
  const r = send(g, state, ["--json"], o);
  assert.equal(r.code, 0, r.err);
  assert.equal(r.secretReads, 0);
  return (JSON.parse(r.out) as { hash: string }).hash;
}

const puts = (r: Out) => r.requests.filter((l) => l.url.endsWith(PUT));
const posts = (r: Out) => r.requests.filter((l) => l.method === "POST");
const putBody = (l: Logged) => l.body as { repo: string; collection: string; rkey: string; record: JsonObject; swapRecord?: string };

/** Dry run, then --write --confirm with its hash. */
function write(g: string, state: FakeState, extra: string[] = [], o: Opts = {}): Out {
  return send(g, state, ["--write", "--confirm", dryHash(g, state, o), ...extra], o);
}

const all = (s: FakeState): StoredRecord[] => Object.values(s.records).flat();

before(() => {
  installNetworkGuard((l) => {
    throw new Error(`real request in the test process: ${l.url}`);
  });
  work = fs.mkdtempSync(path.join(os.tmpdir(), "anote-send-write-"));
  const c = new Ctx();
  c.tmp = path.join(work, "base");
  fs.mkdirSync(c.tmp);
  sourdough(c);
  base = c.tmp;
});

after(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

describe("send --write: story 3, nothing is written unless the exact list is confirmed", () => {
  it("--write without a terminal and without --confirm: exit 2, no secret read, no write", () => {
    const r = send(graph("s3-notty"), emptyState(), ["--write"]);
    assert.equal(r.code, 2);
    assert.match(r.err, /--write without a terminal needs --confirm HASH/);
    assert.equal(r.secretReads, 0);
    assert.deepEqual(r.requests, []);
  });

  it("a wrong hash: exit 2 with the spec's message, no secret read, no write", () => {
    const r = send(graph("s3-wrong"), emptyState(), ["--write", "--confirm", "000000000000"]);
    assert.equal(r.code, 2);
    assert.match(r.err, /^anote: plan changed since the dry run; run it again and read it$/m);
    assert.equal(r.secretReads, 0);
    assert.deepEqual(posts(r), []);
  });

  it("a stale hash (the graph changed after the dry run): exit 2, no write", () => {
    const g = graph("s3-stale");
    const h = dryHash(g, emptyState());
    const c = new Ctx();
    c.tmp = g;
    c.run(["append", "autolyse-before-salt", "One more line."]);
    assert.equal(c.run(["publish", "mark", "autolyse-before-salt"]).code, 0);
    const r = send(g, emptyState(), ["--write", "--confirm", h]);
    assert.equal(r.code, 2);
    assert.match(r.err, /plan changed since the dry run/);
    assert.equal(r.secretReads, 0);
    assert.deepEqual(posts(r), []);
  });

  it("on a terminal, typing anything but the hash aborts with no write and no secret read", () => {
    const g = graph("s3-tty-wrong");
    const h = dryHash(g, emptyState());
    for (const typed of ["yes\n", h.slice(0, 11) + "\n", "", h.toUpperCase() + "\n"]) {
      const r = send(g, emptyState(), ["--write"], { tty: typed });
      assert.equal(r.code, 2, typed);
      assert.match(r.out, /confirmation hash: [0-9a-f]{12}/, "the dry run is shown before the prompt");
      assert.match(r.out, /\| Rest flour and water first\./, "the full text is shown before the prompt");
      assert.match(r.err, /aborted: the typed text is not the confirmation hash; nothing was sent/);
      assert.equal(r.secretReads, 0);
      assert.deepEqual(posts(r), []);
    }
  });

  it("on a terminal, typing the hash sends", () => {
    const g = graph("s3-tty-right");
    const h = dryHash(g, emptyState());
    const r = send(g, emptyState(), ["--write"], { tty: h + "\n" });
    assert.equal(r.code, 0, r.err);
    assert.equal(puts(r).length, 8);
  });

  it("with the right hash, the writes match the dry run record for record", () => {
    const g = graph("s3-match");
    const dry = send(g, emptyState(), ["--json"]);
    const planned = (JSON.parse(dry.out) as { records: Planned[]; hash: string });
    const r = send(g, emptyState(), ["--write", "--confirm", planned.hash, "--json"]);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.secretReads, 1, "the password is read exactly once");
    const sent = puts(r).map(putBody);
    assert.equal(sent.length, planned.records.length);
    sent.forEach((b, i) => {
      const p = planned.records[i] as Planned;
      assert.equal(b.collection, p.collection);
      assert.equal(b.repo, ACCOUNT.did);
      assert.match(b.rkey, TID);
      assert.equal(b.swapRecord, undefined);
      const strip = (v: JsonObject) => {
        const x: JsonObject = { ...v };
        for (const k of ["createdAt", "updatedAt", "addedAt", ...Object.keys(p.refs)]) delete x[k];
        return x;
      };
      assert.deepEqual(strip(b.record), strip(p.value));
    });
    const j = JSON.parse(r.out) as { sent: Array<{ action: string; uri: string; cid: string }> };
    assert.equal(j.sent.length, 8);
    assert.ok(j.sent.every((x) => x.action === "created" && x.uri.startsWith(`at://${ACCOUNT.did}/network.cosmik.`)));
    const session = r.requests.filter((l) => l.url.endsWith(SESSION));
    assert.deepEqual(session.map((l) => l.body), [{ identifier: ACCOUNT.did }], "createSession once, identifier = config did");
    assert.ok(puts(r).every((l) => l.authed), "every write carries the session token");
  });
});

describe("send --write: story 4, a re-run never duplicates", () => {
  it("run 1 creates 8, run 2 writes nothing, run 3 after one edit updates exactly that NOTE card", () => {
    const g = graph("s4");
    const r1 = write(g, emptyState());
    assert.equal(r1.code, 0, r1.err);
    assert.equal(puts(r1).length, 8);
    assert.equal(all(r1.state).length, 8);

    const r2 = write(g, r1.state);
    assert.equal(r2.code, 0, r2.err);
    assert.match(r2.out, /^nothing to send$/m);
    assert.equal(r2.secretReads, 0, "zero planned writes never reads the secret");
    assert.deepEqual(posts(r2), []);

    const c = new Ctx();
    c.tmp = g;
    const p = path.join(g, "notes", "autolyse-before-salt.md");
    fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace("Rest flour and water first.", "Rest flour and water first, an hour."));
    assert.equal(c.run(["publish", "mark", "autolyse-before-salt"]).code, 0);
    const before = r1.state.records["network.cosmik.card"]?.find((x) => JSON.stringify(x.value).includes("Rest flour")) as StoredRecord;
    const r3 = write(g, r1.state);
    assert.equal(r3.code, 0, r3.err);
    const p3 = puts(r3).map(putBody);
    assert.equal(p3.length, 1);
    assert.equal(`at://${ACCOUNT.did}/${p3[0]?.collection}/${p3[0]?.rkey}`, before.uri, "same rkey");
    assert.equal(p3[0]?.swapRecord, before.cid, "swapRecord is the listed cid");
    assert.equal(p3[0]?.record["createdAt"], (before.value as JsonObject)["createdAt"], "createdAt kept from the repo");
    assert.equal(((p3[0]?.record["content"]) as JsonObject)["text"], "Rest flour and water first, an hour.");
    assert.equal(all(r3.state).length, 8);
  });
});

describe("send --write: story 5, a person note or a daily log never goes out", () => {
  it("a hand-marked person note and a daily log with frontmatter tricks: --write refuses before any request", () => {
    const g = graph("s5-graph");
    const ada = path.join(g, "notes", "ada-baker.md");
    fs.writeFileSync(ada, fs.readFileSync(ada, "utf8").replace("status: active\n", `status: active\npublished: yes\npublished_hash: ${"0".repeat(64)}\n`));
    const log = path.join(g, "daily", "2026-10-09.md");
    fs.writeFileSync(log, "---\npublished: yes\ntype: reference\nurl: https://example.org/log\n---\n" + fs.readFileSync(log, "utf8"));
    const r = send(g, emptyState(), ["--write", "--confirm", "000000000000"]);
    assert.equal(r.code, 2);
    assert.match(r.err, /ada-baker: a person note is marked published/);
    assert.equal(r.secretReads, 0);
    assert.deepEqual(r.requests, []);
  });

  for (const ty of ["Person", "PERSON", "#Person", "person, reference", "people"]) {
    it(`a hand-marked person note typed '${ty}': no plan record, and --write refuses before any request`, () => {
      const g = graph(`s5-type-${ty.replace(/\W+/g, "-")}`);
      const ada = path.join(g, "notes", "ada-baker.md");
      fs.writeFileSync(ada, fs.readFileSync(ada, "utf8").replace(/^type: .*$/m, `type: ${ty}`)
        .replace("status: active\n", `status: active\npublished: yes\npublished_hash: ${"0".repeat(64)}\n`));
      const { records } = matchPlan(buildPlan(loadAll(g), []), [], ACCOUNT.did);
      assert.ok(!JSON.stringify(records).includes("example.org/ada"));
      const r = send(g, emptyState(), ["--write", "--confirm", "000000000000"]);
      assert.equal(r.code, 2);
      assert.match(r.err, /ada-baker: .*\(G8\)/);
      assert.equal(r.secretReads, 0);
      assert.deepEqual(r.requests, []);
    });
  }

  it("a [[slug#heading]] of an unmarked note: --write refuses before any request (G5)", () => {
    const g = graph("s5-anchor");
    const p = path.join(g, "notes", "autolyse-before-salt.md");
    fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace("Rest flour and water first.", "See [[wetter-dough-opens-the-crumb#part]]."));
    const c = new Ctx();
    c.tmp = g;
    assert.equal(c.run(["publish", "mark", "autolyse-before-salt"]).code, 0);
    const r = send(g, emptyState(), ["--write", "--confirm", "000000000000"]);
    assert.equal(r.code, 2);
    assert.match(r.err, /body mentions unpublished note \[\[wetter-dough-opens-the-crumb\]\] \(G5\)/);
    assert.deepEqual(r.requests, []);
  });

  /** A plan for the sourdough graph with one extra record the plan code should never make. */
  function injected(g: string, extra: (records: Planned[]) => Planned[]): Planned[] {
    const { records } = matchPlan(buildPlan(loadAll(g), []), [], ACCOUNT.did);
    return extra(records);
  }

  const cases: Array<[string, (rs: Planned[]) => Planned[], (g: string) => void]> = [
    ["a URL card for the person note's url", (rs) => [{ ...(rs[0] as Planned), identity: { url: "https://example.org/ada" },
      value: { $type: "network.cosmik.card", type: "URL", content: { $type: "network.cosmik.card#urlContent", url: "https://example.org/ada",
        metadata: { $type: "network.cosmik.card#urlMetadata", title: "Ada Baker" } } } }, ...rs], () => {}],
    ["the person note marked by hand", (rs) => rs.map((r, i) => i === 0 ? { ...r, value: { ...r.value, content: { $type: "network.cosmik.card#urlContent",
      url: "https://example.org/ada", metadata: { $type: "network.cosmik.card#urlMetadata", title: "Ada Baker" } } } } : r),
      (g) => {
        const p = path.join(g, "notes", "ada-baker.md");
        fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace("status: active\n", `status: active\npublished: yes\npublished_hash: ${"0".repeat(64)}\n`));
      }],
    ["a NOTE card whose text differs from the note body", (rs) => rs.map((r) => r.value["type"] === "NOTE" && JSON.stringify(r.value).includes("Rest flour")
      ? { ...r, value: { ...r.value, content: { $type: "network.cosmik.card#noteContent", text: "a private fact" } } } : r), () => {}],
    ["a collection named after the daily log", (rs) => [...rs, { ...(rs.find((r) => r.collection === "network.cosmik.collection") as Planned),
      identity: { name: "2026-10-09" }, value: { $type: "network.cosmik.collection", name: "2026-10-09", accessType: "CLOSED", collaborators: [] } }], () => {}],
    ["a record in another collection", (rs) => [...rs, { ...(rs[0] as Planned), collection: "app.bsky.feed.post" as Planned["collection"] }], () => {}],
  ];
  for (const [name, bad, tweak] of cases) {
    it(`the write path's last check aborts the whole run on an injected bad plan: ${name}`, async () => {
      const g = graph(`s5-${name.replace(/\W+/g, "-")}`);
      tweak(g);
      const records = injected(g, bad);
      let calls = 0;
      let secretReads = 0;
      const t: Transport = async () => {
        calls++;
        throw new Error("no request may be made");
      };
      await assert.rejects(sendWrites({
        transport: t, acct: ACCOUNT, notes: loadAll(g), records, logFile: path.join(work, `s5-${calls}.jsonl`),
        readSecret: () => {
          secretReads++;
          return SENTINEL_PASSWORD;
        },
      }), (e: unknown) => e instanceof Fail && e.code === 2 && /does not trace to a publishable note.*nothing was sent/.test(e.message));
      assert.equal(calls, 0, "the transport was called");
      assert.equal(secretReads, 0, "the secret was read");
    });
  }

  it("the last check passes the real plan", () => {
    const g = graph("s5-ok");
    const { records } = matchPlan(buildPlan(loadAll(g), ["2026-10-09"]), [], ACCOUNT.did);
    assert.equal(traceRecords(loadAll(g), records, ACCOUNT.did).length, 8);
  });
});

describe("send --write: story 6, the credential can do no more through anote than the four record types", () => {
  const session = { did: ACCOUNT.did, accessJwt: SENTINEL_JWT };
  const op = (more: Partial<WriteOp>): WriteOp => ({
    action: "create", repo: ACCOUNT.did, collection: "network.cosmik.card", rkey: newTid(),
    record: { $type: "network.cosmik.card" }, swapRecord: null, ...more,
  });
  const refuses = async (o: WriteOp, s = session, why: RegExp) => {
    const seen: HttpRequest[] = [];
    const t: Transport = async (req) => {
      seen.push(req);
      return { status: 200, body: "{}", headers: {} };
    };
    await assert.rejects(writeRecord(t, ACCOUNT, s, o), (e: unknown) => e instanceof Fail && e.code === 2 && why.test(e.message));
    assert.deepEqual(seen, [], "the transport was called");
  };

  it("a record for app.bsky.feed.post is refused before the transport is called", async () => {
    await refuses(op({ collection: "app.bsky.feed.post" as WriteOp["collection"], record: { $type: "app.bsky.feed.post", text: "hi" } }), session,
      /anote writes only to network\.cosmik\.card, network\.cosmik\.connection, network\.cosmik\.collection, network\.cosmik\.collectionLink/);
  });

  it("a delete action is refused before the transport is called", async () => {
    await refuses(op({ action: "delete" as WriteOp["action"] }), session, /anote never deletes/);
  });

  it("a repo other than the config did is refused before the transport is called", async () => {
    await refuses(op({ repo: "did:plc:zzzzzzzzzzzzzzzzzzzzzzzz" }), session, /writes go only to the config did's repo/);
  });

  it("a session for another did is refused before the transport is called", async () => {
    await refuses(op({}), { ...session, did: "did:plc:zzzzzzzzzzzzzzzzzzzzzzzz" }, /session is for another account/);
  });

  it("a new record key that is not a TID, and an update without swapRecord, are refused", async () => {
    await refuses(op({ rkey: "self" }), session, /must be a TID/);
    await refuses(op({ action: "update", rkey: "3kexample0001" }), session, /must name the cid it replaces/);
  });

  it("no code path names deleteRecord or applyWrites", () => {
    for (const f of ["write.ts", "send.ts", path.join("commands", "send.ts")]) {
      const src = fs.readFileSync(path.resolve(import.meta.dirname, "..", "src", f), "utf8");
      assert.ok(!/deleteRecord|applyWrites/.test(src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")), f);
    }
  });

  it("the session signing in as another did: exit 2 before any write", () => {
    const state = { ...emptyState(), sessionDid: "did:plc:zzzzzzzzzzzzzzzzzzzzzzzz" };
    const r = write(graph("s6-session"), state);
    assert.equal(r.code, 2);
    assert.match(r.err, /session: the account signed in as did:plc:zzzzzzzzzzzzzzzzzzzzzzzz, not the config did/);
    assert.deepEqual(puts(r), []);
  });

  it("the password unset or empty: exit 2 with the spec's message, no request", () => {
    for (const password of [null, ""]) {
      const g = graph(`s6-nopass-${password === null ? "unset" : "empty"}`);
      const r = write(g, emptyState(), [], { password });
      assert.equal(r.code, 2);
      assert.match(r.err, /set ANOTE_PUBLISH_APP_PASSWORD for this run/);
      assert.deepEqual(posts(r), []);
    }
  });

  it("an unknown option is refused without echoing its value", () => {
    for (const args of [["--app-password", "value-not-to-echo"], ["--secret=value-not-to-echo"], ["--write", "--pw", "value-not-to-echo"]]) {
      const r = send(graph("s6-flags"), emptyState(), args);
      assert.equal(r.code, 2, args.join(" "));
      assert.ok(!(r.out + r.err).includes("value-not-to-echo"), `${args.join(" ")}: value echoed: ${r.err}`);
      assert.match(r.err, /unrecognized option/);
      assert.deepEqual(r.requests, []);
    }
  });
});

describe("send --write: story 7, a failed run says exactly what went out", () => {
  /** The sourdough graph without the hub: 2 URL cards, 2 NOTE cards and a connection, 5 writes. */
  function five(name: string): string {
    const g = graph(name);
    const c = new Ctx();
    c.tmp = g;
    assert.equal(c.run(["publish", "unmark", "baking-basics"]).code, 0);
    return g;
  }

  it("the 3rd of 5 writes failing: exit 1, a summary with the 2 written, 2 created and 1 failed log lines; a re-run finishes the other 3", () => {
    const g = five("s7");
    const stateHome = path.join(work, "s7-state");
    const state = { ...emptyState(), failPut: { nth: 3, times: 2, status: 500 } };
    const r = write(g, state, [], { stateHome });
    assert.equal(r.code, 1, r.err);
    const written = all(r.state).map((x) => x.uri);
    assert.equal(written.length, 2);
    assert.match(r.err, /send stopped at write 3 of 5: POST https:\/\/pds\.example\.com\/xrpc\/com\.atproto\.repo\.putRecord: HTTP 500 InternalServerError/);
    assert.match(r.err, /first failing record: card NOTE https:\/\/example\.org\/autolyse/);
    assert.match(r.err, /written before the stop \(2\):/);
    for (const u of written) assert.ok(r.err.includes(`  ${u}`), `${u} not in the summary`);
    assert.deepEqual(r.log.map((l) => l["action"]), ["created", "created", "failed"]);
    assert.equal(r.log[2]?.["status"], 500);
    assert.equal(puts(r).length, 4, "the 5xx was retried once");

    const again = { ...r.state };
    delete again.failPut;
    const r2 = write(g, again, [], { stateHome });
    assert.equal(r2.code, 0, r2.err);
    const p2 = puts(r2).map(putBody);
    assert.equal(p2.length, 3);
    assert.ok(p2.every((b) => !written.includes(`at://${ACCOUNT.did}/${b.collection}/${b.rkey}`)), "a re-run touched a record already written");
    assert.equal(all(r2.state).length, 5);
    assert.deepEqual(r2.log.map((l) => l["action"]), ["created", "created", "failed", "created", "created", "created"]);
  });
});

describe("send --write: order and strong refs", () => {
  it("NOTE parentCard and collection link refs carry the cids the fake returned", () => {
    const r = write(graph("refs"), emptyState());
    assert.equal(r.code, 0, r.err);
    const order = puts(r).map(putBody).map((b) => `${b.collection} ${String(b.record["type"] ?? "")}`.trim());
    assert.deepEqual(order, [
      "network.cosmik.card URL", "network.cosmik.card URL", "network.cosmik.card NOTE", "network.cosmik.card NOTE",
      "network.cosmik.connection", "network.cosmik.collection", "network.cosmik.collectionLink", "network.cosmik.collectionLink",
    ]);
    const byUri = new Map(all(r.state).map((x) => [x.uri, x]));
    for (const rec of all(r.state)) {
      const v = rec.value as JsonObject;
      for (const k of ["parentCard", "collection", "card"]) {
        const ref = v[k] as { uri: string; cid: string } | undefined;
        if (!ref || typeof ref !== "object") continue;
        assert.equal(ref.cid, byUri.get(ref.uri)?.cid, `${rec.uri} ${k} carries a cid the fake did not return`);
      }
    }
  });

  it("updating a URL card rewrites its NOTE card and collection link with the new cid", () => {
    const g = graph("cascade");
    const r1 = write(g, emptyState());
    const state = r1.state;
    const card = state.records["network.cosmik.card"]?.find((x) => JSON.stringify(x.value).includes("example.org/hydration") &&
      (x.value as JsonObject)["type"] === "URL") as StoredRecord;
    ((card.value as JsonObject)["content"] as JsonObject)["metadata"] = { $type: "network.cosmik.card#urlMetadata", title: "Old title" };
    card.cid = "bafyeditedinrepo";
    const r2 = write(g, state);
    assert.equal(r2.code, 0, r2.err);
    const p = puts(r2).map(putBody);
    assert.deepEqual(p.map((b) => b.collection), ["network.cosmik.card", "network.cosmik.card", "network.cosmik.collectionLink"]);
    assert.equal(p[0]?.swapRecord, "bafyeditedinrepo");
    const newCid = r2.state.records["network.cosmik.card"]?.find((x) => x.uri === card.uri)?.cid;
    assert.notEqual(newCid, "bafyeditedinrepo");
    assert.equal((p[1]?.record["parentCard"] as JsonObject)["cid"], newCid);
    assert.equal((p[2]?.record["card"] as JsonObject)["cid"], newCid);
    assert.ok(p.every((b) => typeof b.swapRecord === "string"));
  });

  it("the dry run names fields a richer remote URL card would lose", () => {
    const g = graph("drops");
    const r1 = write(g, emptyState());
    const card = r1.state.records["network.cosmik.card"]?.find((x) => JSON.stringify(x.value).includes("example.org/hydration") &&
      (x.value as JsonObject)["type"] === "URL") as StoredRecord;
    ((card.value as JsonObject)["content"] as JsonObject)["metadata"] = {
      $type: "network.cosmik.card#urlMetadata", title: "Richer title", description: "From the page", siteName: "Example",
    };
    const r = send(g, r1.state);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /drops fields the repo copy has: content\.metadata\.description, content\.metadata\.siteName/);
  });

  it("new records get TID keys", () => {
    const r = write(graph("tids"), emptyState());
    const keys = puts(r).map(putBody).map((b) => b.rkey);
    assert.ok(keys.every((k) => TID.test(k)), keys.join(" "));
    assert.equal(new Set(keys).size, keys.length);
  });

  it("written records have Semble's shape, timestamps included", () => {
    const r = write(graph("shape"), emptyState());
    const recs = puts(r).map(putBody).map((b) => b.record);
    const pick = (f: (v: JsonObject) => boolean) => recs.find(f) as JsonObject;
    const pairs: Array<[keyof typeof SEMBLE_SHAPES, JsonObject]> = [
      ["urlCard", pick((v) => v["type"] === "URL")],
      ["noteCard", pick((v) => v["type"] === "NOTE")],
      ["connection", pick((v) => v["$type"] === "network.cosmik.connection")],
      ["collection", pick((v) => v["$type"] === "network.cosmik.collection")],
      ["collectionLink", pick((v) => v["$type"] === "network.cosmik.collectionLink")],
    ];
    for (const [name, v] of pairs) {
      const want = [...Object.keys(SEMBLE_SHAPES[name]), ...SEMBLE_TIMESTAMPS[name]].sort();
      assert.deepEqual(Object.keys(v).sort(), want, name);
      for (const k of SEMBLE_TIMESTAMPS[name]) assert.match(String(v[k]), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    }
  });
});

describe("send --write: the confirmation hash", () => {
  it("refuses when one byte of a note body changed since the dry run", () => {
    const g = graph("hash-body");
    const h = dryHash(g, emptyState());
    const p = path.join(g, "notes", "autolyse-before-salt.md");
    fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace("Rest flour and water first.", "Rest flour and water first!"));
    const c = new Ctx();
    c.tmp = g;
    assert.equal(c.run(["publish", "mark", "autolyse-before-salt"]).code, 0);
    const r = send(g, emptyState(), ["--write", "--confirm", h]);
    assert.equal(r.code, 2);
    assert.match(r.err, /plan changed since the dry run/);
    assert.deepEqual(posts(r), []);
  });

  it("refuses when the remote state changed since the dry run, including only the cid of a record being updated", () => {
    const g = graph("hash-remote");
    const r1 = write(g, emptyState());
    const state = r1.state;
    const card = state.records["network.cosmik.card"]?.find((x) => (x.value as JsonObject)["type"] === "URL") as StoredRecord;
    ((card.value as JsonObject)["content"] as JsonObject)["metadata"] = { $type: "network.cosmik.card#urlMetadata", title: "Old" };
    const h = dryHash(g, state);
    card.cid = "bafyeditedagain"; // edited in the repo after the dry run; same content
    const r = send(g, state, ["--write", "--confirm", h]);
    assert.equal(r.code, 2);
    assert.match(r.err, /plan changed since the dry run/);
    assert.equal(r.secretReads, 0);
    assert.deepEqual(posts(r), []);
    const added = { ...emptyState() };
    const h2 = dryHash(g, added);
    added.records["network.cosmik.card"] = [{ uri: `at://${ACCOUNT.did}/network.cosmik.card/3kremote00001`, cid: "bafyr", value: {
      $type: "network.cosmik.card", type: "URL",
      content: { $type: "network.cosmik.card#urlContent", url: "https://example.org/hydration", metadata: { $type: "network.cosmik.card#urlMetadata", title: "Old" } },
    } }];
    const r2 = send(g, added, ["--write", "--confirm", h2]);
    assert.equal(r2.code, 2);
    assert.match(r2.err, /plan changed since the dry run/);
  });

  it("refuses when the config did changed since the dry run", () => {
    const g = graph("hash-did");
    const h = dryHash(g, emptyState());
    const other = { ...ACCOUNT, did: "did:plc:bbbbbbbbbbbbbbbbbbbbbbbb" };
    const state: FakeState = {
      ...emptyState(), repo: other.did, wellKnown: { [other.handle]: other.did },
      didDocs: { [other.did]: { id: other.did, service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: other.pds }] } },
    };
    const r = send(g, state, ["--write", "--confirm", h], { config: other });
    assert.equal(r.code, 2);
    assert.match(r.err, /plan changed since the dry run/);
    assert.deepEqual(posts(r), []);
  });

  it("an InvalidSwap from the server stops the run with the spec's message", () => {
    const g = graph("swap");
    const r1 = write(g, emptyState());
    const state = r1.state;
    const card = state.records["network.cosmik.card"]?.find((x) => (x.value as JsonObject)["type"] === "URL") as StoredRecord;
    ((card.value as JsonObject)["content"] as JsonObject)["metadata"] = { $type: "network.cosmik.card#urlMetadata", title: "Old" };
    state.staleSwaps = true;
    const r = write(g, state);
    assert.equal(r.code, 1);
    assert.match(r.err, /HTTP 400 InvalidSwap: record changed in the repo since this run read it; re-run/);
  });
});

describe("send --write: the password and session token never leak", () => {
  const paths: Array<[string, Partial<FakeState>, RegExp, number]> = [
    ["success", {}, /^sent 8 writes/m, 0],
    ["wrong password (401)", { password: "a-different-sentinel" }, /^anote: authentication failed \(POST https:\/\/pds\.example\.com\/xrpc\/com\.atproto\.server\.createSession: HTTP 401\)$/m, 1],
    ["createSession 500", { failSession: { status: 500, error: "InternalServerError" } }, /session: POST .*createSession: HTTP 500 InternalServerError/, 1],
    ["putRecord 500 twice", { failPut: { nth: 1, times: 2, status: 500 } }, /HTTP 500 InternalServerError/, 1],
    ["connection drop", { failPut: { nth: 2, times: 2, drop: true } }, /putRecord: network error or timeout/, 1],
    ["partial failure", { failPut: { nth: 4, times: 1, status: 400, error: "InvalidRequest" } }, /send stopped at write 4 of 8: .*HTTP 400 InvalidRequest/, 1],
    ["429", { failPut: { nth: 2, times: 1, status: 429, error: "RateLimitExceeded", headers: { "ratelimit-reset": "1792500000" } } },
      /HTTP 429 RateLimitExceeded \(rate limit resets at 2026-10-20T12:40:00\.000Z\)/, 1],
    ["ExpiredToken", { failPut: { nth: 3, times: 1, status: 401, error: "ExpiredToken" } }, /ExpiredToken: the session expired mid-run; re-run/, 1],
    ["InvalidSwap", { failPut: { nth: 2, times: 1, status: 400, error: "InvalidSwap" } }, /InvalidSwap: record changed in the repo/, 1],
  ];
  for (const [name, tweak, message, code] of paths) {
    for (const json of [false, true]) {
      it(`${name}${json ? " (--json)" : ""}: exit ${code}, and neither the password nor the token in stdout, stderr or the write log`, () => {
        const g = graph(`leak-${name.replace(/\W+/g, "-")}-${json}`);
        const r = write(g, { ...emptyState(), ...tweak }, json ? ["--json"] : []);
        assert.equal(r.code, code, r.err);
        assert.match(code === 0 && !json ? r.out : code === 0 ? "sent 8 writes" : r.err, message);
        if (code === 1) assert.ok(!/message|password/i.test(r.err), `a server message reached stderr: ${r.err}`);
        // noLeak ran inside send(); a 429 is never retried
        if (name === "429") assert.equal(puts(r).length, 2);
      });
    }
  }

  it("redact cuts the secret and anything shaped like a JWT", () => {
    assert.equal(redact(`a ${SENTINEL_PASSWORD} b ${SENTINEL_JWT} c`, [SENTINEL_PASSWORD]), "a [redacted] b [redacted] c");
  });
});

describe("send --write: the write log", () => {
  it("is mode 600, outside the graph, one line per write with only the spec's fields", () => {
    const g = graph("wlog");
    const r = write(g, emptyState());
    assert.equal(r.code, 0, r.err);
    assert.equal(r.logMode, 0o600);
    assert.equal(r.log.length, 8);
    const slugs = ["sourdough-hydration-ratios", "autolyse-before-salt", "baking-basics"];
    for (const l of r.log) {
      assert.deepEqual(Object.keys(l).sort(), ["action", "cid", "collection", "did", "note", "time", "uri"]);
      assert.equal(l["did"], ACCOUNT.did);
      assert.match(String(l["note"]), /^[0-9a-f]{64}$/);
    }
    for (const word of [...slugs, "example.org", "Sourdough", "Rest flour", "Baking basics", "authorization", "Bearer"]) {
      assert.ok(!r.logRaw.includes(word), `${word} is in the write log`);
    }
    assert.ok(!fs.readdirSync(g, { recursive: true }).some((f) => String(f).includes("publish-log")), "the log is inside the graph");
  });

  it("the dry run and a refused --write write no log", () => {
    const g = graph("wlog-none");
    assert.equal(send(g, emptyState()).logMode, null);
    assert.equal(send(g, emptyState(), ["--write", "--confirm", "000000000000"]).logMode, null);
  });
});

describe("send --write: the cap", () => {
  it("more writes than --max is refused before the secret is read", () => {
    const g = graph("cap");
    const h = dryHash(g, emptyState());
    const r = send(g, emptyState(), ["--write", "--confirm", h, "--max", "7"]);
    assert.equal(r.code, 2);
    assert.match(r.err, /8 writes planned, over the cap of 7 per run; nothing was sent/);
    assert.equal(r.secretReads, 0);
    assert.deepEqual(posts(r), []);
  });
});

describe("send --write: control and bidi characters", () => {
  it("a body with ESC and U+202E is refused (G10) and never printed raw", () => {
    const g = graph("ctrl");
    const p = path.join(g, "notes", "autolyse-before-salt.md");
    fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace("Rest flour and water first.", "Rest \u001b[8mhidden\u001b[0m flour \u202eand water."));
    const c = new Ctx();
    c.tmp = g;
    assert.equal(c.run(["publish", "mark", "autolyse-before-salt"]).code, 0);
    for (const args of [[], ["--write", "--confirm", "000000000000"]]) {
      const r = send(g, emptyState(), args);
      assert.equal(r.code, 2);
      assert.match(r.err, /body has control or bidi characters/);
      assert.ok(!(r.out + r.err).includes("\u001b") && !(r.out + r.err).includes("\u202e"));
      assert.deepEqual(r.requests, []);
    }
  });
});
