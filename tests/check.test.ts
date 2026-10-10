import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { assert, useCtx } from "./helpers.ts";

describe("check", () => {
  const c = useCtx();

  it("clean graph passes", () => {
    c.add("A");
    c.add("B", ["--link", "relates:a"]);
    assert.equal(c.run(["check"]).code, 0);
  });

  it("broken link fails", () => {
    c.add("A");
    const p = c.notePath("a");
    fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace("status: active\n", "status: active\nlinks:\n  - relates [[ghost]]\n"));
    const r = c.run(["check"]);
    assert.equal(r.code, 1);
    assert.ok(r.out.includes("link to missing note 'ghost'"));
  });

  it("missing source and bad date fail", () => {
    fs.mkdirSync(path.join(c.tmp, "notes"), { recursive: true });
    fs.writeFileSync(path.join(c.tmp, "notes", "bad.md"), "---\ntitle: Bad\nreview: soon\n---\nbody\n");
    const r = c.run(["check"]);
    assert.equal(r.code, 1);
    assert.ok(r.out.includes("source is missing"));
    assert.ok(r.out.includes("review is not a date"));
  });

  it("unparseable file reported not crashed", () => {
    fs.mkdirSync(path.join(c.tmp, "notes"), { recursive: true });
    fs.writeFileSync(path.join(c.tmp, "notes", "junk.md"), "no frontmatter here\n");
    const r = c.run(["check"]);
    assert.equal(r.code, 1);
    assert.ok(r.out.includes("no frontmatter"));
  });

  it("warns on orphans and missing wikilinks", () => {
    c.add("Lonely", ["--body", "see [[Nowhere]]"]);
    const out = c.run(["check"]).out;
    assert.ok(out.includes("no links in or out"));
    assert.ok(out.includes("[[Nowhere]]"));
  });
});

describe("file format", () => {
  const c = useCtx();

  it("rewrite is stable", () => {
    c.add("Stable", ["--body", "line one\n\nline two", "--tag", "a,b"]);
    c.add("Other");
    c.run(["link", "stable", "relates", "other", "--note", "same topic"]);
    const before = c.read("stable");
    c.run(["set", "stable", "version", "v1"]);
    c.run(["set", "stable", "version", "v1"]);
    const after = c.read("stable");
    assert.equal(after.split("version: v1").length - 1, 1);
    assert.ok(after.includes("relates [[other]] | same topic"));
    assert.ok(after.includes("line one\n\nline two"));
    assert.equal(before.split("links:")[1], after.split("links:")[1]);
  });

  it("no stray temp files", () => {
    c.add("A");
    c.add("B");
    c.run(["link", "a", "relates", "b"]);
    const leftovers = fs.readdirSync(path.join(c.tmp, "notes")).filter((n) => n.startsWith("."));
    assert.deepEqual(leftovers, []);
  });
});
