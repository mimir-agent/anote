// A fact changes: search shows the newer entry first, and log lines promoted to
// a note that has since been superseded say so and name the replacement.
import { describe, it } from "node:test";
import { assert, useCtx, type Ctx } from "./helpers.ts";

const BERLIN = "Alex works from the Berlin office";
const LISBON = "Alex moved to the Lisbon office this week";
const MARK = "(superseded: alex-is-in-berlin by alex-is-in-lisbon)";

function ok(c: Ctx, args: string[], today?: string): string {
  const r = c.run(args, today ? { today } : {});
  assert.equal(r.code, 0, r.err);
  return r.out;
}

/** Two log days that match the same words equally. */
function alexLogs(c: Ctx): void {
  ok(c, ["log", BERLIN, "--source", "told"], "2026-10-01");
  ok(c, ["log", LISBON, "--source", "told"], "2026-10-15");
}

/** Promote both lines on 2026-10-19 and supersede Berlin with Lisbon. */
function alexSuperseded(c: Ctx): void {
  alexLogs(c);
  ok(c, ["promote", "2026-10-01", "1", "Alex is in Berlin", "--type", "assertion"], "2026-10-19");
  ok(c, ["promote", "2026-10-15", "1", "Alex is in Lisbon", "--type", "assertion"], "2026-10-19");
  ok(c, ["supersede", "alex-is-in-berlin", "alex-is-in-lisbon"], "2026-10-19");
}

describe("knowledge update", () => {
  const c = useCtx();

  it("equal scores list the newest log day first", () => {
    alexLogs(c);
    const rows = JSON.parse(ok(c, ["search", "Alex", "office", "--json"]));
    assert.deepEqual(rows.map((r: { slug: string }) => r.slug), ["daily/2026-10-15", "daily/2026-10-01"]);
    assert.equal(rows[0].score, rows[1].score);
    const text = ok(c, ["search", "Alex", "office"]).split("\n");
    assert.ok((text[0] as string).startsWith("daily/2026-10-15"));
  });

  it("equal scores list the most recently updated note first", () => {
    ok(c, ["add", "Aaa office note", "--source", "told", "--type", "concept"], "2026-10-01");
    ok(c, ["add", "Zzz office note", "--source", "told", "--type", "concept"], "2026-10-15");
    const rows = JSON.parse(ok(c, ["search", "office", "--json"]));
    assert.deepEqual(rows.map((r: { slug: string }) => r.slug), ["zzz-office-note", "aaa-office-note"]);
  });

  it("a budget that fits one result keeps the newest", () => {
    alexLogs(c);
    const rows = JSON.parse(ok(c, ["search", "Alex", "office", "--budget", "30", "--json"]));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].slug, "daily/2026-10-15");
  });

  it("search marks a superseded log line and still returns it", () => {
    alexSuperseded(c);
    const lines = ok(c, ["search", "Berlin"]).split("\n");
    const at = lines.findIndex((l) => l.startsWith("daily/2026-10-01 "));
    assert.ok(at >= 0, lines.join("\n"));
    assert.ok((lines[at + 1] as string).includes(BERLIN));
    assert.equal(lines[at + 2], `    line 1 ${MARK}`);
    assert.ok(!lines.some((l) => l.startsWith("alex-is-in-berlin ")), "the superseded note stays out of search");
  });

  it("search --json adds superseded after the existing keys", () => {
    alexSuperseded(c);
    const rows = JSON.parse(ok(c, ["search", "Berlin", "--json"]));
    const day = rows.find((r: { slug: string }) => r.slug === "daily/2026-10-01");
    assert.deepEqual(Object.keys(day), [
      "slug", "title", "tags", "kind", "source", "updated", "status", "review", "score", "snippet", "superseded",
      "line",
    ]);
    assert.deepEqual(day.superseded, [{ line: 1, note: "alex-is-in-berlin", by: "alex-is-in-lisbon" }]);
    const note = JSON.parse(ok(c, ["search", "Lisbon", "--json"]))
      .find((r: { slug: string }) => r.slug === "alex-is-in-lisbon");
    assert.deepEqual(Object.keys(note), [
      "slug", "title", "tags", "kind", "type", "source", "updated", "status", "review", "score", "snippet",
      "superseded",
    ]);
    assert.deepEqual(note.superseded, []);
  });

  it("show DATE marks the superseded line and leaves the others as they were", () => {
    alexSuperseded(c);
    ok(c, ["log", "Alex likes coffee", "--source", "told"], "2026-10-01");
    const lines = ok(c, ["show", "2026-10-01"]).split("\n");
    const one = lines.find((l) => l.startsWith("[1] "));
    const two = lines.find((l) => l.startsWith("[2] "));
    assert.match(one as string, /^\[1\] - \d{2}:\d{2} \[told\] /);
    assert.ok((one as string).endsWith(`${BERLIN}  ${MARK}`), one);
    assert.match(two as string, /^\[2\] - \d{2}:\d{2} \[told\] Alex likes coffee$/);
    const json = JSON.parse(ok(c, ["show", "2026-10-01", "--json"]));
    assert.deepEqual(Object.keys(json), ["daily", "content", "superseded"]);
    assert.deepEqual(json.superseded, [{ line: 1, note: "alex-is-in-berlin", by: "alex-is-in-lisbon" }]);
    assert.ok(!(json.content as string).includes("superseded"), "content is the file as written");
  });

  it("a chain of two supersedes names the final note", () => {
    alexSuperseded(c);
    ok(c, ["log", "Alex moved again, to the Porto office", "--source", "told"], "2026-10-16");
    ok(c, ["promote", "2026-10-16", "1", "Alex is in Porto", "--type", "assertion"], "2026-10-19");
    ok(c, ["supersede", "alex-is-in-lisbon", "alex-is-in-porto"], "2026-10-19");
    assert.ok(ok(c, ["show", "2026-10-01"]).includes("(superseded: alex-is-in-berlin by alex-is-in-porto)"));
    assert.ok(ok(c, ["show", "2026-10-15"]).includes("(superseded: alex-is-in-lisbon by alex-is-in-porto)"));
    const rows = JSON.parse(ok(c, ["search", "Berlin", "--json"]));
    const day = rows.find((r: { slug: string }) => r.slug === "daily/2026-10-01");
    assert.deepEqual(day.superseded, [{ line: 1, note: "alex-is-in-berlin", by: "alex-is-in-porto" }]);
  });

  it("a dangling trail shows nothing and does not error", () => {
    alexLogs(c);
    ok(c, ["add", "Alex is somewhere", "--source", "told", "--type", "assertion"], "2026-10-19");
    // Missing note, line out of range, a day with no log, and an active note.
    ok(c, ["log", "promoted line 1 of 2026-10-01 to [[no-such-note]]", "--source", "observed"], "2026-10-19");
    ok(c, ["log", "promoted line 9 of 2026-10-01 to [[alex-is-somewhere]]", "--source", "observed"], "2026-10-19");
    ok(c, ["log", "promoted line 1 of 2026-09-30 to [[alex-is-somewhere]]", "--source", "observed"], "2026-10-19");
    ok(c, ["log", "promoted line 1 of 2026-10-15 to [[alex-is-somewhere]]", "--source", "observed"], "2026-10-19");
    for (const day of ["2026-10-01", "2026-10-15", "2026-10-19"]) {
      assert.ok(!ok(c, ["show", day]).includes("(superseded:"), day);
    }
    assert.ok(!ok(c, ["search", "Alex", "office"]).includes("(superseded:"));
    const rows = JSON.parse(ok(c, ["search", "Alex", "--json"]));
    for (const r of rows) assert.deepEqual(r.superseded, [], r.slug);
  });
});
