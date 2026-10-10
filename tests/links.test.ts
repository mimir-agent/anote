import { beforeEach, describe, it } from "node:test";
import { assert, useCtx } from "./helpers.ts";

describe("links", () => {
  const c = useCtx();
  beforeEach(() => {
    for (const t of ["Alpha", "Beta", "Gamma"]) c.add(t);
  });

  it("link shows both directions", () => {
    assert.equal(c.run(["link", "alpha", "expands-on", "beta", "--note", "more detail"]).code, 0);
    const a = c.run(["show", "alpha"]).out;
    const b = c.run(["show", "beta"]).out;
    assert.match(a, /expands-on/);
    assert.match(a, /-> beta/);
    assert.match(a, /more detail/);
    assert.match(b, /<- alpha/);
  });

  it("unknown type rejected", () => {
    const r = c.run(["link", "alpha", "befriends", "beta"]);
    assert.equal(r.code, 2);
    assert.match(r.err, /unknown link type/);
  });

  it("aliases and spaces", () => {
    c.run(["link", "alpha", "helpful background", "beta"]);
    c.run(["link", "alpha", "leads", "gamma"]);
    const out = c.run(["show", "alpha"]).out;
    assert.match(out, /helpful-background/);
    assert.match(out, /leads-to/);
  });

  it("link is idempotent and no self links", () => {
    c.run(["link", "alpha", "relates", "beta"]);
    const r = c.run(["link", "alpha", "relates", "beta"]);
    assert.match(r.out, /already linked/);
    assert.equal(c.read("alpha").split("[[beta]]").length - 1, 1);
    assert.equal(c.run(["link", "alpha", "relates", "alpha"]).code, 2);
  });

  it("unlink", () => {
    c.run(["link", "alpha", "relates", "beta"]);
    assert.equal(c.run(["unlink", "alpha", "beta"]).code, 0);
    assert.ok(!c.read("alpha").includes("[[beta]]"));
    assert.equal(c.run(["unlink", "alpha", "beta"]).code, 3);
  });

  it("add with --link flag", () => {
    c.add("Delta", ["--link", "supports:alpha"]);
    assert.ok(c.read("delta").includes("supports [[alpha]]"));
    const r = c.run(["add", "Eps", "--source", "told", "--type", "concept", "--link", "supports:nope"]);
    assert.equal(r.code, 3);
    assert.throws(() => c.read("eps"));
  });

  it("neighbors depth", () => {
    c.run(["link", "alpha", "leads-to", "beta"]);
    c.run(["link", "beta", "leads-to", "gamma"]);
    const one = c.run(["neighbors", "alpha"]).out;
    const two = c.run(["neighbors", "alpha", "--depth", "2"]).out;
    assert.ok(!one.includes("gamma"));
    assert.ok(two.includes("gamma"));
    const only = c.run(["neighbors", "beta", "--type", "leads-to", "--json"]).out;
    assert.equal(JSON.parse(only).length, 2);
  });
});
