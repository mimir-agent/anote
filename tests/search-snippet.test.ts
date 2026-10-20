// A daily log hit shows its best-matching log line and that line's number, for
// `anote promote`. Ranking, scores and note snippets stay as they were.
// Invented backup graph from the search-quality spec (section 4), written as plain files.
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { assert, useCtx, type Ctx } from "./helpers.ts";

interface Row {
  slug: string;
  score: number;
  snippet: string;
  line?: number;
}

const NOTES: Array<[string, string, string, string, string, string]> = [
  ["backup-schedule", "Backup schedule", "protocol", "2026-09-02", "ops",
    "Nightly backups run at 02:00 from launchd. Retention is 14 days. Check the backup log in the morning."],
  ["npm-token", "npm token", "concept", "2026-08-10", "release",
    "The npm token lives in the keychain. Trusted Publishing replaced it for releases."],
  ["restore-drill", "Restore drill", "protocol", "2026-10-01", "ops",
    "To restore: stop the service, copy the snapshot back, start the service, then check the status page."],
  ["deploy-checklist", "Deploy checklist", "protocol", "2026-09-20", "ops",
    "Before each deploy: run tests, tag, push. After: watch status for ten minutes. Rollback if the error rate rises."],
  ["status-page", "Status page", "concept", "2026-07-01", "ops",
    "The status page shows uptime, the last deploy date and that the database is reachable. Updated automatically " +
    "by the health check at the start of every hour; it states the latest state of each service."],
  ["mac-mini", "Mac mini", "concept", "2026-06-15", "infra",
    "The Mac mini hosts the gateway, cron jobs and the backup disk. It restarts after updates."],
];

const DAY_15 = [
  "# 2026-10-15",
  "",
  "- 09:02 [observed] backup ran clean, 14 snapshots on disk",
  "- 09:40 [observed] gateway restarted after macOS update",
  "- 10:15 [told] Mir wants the brief cut to 2000 characters",
  "- 11:30 [observed] npm publish staged from v0.3.0 tag",
  "- 13:05 [observed] cron job for anote brief moved to 08:55",
  "- 14:20 [observed] disk at 71 percent",
  "- 15:45 [observed] restore from backup failed: snapshot older than retention, had to use the weekly copy",
  "- 16:10 [inferred] retention of 14 days is too short for a restore after a long weekend",
  "",
].join("\n");

const DAY_17 = ["# 2026-10-17", "", "- 09:00 [observed] backup ran clean", "- 10:00 [observed] deploys paused for the weekend", ""]
  .join("\n");

const LINE_7 = "line 7: 15:45 [observed] restore from backup failed: snapshot older than retention, had to use the weekly copy";

function fixture(c: Ctx): void {
  fs.mkdirSync(path.join(c.tmp, "notes"));
  fs.mkdirSync(path.join(c.tmp, "daily"));
  for (const [slug, title, type, date, tag, body] of NOTES) {
    const text = [
      "---", `title: ${title}`, `type: ${type}`, `created: ${date}`, `updated: ${date}`, "source: observed",
      "review: 2026-12-30", "status: active", `tags: [${tag}]`, "---", "", body, "",
    ].join("\n");
    fs.writeFileSync(path.join(c.tmp, "notes", slug + ".md"), text);
  }
  fs.writeFileSync(path.join(c.tmp, "daily", "2026-10-15.md"), DAY_15);
  fs.writeFileSync(path.join(c.tmp, "daily", "2026-10-17.md"), DAY_17);
}

function ok(c: Ctx, args: string[]): string {
  const r = c.run(args);
  assert.equal(r.code, 0, r.err);
  return r.out;
}

function rows(c: Ctx, words: string[]): Row[] {
  return JSON.parse(ok(c, ["search", ...words, "--json"])) as Row[];
}

/** The snippet line printed under each hit, by slug, from the text output. */
function textSnippets(out: string): Map<string, string> {
  const m = new Map<string, string>();
  const lines = out.split("\n");
  for (const [i, l] of lines.entries()) {
    if (l !== "" && !l.startsWith("    ")) m.set(l.split("  ")[0] as string, (lines[i + 1] as string).slice(4));
  }
  return m;
}

describe("search snippet for daily logs", () => {
  const c = useCtx();

  it("Q1: restore backup shows line 7 of the day and keeps the order", () => {
    fixture(c);
    const r = rows(c, ["restore", "backup"]);
    assert.deepEqual(r.map((x) => [x.slug, x.score]), [
      ["daily/2026-10-15", 7], ["backup-schedule", 7], ["restore-drill", 6], ["daily/2026-10-17", 1], ["mac-mini", 1],
    ]);
    assert.equal(r[0]?.snippet, LINE_7);
    assert.equal(r[0]?.line, 7);
    assert.equal(r[3]?.snippet, "line 1: 09:00 [observed] backup ran clean");
    assert.equal(r[3]?.line, 1);
    for (const x of [r[1], r[2], r[4]]) assert.equal(x?.line, undefined, x?.slug);
    assert.ok(!Object.keys(r[1] as Row).includes("line"), "note rows carry no line key");
    const text = textSnippets(ok(c, ["search", "restore", "backup"]));
    assert.equal(text.get("daily/2026-10-15"), LINE_7);
    assert.equal(text.get("daily/2026-10-17"), "line 1: 09:00 [observed] backup ran clean");
  });

  it("Q1: note snippets stay the body window", () => {
    fixture(c);
    const r = rows(c, ["restore", "backup"]);
    assert.equal(r[1]?.snippet,
      "Nightly backups run at 02:00 from launchd. Retention is 14 days. Check the backup log in the morning.");
    assert.equal(r[4]?.snippet, "...ni hosts the gateway, cron jobs and the backup disk. It restarts after updates.");
  });

  it("Q2: snapshot restore failed picks the line with the most distinct words", () => {
    fixture(c);
    const r = rows(c, ["snapshot", "restore", "failed"]);
    assert.deepEqual(r.map((x) => [x.slug, x.score]), [["daily/2026-10-15", 8], ["restore-drill", 7]]);
    assert.equal(r[0]?.snippet, LINE_7);
    assert.equal(r[0]?.line, 7);
    const text = ok(c, ["search", "snapshot", "restore", "failed"]);
    assert.equal(textSnippets(text).get("daily/2026-10-15"), LINE_7);
  });

  it("Q3: a tie goes to the latest line", () => {
    fixture(c);
    const r = rows(c, ["retention"]);
    assert.deepEqual(r.map((x) => [x.slug, x.score]), [["daily/2026-10-15", 5], ["backup-schedule", 4]]);
    assert.equal(r[0]?.snippet,
      "line 8: 16:10 [inferred] retention of 14 days is too short for a restore after a long weekend");
    assert.equal(r[0]?.line, 8);
  });

  it("Q4: a hit on the heading only keeps the body window and has no line", () => {
    fixture(c);
    const r = rows(c, ["2026-10-15"]);
    assert.deepEqual(r.map((x) => [x.slug, x.score]), [["daily/2026-10-15", 9]]);
    assert.ok((r[0]?.snippet as string).startsWith("# 2026-10-15 - 09:02 [observed] backup ran clean"));
    assert.ok(!Object.keys(r[0] as Row).includes("line"));
    const text = textSnippets(ok(c, ["search", "2026-10-15"]));
    assert.ok((text.get("daily/2026-10-15") as string).startsWith("# 2026-10-15 - 09:02"));
  });

  it("a log line over 140 characters is cut by the window rule", () => {
    fixture(c);
    const long = "- 17:00 [observed] " + "padding words here ".repeat(6) + "the zebra crossing at the depot " +
      "filler text again ".repeat(6);
    fs.appendFileSync(path.join(c.tmp, "daily", "2026-10-17.md"), long + "\n");
    const r = rows(c, ["zebra"]);
    const s = r[0]?.snippet as string;
    assert.equal(r[0]?.line, 3);
    assert.ok(s.startsWith("line 3: ..."), s);
    assert.ok(s.endsWith("..."), s);
    assert.ok(s.includes("zebra"), s);
    assert.equal(s.length, "line 3: ".length + 3 + 140 + 3);
  });
});
