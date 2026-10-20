// publish mark / unmark / preview, the url field, and the check rules for
// graphs with published notes. All data here is invented (a sourdough graph).
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { assert, snapshot, sourdough, useCtx } from "./helpers.ts";
import type { Ctx } from "./helpers.ts";

const FIXTURE = path.resolve(import.meta.dirname, "fixtures", "v030");
const GOLDEN = path.resolve(import.meta.dirname, "fixtures", "v030-golden");

interface Preview {
  records: {
    cards: Array<{ type: string; url?: string; metadata?: { title: string }; parentCard?: { url: string }; text?: string }>;
    connections: Array<{ source: string; target: string; connectionType: string; note?: string }>;
    collections: Array<{ name: string; description?: string; accessType: string; memberships: Array<{ card: string }> }>;
  };
  left_out: Array<{ kind: string; note?: string; log?: string; from?: string; to?: string; type?: string; reason: string }>;
  notices: string[];
}

function preview(c: Ctx): Preview {
  const r = c.run(["publish", "preview", "--json"]);
  assert.equal(r.code, 0, r.err);
  return JSON.parse(r.out) as Preview;
}

function leftOutNotes(p: Preview): Record<string, string> {
  return Object.fromEntries(p.left_out.filter((l) => l.kind === "note").map((l) => [l.note, l.reason]));
}

describe("url field", () => {
  const c = useCtx();

  it("add --url and set url store it; show and --json include it", () => {
    c.add("Crumb guide", ["--type", "reference", "--url", "https://example.org/crumb"]);
    assert.ok(c.read("crumb-guide").includes("url: https://example.org/crumb\n"));
    assert.match(c.run(["show", "crumb-guide"]).out, /^url: https:\/\/example\.org\/crumb$/m);
    assert.equal(c.run(["set", "crumb-guide", "url", "http://example.org/crumb2"]).code, 0);
    const j = JSON.parse(c.run(["show", "crumb-guide", "--json"]).out) as { meta: Record<string, string> };
    assert.equal(j.meta["url"], "http://example.org/crumb2");
    assert.equal(c.run(["set", "crumb-guide", "url", "none"]).code, 0);
    assert.ok(!c.read("crumb-guide").includes("url:"));
  });

  it("works on any note type", () => {
    c.add("Starter care", ["--url", "https://example.org/starter"]);
    assert.ok(c.read("starter-care").includes("url: https://example.org/starter"));
  });

  it("rejects a url that is not http or https", () => {
    const r = c.run(["add", "Bad", "--source", "observed", "--type", "concept", "--url", "ftp://example.org/x"]);
    assert.equal(r.code, 2);
    assert.match(r.err, /http or https/);
    c.add("Ok");
    assert.equal(c.run(["set", "ok", "url", "not a url"]).code, 2);
  });
});

describe("publish mark and unmark", () => {
  const c = useCtx();

  it("marks a note with a url and records a hash; unmark clears both", () => {
    c.add("Crumb guide", ["--type", "reference", "--url", "https://example.org/crumb"]);
    const r = c.run(["publish", "mark", "crumb-guide"]);
    assert.equal(r.code, 0, r.err);
    assert.match(c.read("crumb-guide"), /^published: yes$/m);
    assert.match(c.read("crumb-guide"), /^published_hash: [0-9a-f]{64}$/m);
    const u = c.run(["publish", "unmark", "crumb-guide"]);
    assert.equal(u.code, 0);
    assert.match(u.err, /copies already sent may persist/);
    assert.ok(!c.read("crumb-guide").includes("published"));
  });

  it("refuses a person note (G3)", () => {
    c.add("Ada Baker", ["--type", "person", "--person-ok", "--url", "https://example.org/ada"]);
    const r = c.run(["publish", "mark", "ada-baker"]);
    assert.equal(r.code, 2);
    assert.match(r.err, /person notes are never published \(G3\)/);
    assert.ok(!c.read("ada-baker").includes("published"));
  });

  it("refuses a daily log (G3)", () => {
    c.run(["log", "fed the starter"]);
    const r = c.run(["publish", "mark", c.today]);
    assert.equal(r.code, 2);
    assert.match(r.err, /daily logs are never published \(G3\)/);
  });

  it("refuses a note with no url (G9)", () => {
    c.add("Wetter dough opens the crumb", ["--type", "assertion"]);
    const r = c.run(["publish", "mark", "wetter-dough-opens-the-crumb"]);
    assert.equal(r.code, 2);
    assert.match(r.err, /no url.*\(G9\)/);
  });

  it("refuses local, private and loopback urls (G9)", () => {
    const bad = [
      "http://localhost/x", "http://oven.local/x", "http://127.0.0.1/x", "http://10.1.2.3/x",
      "http://192.168.1.4/x", "http://172.20.0.1/x", "http://169.254.1.1/x", "http://[::1]/x", "http://[fd00::1]/x",
    ];
    bad.forEach((url, i) => {
      c.add(`Note ${i}`, ["--url", url]);
      const r = c.run(["publish", "mark", `note-${i}`]);
      assert.equal(r.code, 2, url);
      assert.match(r.err, /\(G9\)/, url);
    });
  });

  it("refuses a second marked note with the same url (G9)", () => {
    c.add("First", ["--url", "https://example.org/same"]);
    c.add("Second", ["--url", "https://example.org/same"]);
    assert.equal(c.run(["publish", "mark", "first"]).code, 0);
    const r = c.run(["publish", "mark", "second"]);
    assert.equal(r.code, 2);
    assert.match(r.err, /one published note per url \(G9\)/);
  });

  it("no other command sets or clears published (G2)", () => {
    c.add("Crumb guide", ["--url", "https://example.org/crumb"]);
    for (const k of ["published", "published_hash"]) {
      const r = c.run(["set", "crumb-guide", k, "yes"]);
      assert.equal(r.code, 2);
      assert.match(r.err, /only by `anote publish mark`/);
    }
    assert.ok(!c.read("crumb-guide").includes("published"));
    c.run(["publish", "mark", "crumb-guide"]);
    const r = c.run(["set", "crumb-guide", "published", "no"]);
    assert.equal(r.code, 2);
    assert.match(c.read("crumb-guide"), /^published: yes$/m);
    const added = c.run(["add", "X", "--source", "observed", "--type", "concept", "--published", "yes"]);
    assert.equal(added.code, 2);
  });

  it("superseding a marked note warns that copies may persist (G7)", () => {
    c.add("Old guide", ["--url", "https://example.org/old"]);
    c.add("New guide", ["--url", "https://example.org/new"]);
    c.run(["publish", "mark", "old-guide"]);
    const r = c.run(["supersede", "old-guide", "new-guide"]);
    assert.equal(r.code, 0);
    assert.match(r.err, /copies already sent may persist \(G7\)/);
    assert.doesNotMatch(r.out + r.err, /unpublished/);
    const quiet = c.run(["supersede", "new-guide", "old-guide"]);
    assert.equal(quiet.err, "");
  });
});

describe("publish preview", () => {
  const c = useCtx();

  it("prints the sourdough records and what is left out", () => {
    sourdough(c);
    const p = preview(c);
    const cards = p.records.cards;
    assert.equal(cards.filter((x) => x.type === "URL").length, 2);
    assert.equal(cards.filter((x) => x.type === "NOTE").length, 2);
    assert.deepEqual(cards.find((x) => x.url === "https://example.org/hydration")?.metadata, { title: "Sourdough hydration ratios" });
    assert.deepEqual(cards.find((x) => x.type === "NOTE" && x.parentCard?.url === "https://example.org/autolyse")?.text, "Rest flour and water first.");
    assert.equal(p.records.connections.length, 1);
    const conn = p.records.connections[0];
    assert.equal(conn?.source, "https://example.org/autolyse");
    assert.equal(conn?.target, "https://example.org/hydration");
    assert.equal(conn?.connectionType, "RELATED");
    assert.ok(conn?.note?.startsWith("[expands-on] "), conn?.note);
    assert.equal(p.records.collections.length, 1);
    const col = p.records.collections[0];
    assert.equal(col?.name, "Baking basics");
    assert.equal(col?.accessType, "CLOSED");
    assert.equal(col?.memberships.length, 2);
    const left = leftOutNotes(p);
    assert.equal(left["wetter-dough-opens-the-crumb"], "no url");
    assert.equal(left["ada-baker"], "person");
    assert.equal(Object.keys(left).length, 2);
    assert.deepEqual(p.left_out.filter((l) => l.kind === "log").map((l) => [l.log, l.reason]), [[c.today, "log"]]);
  });

  it("exports none of anote's own fields and no branding", () => {
    sourdough(c);
    const json = JSON.stringify(preview(c).records);
    // "source" is a connection field name in the record schema, so it is checked as a value only.
    for (const word of ["anote", "observed", "reference", "fragment", "hub", "review", "stance", "tags", "slug",
      "2026-", "sourdough-hydration-ratios", "autolyse-before-salt", "baking-basics"]) {
      assert.ok(!json.includes(word), `${word} leaked: ${json}`);
    }
  });

  it("an edit after marking moves the note to left out (hash drift) and drops its connection and membership", () => {
    sourdough(c);
    assert.equal(c.run(["append", "autolyse-before-salt", "Twenty minutes is enough."]).code, 0);
    const p = preview(c);
    assert.match(leftOutNotes(p)["autolyse-before-salt"] ?? "", /^hash drift/);
    assert.equal(p.records.connections.length, 0);
    assert.equal(p.records.collections[0]?.memberships.length, 1);
    assert.equal(p.records.cards.length, 2);
    assert.ok(p.left_out.some((l) => l.kind === "link" && l.from === "autolyse-before-salt" && l.reason === "source left out"));
    assert.ok(p.left_out.some((l) => l.kind === "link" && l.from === "baking-basics" && l.to === "autolyse-before-salt"));
    assert.equal(c.run(["publish", "mark", "autolyse-before-salt"]).code, 0);
    assert.equal(preview(c).records.connections.length, 1);
  });

  it("a link to an unpublished note is not exported, nor its slug or title (G5)", () => {
    c.add("Crumb guide", ["--type", "reference", "--url", "https://example.org/crumb", "--body", "Open crumb."]);
    c.add("Secret starter recipe", ["--url", "https://example.org/secret-starter"]);
    c.run(["link", "crumb-guide", "relates", "secret-starter-recipe", "--note", "same baker"]);
    c.run(["link", "secret-starter-recipe", "supports", "crumb-guide"]);
    c.run(["publish", "mark", "crumb-guide"]);
    const p = preview(c);
    const records = JSON.stringify(p.records);
    assert.equal(p.records.connections.length, 0);
    assert.ok(!records.includes("secret"), records);
    assert.ok(!records.includes("Secret"), records);
    const text = c.run(["publish", "preview"]).out;
    assert.match(text, /link crumb-guide relates secret-starter-recipe: unpublished target/);
    assert.match(text, /^connections \(0\):$/m);
  });

  it("text output lists each section and writes no file", () => {
    sourdough(c);
    const before = snapshot(c.tmp);
    const r = c.run(["publish", "preview"]);
    assert.equal(r.code, 0, r.err);
    for (const head of ["cards (4):", "connections (1):", "collections (1):", "left out ("]) assert.ok(r.out.includes(head), head);
    assert.match(r.out, /note ada-baker: person/);
    assert.match(r.out, /note wetter-dough-opens-the-crumb: no url/);
    assert.match(r.out, new RegExp(`log ${c.today}: log`));
    assert.deepEqual(snapshot(c.tmp), before);
  });

  it("cuts a long hub description to 500 bytes and says so (G10)", () => {
    sourdough(c);
    const p = c.notePath("baking-basics");
    fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace("Where to start.", "x".repeat(600)));
    c.run(["publish", "mark", "baking-basics"]);
    const out = preview(c);
    assert.equal(out.records.collections[0]?.description?.length, 500);
    assert.ok(out.notices.some((n) => n.includes("cut to the first 500")));
    assert.equal(c.run(["check"]).code, 0);
  });

  it("works in a graph with no notes", () => {
    const p = preview(c);
    assert.deepEqual(p.records, { cards: [], connections: [], collections: [] });
  });
});

describe("check with published notes", () => {
  const c = useCtx();

  it("the sourdough graph passes", () => {
    sourdough(c);
    const r = c.run(["check"]);
    assert.equal(r.code, 0, r.out);
  });

  it("errors on a person note marked by hand (G8)", () => {
    c.add("Ada Baker", ["--type", "person", "--person-ok"]);
    const p = c.notePath("ada-baker");
    fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace("status: active\n", "status: active\npublished: yes\n"));
    const r = c.run(["check"]);
    assert.equal(r.code, 1);
    assert.match(r.out, /ada-baker: a person note is marked published.*\(G8\)/);
  });

  it("errors on hash drift (G4)", () => {
    sourdough(c);
    c.run(["set", "sourdough-hydration-ratios", "title", "Hydration ratios"]);
    const r = c.run(["check"]);
    assert.equal(r.code, 1);
    assert.match(r.out, /sourdough-hydration-ratios: changed since `anote publish mark`/);
  });

  it("errors on an inline mention of an unpublished note in a published body or link note (G5)", () => {
    sourdough(c);
    c.run(["append", "sourdough-hydration-ratios", "See [[Wetter dough opens the crumb]]."]);
    c.run(["publish", "mark", "sourdough-hydration-ratios"]);
    c.run(["link", "autolyse-before-salt", "relates", "sourdough-hydration-ratios", "--note", "compare [[ada-baker]]"]);
    c.run(["publish", "mark", "autolyse-before-salt"]);
    const r = c.run(["check"]);
    assert.equal(r.code, 1);
    assert.match(r.out, /sourdough-hydration-ratios: body mentions unpublished note \[\[wetter-dough-opens-the-crumb\]\]/);
    assert.match(r.out, /autolyse-before-salt: note on link to sourdough-hydration-ratios mentions unpublished note \[\[ada-baker\]\]/);
    const left = leftOutNotes(preview(c));
    assert.equal(left["sourdough-hydration-ratios"], "body mentions an unpublished note");
    assert.ok(!JSON.stringify(preview(c).records).includes("ada-baker"));
  });

  it("errors on duplicate urls among published notes (G9)", () => {
    c.add("First", ["--url", "https://example.org/same"]);
    c.add("Second", ["--url", "https://example.org/other"]);
    c.run(["publish", "mark", "first"]);
    c.run(["publish", "mark", "second"]);
    for (const s of ["second"]) {
      const p = c.notePath(s);
      fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace("https://example.org/other", "https://example.org/same"));
    }
    const r = c.run(["check"]);
    assert.equal(r.code, 1);
    assert.match(r.out, /first: url is also on marked note\(s\) second/);
    assert.match(r.out, /second: url is also on marked note\(s\) first/);
    const left = leftOutNotes(preview(c));
    assert.match(left["first"] ?? "", /^duplicate url/);
    assert.match(left["second"] ?? "", /^hash drift/); // its url was edited by hand after marking
  });

  it("errors on a body over 10000, a link note over 1000 and a hub title over 100 (G10)", () => {
    sourdough(c);
    c.run(["append", "sourdough-hydration-ratios", "y".repeat(10001)]);
    c.run(["publish", "mark", "sourdough-hydration-ratios"]);
    c.run(["link", "autolyse-before-salt", "relates", "sourdough-hydration-ratios", "--note", "z".repeat(1001)]);
    c.run(["publish", "mark", "autolyse-before-salt"]);
    c.run(["set", "baking-basics", "title", "B".repeat(101)]);
    c.run(["publish", "mark", "baking-basics"]);
    const r = c.run(["check"]);
    assert.equal(r.code, 1);
    assert.match(r.out, /sourdough-hydration-ratios: body is over 10000 bytes \(G10\)/);
    assert.match(r.out, /autolyse-before-salt: note on link to sourdough-hydration-ratios is over 1000 bytes \(G10\)/);
    assert.match(r.out, /baking-basics: hub title is over 100 bytes \(G10\)/);
    const left = leftOutNotes(preview(c));
    assert.equal(left["sourdough-hydration-ratios"], "body over 10000");
    assert.equal(left["baking-basics"], "hub title over 100");
  });

  it("a graph with no published notes gets no new errors, even with odd urls", () => {
    c.add("Local page", ["--url", "http://localhost/x", "--body", "see [[Nowhere at all]]"]);
    c.add("Twin", ["--url", "http://localhost/x"]);
    c.add("Ada Baker", ["--type", "person", "--person-ok"]);
    const r = c.run(["check"]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /0 errors/);
  });
});

describe("a graph written by v0.3.0", () => {
  const c = useCtx();
  const cases = [
    "check", "check --json", "show kneading-time", "show kneading-time --json", "show oven-spring",
    "neighbors kneading-time", "neighbors oven-spring --json",
  ];

  it("check, show and neighbors print exactly what v0.3.0 printed", () => {
    fs.cpSync(FIXTURE, c.tmp, { recursive: true });
    const before = snapshot(c.tmp);
    cases.forEach((cmd, i) => {
      const r = c.run(cmd.split(" "));
      assert.equal(r.code, 0, `${cmd}: ${r.err}`);
      assert.equal(r.out, fs.readFileSync(path.join(GOLDEN, `${i + 1}.txt`), "utf8"), cmd);
    });
    assert.deepEqual(snapshot(c.tmp), before);
  });

  it("previews with nothing to send", () => {
    fs.cpSync(FIXTURE, c.tmp, { recursive: true });
    const p = preview(c);
    assert.equal(p.records.cards.length, 0);
    assert.deepEqual(leftOutNotes(p), { "kneading-time": "no url", "oven-spring": "no url" });
  });
});
