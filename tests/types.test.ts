import * as fs from "node:fs";
import { describe, it } from "node:test";
import { assert, useCtx } from "./helpers.ts";

describe("types", () => {
  const c = useCtx();
  const addRaw = (title: string, args: string[], source = "told") => c.run(["add", title, "--source", source, ...args]);

  it("type is required", () => {
    const r = c.run(["add", "X", "--source", "told"]);
    assert.equal(r.code, 2);
    assert.ok(r.err.includes("--type"));
  });

  it("types outside the set are rejected", () => {
    for (const bad of ["trip", "meeting", "place", "note"]) {
      assert.equal(addRaw("X", ["--type", bad]).code, 2, bad);
    }
  });

  it("types lists definitions and links", () => {
    const out = c.run(["types"]).out;
    assert.ok(out.includes("assertion"));
    assert.ok(out.includes("expands-on"));
  });

  it("reference tags in order", () => {
    const r = addRaw("Essay", ["--type", "reference", "--media", "text", "--form", "article"]);
    assert.equal(r.code, 0, r.err);
    assert.ok(c.read("essay").includes("type: reference text article"));
    assert.ok(c.run(["show", "essay"]).out.includes("type: #reference #text #article"));
  });

  it("reference media alone is fine", () => {
    assert.equal(addRaw("Talk", ["--type", "reference", "--media", "audio"]).code, 0);
  });

  it("reference form must match media", () => {
    const r = addRaw("Movie", ["--type", "reference", "--media", "text", "--form", "film"]);
    assert.equal(r.code, 2);
    assert.ok(r.err.includes("goes with media"));
  });

  it("reference form needs its media tag", () => {
    const r = addRaw("Book", ["--type", "reference", "--form", "book"]);
    assert.equal(r.code, 2);
    assert.ok(r.err.includes("goes after its media tag"));
  });

  it("only references take media", () => {
    const r = addRaw("Idea", ["--type", "concept", "--media", "text"]);
    assert.equal(r.code, 2);
    assert.ok(r.err.includes("single type tag"));
  });

  it("artifact form is optional and limited", () => {
    assert.equal(addRaw("Draft", ["--type", "artifact"]).code, 0);
    assert.equal(addRaw("Post", ["--type", "artifact", "--form", "post"]).code, 0);
    assert.equal(addRaw("Odd", ["--type", "artifact", "--form", "fragment"]).code, 2);
  });

  it("hand-edited tag order is caught by check", () => {
    addRaw("Essay", ["--type", "reference", "--media", "text", "--form", "article"]);
    const p = c.notePath("essay");
    fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace("reference text article", "reference article text"));
    const r = c.run(["check"]);
    assert.equal(r.code, 1);
    assert.ok(r.out.includes("goes after its media tag"));
  });

  it("person needs the flag", () => {
    const r = addRaw("Alex", ["--type", "person"]);
    assert.equal(r.code, 2);
    assert.ok(r.err.includes("--person-ok"));
    assert.throws(() => c.read("alex"));
    assert.equal(addRaw("Alex", ["--type", "person", "--person-ok"]).code, 0);
  });

  it("cannot retype into person", () => {
    c.add("Alex");
    const r = c.run(["set", "alex", "type", "person"]);
    assert.equal(r.code, 2);
    assert.ok(r.err.includes("--person-ok"));
  });

  it("stance is for assertions only", () => {
    assert.equal(addRaw("Idea", ["--type", "concept", "--stance", "held"]).code, 2);
    assert.equal(addRaw("Claim", ["--type", "assertion", "--stance", "unheld"]).code, 0);
    assert.ok(c.run(["show", "claim"]).out.includes("stance: unheld"));
  });

  it("unstated stance says so", () => {
    addRaw("Claim", ["--type", "assertion"]);
    assert.ok(c.run(["show", "claim"]).out.includes("not anyone's position"));
  });

  it("set stance and retyping drops it", () => {
    addRaw("Claim", ["--type", "assertion"]);
    assert.equal(c.run(["set", "claim", "stance", "held"]).code, 0);
    assert.ok(c.read("claim").includes("stance: held"));
    assert.equal(c.run(["set", "claim", "type", "question"]).code, 0);
    assert.ok(!c.read("claim").includes("stance:"));
    assert.equal(c.run(["set", "claim", "stance", "held"]).code, 2);
  });
});

describe("type rules", () => {
  const c = useCtx();

  it("fragment must link to a reference", () => {
    c.add("Essay", ["--type", "reference", "--media", "text"]);
    c.add("Wear shows use", ["--type", "fragment"]);
    const r = c.run(["check"]);
    assert.equal(r.code, 1);
    assert.ok(r.out.includes("must link back to the reference"));
    c.run(["link", "wear-shows-use", "references", "essay"]);
    assert.equal(c.run(["check"]).code, 0);
  });

  it("fragment linked to a non-reference still fails", () => {
    c.add("Other");
    c.add("Piece", ["--type", "fragment", "--link", "references:other"]);
    assert.equal(c.run(["check"]).code, 1);
  });

  it("question with competing assertions", () => {
    c.add("Wear in software?", ["--type", "question"]);
    c.add("Software can show wear", ["--type", "assertion", "--stance", "held", "--link", "addresses:wear-in-software"]);
    c.add("Software should not show wear", ["--type", "assertion", "--stance", "held", "--link", "addresses:wear-in-software"]);
    c.run(["link", "software-should-not-show-wear", "opposes", "software-can-show-wear"]);
    const out = c.run(["neighbors", "wear-in-software", "--type", "addresses"]).out;
    assert.ok(out.includes("software-can-show-wear"));
    assert.ok(out.includes("software-should-not-show-wear"));
    assert.equal(c.run(["check"]).code, 0);
  });

  it("list and search filter by type", () => {
    c.add("Open one", ["--type", "question", "--body", "shared word"]);
    c.add("Claim one", ["--type", "assertion", "--body", "shared word"]);
    const listed = c.run(["list", "--type", "question"]).out;
    assert.ok(listed.includes("open-one"));
    assert.ok(!listed.includes("claim-one"));
    const found = c.run(["search", "shared", "--type", "assertion"]).out;
    assert.ok(found.includes("claim-one"));
    assert.ok(!found.includes("open-one"));
  });
});

describe("promote", () => {
  const c = useCtx();

  it("promote keeps source and leaves a trail", () => {
    c.run(["log", "roots need water", "--source", "inferred"]);
    assert.ok(c.run(["show", "2026-10-09"]).out.includes("[1] - "));
    const r = c.run(["promote", "2026-10-09", "1", "Roots need water", "--type", "assertion"]);
    assert.equal(r.code, 0, r.err);
    const text = c.read("roots-need-water");
    assert.ok(text.includes("source: inferred"));
    assert.ok(text.includes("roots need water"));
    assert.ok(c.run(["show", "2026-10-09"]).out.includes("promoted line 1"));
  });

  it("promote needs a real line, a type and a day", () => {
    c.run(["log", "something"]);
    assert.equal(c.run(["promote", "2026-10-09", "9", "T", "--type", "concept"]).code, 3);
    assert.equal(c.run(["promote", "2026-10-09", "1", "T"]).code, 2);
    assert.equal(c.run(["promote", "2026-10-08", "1", "T", "--type", "concept"]).code, 3);
    assert.throws(() => c.read("t"));
  });
});
