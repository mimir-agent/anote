import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { assert, useCtx } from "./helpers.ts";
import type { Ctx } from "./helpers.ts";

/** Write a daily log file directly, so tests control dates and times. */
function writeDaily(c: Ctx, day: string, bullets: string[]): void {
  const dir = path.join(c.tmp, "daily");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, day + ".md"), `# ${day}\n\n` + bullets.map((b) => b + "\n").join(""));
}

/** Three due notes (review dates 10-01, 10-03, 10-05), one not yet due, and five log lines over two days. */
function seed(c: Ctx): void {
  c.add("Middle overdue", ["--review", "2026-10-03"]);
  c.add("Most overdue", ["--review", "2026-10-01"]);
  c.add("Least overdue", ["--review", "2026-10-05"]);
  c.add("Not yet", ["--review", "2026-12-01"]);
  writeDaily(c, "2026-10-07", ["- 09:00 [observed] oldest line", "- 10:00 [observed] second oldest"]);
  writeDaily(c, "2026-10-08", [
    "- 08:00 [told] third line",
    "- 09:00 [observed] fourth line",
    "- 11:00 [inferred] newest line",
  ]);
}

const DUE = [
  '  most-overdue  "Most overdue"  review 2026-10-01',
  '  middle-overdue  "Middle overdue"  review 2026-10-03',
  '  least-overdue  "Least overdue"  review 2026-10-05',
];
const LOGS = [
  "  2026-10-08 11:00 [inferred] newest line",
  "  2026-10-08 09:00 [observed] fourth line",
  "  2026-10-08 08:00 [told] third line",
  "  2026-10-07 10:00 [observed] second oldest",
  "  2026-10-07 09:00 [observed] oldest line",
];

describe("brief", () => {
  const c = useCtx();

  it("prints due notes most overdue first, then log lines newest first", () => {
    seed(c);
    const r = c.run(["brief"]);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, ["due notes:", ...DUE, "log lines:", ...LOGS].join("\n") + "\n");
  });

  it("never prints more than the budget, and says how much was left out", () => {
    seed(c);
    const full = c.run(["brief"]).out.length;
    // Every 9th budget from the minimum to past the full size crosses each line boundary at least once.
    for (let budget = 200; budget <= full + 9; budget += 9) {
      const r = c.run(["brief", "--budget", String(budget)]);
      assert.equal(r.code, 0, r.err);
      assert.ok(r.out.length <= budget, `budget ${budget}: printed ${r.out.length}`);
      const lines = r.out.trimEnd().split("\n");
      const last = lines[lines.length - 1] as string;
      const shown = lines.filter((l) => DUE.includes(l) || LOGS.includes(l)).length;
      const dropped = DUE.length + LOGS.length - shown;
      if (dropped > 0) assert.equal(last, `(${dropped} more left out)`, `budget ${budget}`);
      else assert.doesNotMatch(r.out, /more left out/, `budget ${budget}`);
      // Whatever is kept is a prefix of the fill order: due notes, then log lines.
      assert.deepEqual(lines.filter((l) => DUE.includes(l) || LOGS.includes(l)), [...DUE, ...LOGS].slice(0, shown));
    }
  });

  it("drops log lines before due notes, and due notes when they alone are too long", () => {
    for (let i = 0; i < 6; i++) c.add(`Overdue note number ${i} with a fairly long title`, ["--review", `2026-10-0${i + 1}`]);
    writeDaily(c, "2026-10-08", ["- 09:00 [observed] a log line"]);
    const r = c.run(["brief", "--budget", "200"]);
    assert.equal(r.code, 0, r.err);
    assert.ok(r.out.length <= 200);
    assert.match(r.out, /overdue-note-number-0/);
    assert.doesNotMatch(r.out, /overdue-note-number-5/);
    assert.doesNotMatch(r.out, /a log line/);
    assert.match(r.out, /log lines:\n\(\d+ more left out\)\n$/);
  });

  it("leaves out the due notes header when every due note is dropped", () => {
    c.add("Overdue " + "with a very long title ".repeat(8), ["--review", "2026-10-01"]);
    writeDaily(c, "2026-10-08", ["- 09:00 [observed] a log line"]);
    const r = c.run(["brief", "--budget", "200"]);
    assert.equal(r.code, 0, r.err);
    assert.ok(r.out.length <= 200, `printed ${r.out.length}`);
    assert.equal(r.out, "log lines:\n(2 more left out)\n");
  });

  it("drops only log lines when the due notes fit", () => {
    seed(c);
    const r = c.run(["brief", "--budget", "300"]);
    assert.equal(r.code, 0, r.err);
    for (const d of DUE) assert.ok(r.out.includes(d + "\n"));
    assert.ok(r.out.includes(LOGS[0] + "\n"));
    assert.ok(!r.out.includes(LOGS[4] as string));
    assert.match(r.out, /\(\d more left out\)\n$/);
  });

  it("rejects a budget under 200 and accepts 200", () => {
    seed(c);
    const low = c.run(["brief", "--budget", "199"]);
    assert.equal(low.code, 2);
    assert.equal(low.out, "");
    assert.equal(low.err, "anote: --budget must be at least 200 characters, got 199\n");
    const ok = c.run(["brief", "--budget", "200"]);
    assert.equal(ok.code, 0, ok.err);
    assert.ok(ok.out.length <= 200);
  });

  it("empty graph prints both headers and exits 0", () => {
    const r = c.run(["brief"]);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, "due notes:\n  nothing due\nlog lines:\n  no log lines\n");
  });

  it("log lines with nothing due", () => {
    c.add("Later", ["--review", "2026-12-01"]);
    c.run(["log", "only line"]);
    const r = c.run(["brief"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /^due notes:\n  nothing due\nlog lines:\n  2026-10-09 \d\d:\d\d \[observed\] only line\n$/);
  });

  it("is listed in the main help", () => {
    assert.match(c.run(["--help"]).out, /brief +due notes and recent log lines/);
    assert.match(c.run(["brief", "--help"]).out, /roughly 4 characters per token/);
  });
});
