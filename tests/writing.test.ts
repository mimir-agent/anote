import { describe, it } from "node:test";
import { assert, useCtx } from "./helpers.ts";

describe("writing", () => {
  const c = useCtx();

  it("source is required", () => {
    const r = c.run(["add", "No source", "--type", "concept"]);
    assert.equal(r.code, 2);
    assert.match(r.err, /--source/);
  });

  it("add then show", () => {
    c.add("Cron falls back to email", ["--body", "It went to Gmail.", "--version", "hermes 0.19.0", "--tag", "cron,delivery"]);
    const r = c.run(["show", "cron-falls-back-to-email"]);
    assert.equal(r.code, 0);
    assert.match(r.out, /# Cron falls back to email/);
    assert.match(r.out, /source: observed/);
    assert.match(r.out, /version: hermes 0\.19\.0/);
    assert.match(r.out, /It went to Gmail\./);
    assert.match(r.out, /tags: cron, delivery/);
  });

  it("default review depends on source", () => {
    c.add("A", [], "inferred");
    c.add("B", [], "told");
    assert.match(c.read("a"), /review: 2026-11-08/);
    assert.match(c.read("b"), /review: 2027-04-07/);
  });

  it("review none removes the date", () => {
    c.add("A", ["--review", "none"]);
    assert.doesNotMatch(c.read("a"), /review:/);
  });

  it("duplicate slug refused", () => {
    c.add("Same");
    const r = c.run(["add", "Same", "--source", "told", "--type", "concept"]);
    assert.equal(r.code, 2);
    assert.match(r.err, /already exists/);
  });

  it("append and set", () => {
    c.add("A", ["--body", "one"]);
    assert.equal(c.run(["append", "a", "two"]).code, 0);
    assert.equal(c.run(["set", "a", "version", "x 1.0"]).code, 0);
    const out = c.run(["show", "a"]).out;
    assert.ok(out.includes("one\n\ntwo"));
    assert.match(out, /version: x 1\.0/);
    assert.equal(c.run(["set", "a", "source", "bogus"]).code, 2);
  });

  it("body from stdin", () => {
    const r = c.run(["add", "Piped", "--source", "told", "--type", "concept", "--body", "-"], { stdin: "from stdin\n" });
    assert.equal(r.code, 0, r.err);
    assert.match(c.run(["show", "piped"]).out, /from stdin/);
  });
});
