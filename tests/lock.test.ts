// The graph lock: concurrent writers all land, a held lock fails fast, failures release it.
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { assert, useCtx } from "./helpers.ts";
import type { Run } from "./helpers.ts";

const MAIN = path.resolve(import.meta.dirname, "..", "src", "main.ts");
const NODE_ARGS = ["--disable-warning=ExperimentalWarning", MAIN];

describe("graph lock", () => {
  const ctx = useCtx();
  const lockPath = () => path.join(ctx.tmp, ".lock");
  const env = (extra: Record<string, string> = {}) => ({
    ...process.env, ANOTE_GRAPH: ctx.tmp, ANOTE_TODAY: ctx.today, ...extra,
  });

  function runAsync(args: string[]): Promise<Run> {
    return new Promise((resolve) => {
      const child = spawn("node", [...NODE_ARGS, ...args], { env: env() });
      let out = "";
      let err = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (err += d));
      child.on("close", (code) => resolve({ code: code ?? -1, out, err }));
    });
  }

  it("keeps every concurrent append and link", async () => {
    ctx.add("hub");
    const slugs = Array.from({ length: 8 }, (_, i) => `n${i}`);
    for (const s of slugs) ctx.add(s);
    const jobs: Promise<Run>[] = [];
    for (let i = 0; i < 24; i++) {
      jobs.push(runAsync(["append", "hub", `same note text ${i}.`]));
      jobs.push(runAsync(["append", slugs[i % slugs.length] as string, `other text ${i}.`]));
    }
    for (const s of slugs) jobs.push(runAsync(["link", "hub", "relates", s]));
    for (const r of await Promise.all(jobs)) assert.equal(r.code, 0, r.err);
    const hub = ctx.read("hub");
    for (let i = 0; i < 24; i++) {
      assert.ok(hub.includes(`same note text ${i}.`), `hub lost append ${i}`);
      assert.ok(ctx.read(slugs[i % slugs.length] as string).includes(`other text ${i}.`), `lost other append ${i}`);
    }
    assert.equal((hub.match(/relates/g) ?? []).length, slugs.length);
    assert.equal(ctx.run(["check"]).code, 0);
    assert.equal(fs.existsSync(lockPath()), false);
  });

  it("keeps every concurrent log line", async () => {
    const rs = await Promise.all(Array.from({ length: 24 }, (_, i) => runAsync(["log", `line ${i}.`])));
    for (const r of rs) assert.equal(r.code, 0, r.err);
    const daily = fs.readFileSync(path.join(ctx.tmp, "daily", ctx.today + ".md"), "utf8");
    const bullets = daily.split("\n").filter((l) => l.startsWith("- "));
    assert.equal(bullets.length, 24);
    for (let i = 0; i < 24; i++) assert.equal(bullets.filter((b) => b.endsWith(` line ${i}.`)).length, 1);
  });

  it("fails fast with a named message when the lock is held", () => {
    ctx.add("alpha");
    const before = ctx.read("alpha");
    fs.mkdirSync(lockPath());
    const t0 = Date.now();
    const r = spawnSync("node", [...NODE_ARGS, "set", "alpha", "review", "+7d"], {
      env: env({ ANOTE_LOCK_TIMEOUT_MS: "300" }), encoding: "utf8",
    });
    assert.ok(Date.now() - t0 < 3000);
    assert.equal(r.status, 1);
    assert.equal(
      r.stderr,
      `anote: graph is locked (${lockPath()}); another anote is writing. If none is running, remove that directory.\n`,
    );
    assert.equal(ctx.read("alpha"), before);
    assert.equal(fs.existsSync(lockPath()), true); // not ours, left alone
  });

  it("releases the lock when a command dies", () => {
    ctx.add("alpha");
    assert.equal(ctx.run(["set", "missing", "review", "+7d"]).code, 3);
    assert.equal(fs.existsSync(lockPath()), false);
    assert.equal(ctx.run(["set", "alpha", "nonsense", "x"]).code, 2);
    assert.equal(fs.existsSync(lockPath()), false);
    assert.equal(ctx.run(["append", "alpha", "still works"]).code, 0);
  });

  it("check passes with a stray lock present", () => {
    ctx.add("alpha");
    fs.mkdirSync(lockPath());
    assert.equal(ctx.run(["check"]).code, 0);
  });
});
