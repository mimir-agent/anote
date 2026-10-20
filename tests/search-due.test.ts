// Search marks note hits whose review date is today or earlier with " (due)",
// the same rule as dueNotes() for stale and brief. Ranking and --json stay as
// they were. Invented kettle graph, today 2026-10-19.
import * as fs from "node:fs";
import { describe, it } from "node:test";
import { assert, useCtx, type Ctx } from "./helpers.ts";

const TODAY = "2026-10-19";

function ok(c: Ctx, args: string[]): string {
  const r = c.run(args, { today: TODAY });
  assert.equal(r.code, 0, r.err);
  return r.out;
}

/** The kettle graph from the spec (section 4). */
function kettle(c: Ctx): void {
  const add = (title: string, review: string, body: string): void => {
    ok(c, ["add", title, "--source", "observed", "--type", "concept", "--review", review, "--body", body]);
  };
  add("Kettle descales monthly", "2026-10-01", "Vinegar rinse once a month.");
  add("Kettle filter brand", "2026-11-30", "The mesh filter is a spare part.");
  add("Kettle warranty card", "none", "Card is in the drawer.");
  add("Kettle manual page", TODAY, "Page four covers the lid.");
  add("Kettle old model", "2026-09-01", "The old one had no filter.");
  add("Kettle bad date", "2026-12-01", "Review was edited by hand.");
  const p = c.notePath("kettle-bad-date");
  fs.writeFileSync(p, fs.readFileSync(p, "utf8").replace(/review: .*/, "review: soon"));
  ok(c, ["supersede", "kettle-old-model", "kettle-filter-brand"]);
  const r = c.run(["log", "kettle making a clicking noise"], { today: "2026-10-18" });
  assert.equal(r.code, 0, r.err);
}

/** slug -> hit line, from the text output. */
function hitLines(out: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const line of out.split("\n")) {
    if (line === "" || line.startsWith("    ")) continue;
    m.set(line.split("  ")[0] as string, line);
  }
  return m;
}

// Captured from main (fc8c63a) on this graph, before the marker existed.
// Every note hit ties on score and updated date, so they sort by slug.
const ORDER_MAIN = [
  "kettle-bad-date",
  "kettle-descales-monthly",
  "kettle-filter-brand",
  "kettle-manual-page",
  "kettle-warranty-card",
  "daily/2026-10-18",
];
const ORDER_ALL_MAIN = [
  "kettle-bad-date",
  "kettle-descales-monthly",
  "kettle-filter-brand",
  "kettle-manual-page",
  "kettle-old-model",
  "kettle-warranty-card",
  "daily/2026-10-18",
];
const NOTE_KEYS_MAIN = [
  "slug", "title", "tags", "kind", "type", "source", "updated", "status", "review", "score", "snippet", "superseded",
];
const DAILY_KEYS_MAIN = [
  "slug", "title", "tags", "kind", "source", "updated", "status", "review", "score", "snippet", "superseded",
];

describe("search: (due) marker", () => {
  const c = useCtx();

  it("past and today hits carry (due); future, none, bad date and daily do not", () => {
    kettle(c);
    const r = c.run(["search", "kettle"], { today: TODAY });
    assert.equal(r.code, 0, r.err);
    const hits = hitLines(r.out);
    assert.equal(hits.get("kettle-descales-monthly"), `kettle-descales-monthly  "Kettle descales monthly" (due)  [observed, ${TODAY}]`);
    assert.equal(hits.get("kettle-manual-page"), `kettle-manual-page  "Kettle manual page" (due)  [observed, ${TODAY}]`);
    assert.equal(hits.get("kettle-filter-brand"), `kettle-filter-brand  "Kettle filter brand"  [observed, ${TODAY}]`);
    assert.equal(hits.get("kettle-warranty-card"), `kettle-warranty-card  "Kettle warranty card"  [observed, ${TODAY}]`);
    assert.equal(hits.get("kettle-bad-date"), `kettle-bad-date  "Kettle bad date"  [observed, ${TODAY}]`);
    assert.equal(hits.get("daily/2026-10-18"), `daily/2026-10-18  "2026-10-18"  [log, 2026-10-18]`);
    assert.ok(!hits.has("kettle-old-model"));
  });

  it("the snippet line under a due hit is unchanged", () => {
    kettle(c);
    const lines = ok(c, ["search", "kettle"]).split("\n");
    const i = lines.findIndex((l) => l.startsWith("kettle-descales-monthly  "));
    assert.equal(lines[i + 1], "    Vinegar rinse once a month.");
  });

  it("--all: a superseded note past review shows (superseded) only", () => {
    kettle(c);
    const hits = hitLines(ok(c, ["search", "kettle", "--all"]));
    assert.equal(hits.get("kettle-old-model"), `kettle-old-model  "Kettle old model" (superseded)  [observed, ${TODAY}]`);
  });

  it("result order equals main, with and without --all", () => {
    kettle(c);
    assert.deepEqual([...hitLines(ok(c, ["search", "kettle"])).keys()], ORDER_MAIN);
    assert.deepEqual([...hitLines(ok(c, ["search", "kettle", "--all"])).keys()], ORDER_ALL_MAIN);
    const rows = JSON.parse(ok(c, ["search", "kettle", "--json"])) as Array<{ slug: string }>;
    assert.deepEqual(rows.map((r) => r.slug), ORDER_MAIN);
  });

  it("--json keys equal main for note and daily rows, with no due key", () => {
    kettle(c);
    const rows = JSON.parse(ok(c, ["search", "kettle", "--all", "--json"])) as Array<Record<string, unknown>>;
    for (const row of rows) {
      assert.deepEqual(Object.keys(row), row["kind"] === "daily" ? DAILY_KEYS_MAIN : NOTE_KEYS_MAIN);
      assert.ok(!("due" in row));
    }
    assert.ok(rows.some((r) => r["kind"] === "daily"));
    const bad = rows.find((r) => r["slug"] === "kettle-bad-date");
    assert.equal(bad?.["review"], "soon");
  });

  it("--budget counts the marker: a due hit costs 6 more characters", () => {
    kettle(c);
    const rows = (b: number): string[] =>
      (JSON.parse(ok(c, ["search", "descales", "manual", "--budget", String(b), "--json"])) as Array<{ slug: string }>)
        .map((r) => r.slug);
    // Both hits are due. Cost is floor((slug + title + snippet + 30 + 6) / 4):
    // descales (23 + 23 + 27 + 36) / 4 = 27, manual (18 + 18 + 25 + 36) / 4 = 24.
    // Main, without the 6, admitted both at 25 + 22 = 47.
    assert.deepEqual(rows(47), ["kettle-descales-monthly"]);
    assert.deepEqual(rows(50), ["kettle-descales-monthly"]);
    assert.deepEqual(rows(51), ["kettle-descales-monthly", "kettle-manual-page"]);
  });
});
