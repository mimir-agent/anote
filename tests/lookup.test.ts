import { describe, it } from "node:test";
import { assert, useCtx } from "./helpers.ts";

describe("lookup", () => {
  const c = useCtx();

  it("not found and ambiguous", () => {
    c.add("Cron one");
    c.add("Cron two");
    assert.equal(c.run(["show", "nothing-here"]).code, 3);
    const r = c.run(["show", "cron"]);
    assert.equal(r.code, 3);
    assert.match(r.err, /ambiguous/);
  });

  it("resolve by title and prefix", () => {
    c.add("Web extract needs a backend");
    assert.equal(c.run(["show", "Web extract needs a backend"]).code, 0);
    assert.equal(c.run(["show", "web-extract"]).code, 0);
  });

  it("search ranks title over body", () => {
    c.add("Email fallback", ["--body", "nothing relevant"]);
    c.add("Something else", ["--body", "mentions email once"]);
    const out = c.run(["search", "email"]).out.split("\n");
    assert.ok((out[0] as string).startsWith("email-fallback"));
  });

  it("search budget truncates", () => {
    for (let i = 0; i < 6; i++) c.add(`Topic ${i}`, ["--body", "shared word ".repeat(30)]);
    const full = JSON.parse(c.run(["search", "shared", "--json"]).out);
    const small = JSON.parse(c.run(["search", "shared", "--budget", "60", "--json"]).out);
    assert.ok(small.length < full.length);
  });

  it("daily log is searchable and showable", () => {
    assert.equal(c.run(["log", "restarted the gateway by hand"]).code, 0);
    assert.ok(c.run(["search", "gateway"]).out.includes("daily/2026-10-09"));
    assert.ok(c.run(["show", "2026-10-09"]).out.includes("restarted the gateway"));
  });

  it("list filters", () => {
    c.add("A", ["--tag", "x"]);
    c.add("B", ["--tag", "y"]);
    const out = c.run(["list", "--tag", "x"]).out;
    assert.ok(out.includes("a "));
    assert.ok(!("\n" + out).includes("\nb "));
  });
});

describe("staleness", () => {
  const c = useCtx();

  it("stale and confirm", () => {
    c.add("Old fact", ["--review", "+10d"]);
    c.add("Fresh fact", ["--review", "+100d"]);
    assert.equal(c.run(["stale"]).out.trim(), "nothing due");
    const late = c.run(["stale"], { today: "2026-10-25" }).out;
    assert.ok(late.includes("old-fact"));
    assert.ok(!late.includes("fresh-fact"));
    assert.ok(late.includes("overdue by"));
    assert.equal(c.run(["confirm", "old-fact", "--review", "+30d"], { today: "2026-10-25" }).code, 0);
    assert.equal(c.run(["stale"], { today: "2026-10-25" }).out.trim(), "nothing due");
    assert.ok(c.read("old-fact").includes("confirmed: 2026-10-25"));
  });

  it("within window", () => {
    c.add("Soon", ["--review", "+10d"]);
    assert.ok(c.run(["stale", "--within", "14d"]).out.includes("soon"));
    assert.ok(!c.run(["stale", "--within", "3d"]).out.includes("soon"));
  });

  it("undated notes listed separately", () => {
    c.add("No date", ["--review", "none"]);
    assert.ok(c.run(["stale"]).out.includes("no review date: no-date"));
  });
});

describe("supersede", () => {
  const c = useCtx();

  it("superseded hidden from search and list", () => {
    c.add("Old claim", ["--body", "restart needed"]);
    c.add("New claim", ["--body", "restart not needed"]);
    assert.equal(c.run(["supersede", "old-claim", "new-claim"]).code, 0);
    assert.ok(!c.run(["search", "restart"]).out.includes("old-claim"));
    assert.ok(c.run(["search", "restart", "--all"]).out.includes("old-claim"));
    assert.ok(!c.run(["list"]).out.includes("old-claim"));
    assert.ok(c.run(["show", "old-claim"]).out.includes("STATUS: superseded by [new-claim]"));
    assert.ok(c.run(["show", "new-claim"]).out.includes("supersedes: old-claim"));
  });
});
