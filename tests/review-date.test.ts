import * as fs from "node:fs";
import { describe, it } from "node:test";
import { assert, useCtx } from "./helpers.ts";

const MSG = "anote: bad: review is not a date: 'soon' (run anote check)\n";

describe("bad review date in a hand-edited note", () => {
  const c = useCtx();

  function setReview(value: string): void {
    c.add("Bad");
    const p = c.notePath("bad");
    fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace(/review: .*/, "review: " + value));
  }

  it("show fails with a named error, no stack trace", () => {
    setReview("soon");
    const r = c.run(["show", "bad"]);
    assert.equal(r.code, 1);
    assert.equal(r.err, MSG);
  });

  it("stale fails with a named error, no stack trace", () => {
    setReview("soon");
    const r = c.run(["stale"]);
    assert.equal(r.code, 1);
    assert.equal(r.err, MSG);
  });

  it("stale rejects a malformed date that would sort before the cutoff as text", () => {
    setReview("2026-9-1");
    const r = c.run(["stale"]);
    assert.equal(r.code, 1);
    assert.ok(r.err.includes("review is not a date: '2026-9-1'"));
  });

  it("check still reports the same date", () => {
    setReview("soon");
    assert.ok(c.run(["check"]).out.includes("review is not a date: soon"));
  });
});
