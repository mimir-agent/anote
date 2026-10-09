// Test helpers: run the real CLI against a throwaway notes directory.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as assert from "node:assert/strict";
import { afterEach, beforeEach } from "node:test";

const MAIN = path.resolve(import.meta.dirname, "..", "src", "main.ts");

export interface Run {
  code: number;
  out: string;
  err: string;
}

export class Ctx {
  tmp = "";
  today = "2026-10-09";

  run(args: string[], opts: { today?: string; stdin?: string } = {}): Run {
    const env = { ...process.env, ANOTE_GRAPH: this.tmp, ANOTE_TODAY: opts.today ?? this.today };
    const r = spawnSync("node", ["--disable-warning=ExperimentalWarning", MAIN, ...args], {
      env, input: opts.stdin ?? "", encoding: "utf8",
    });
    return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
  }

  /** Add a note and assert success. Defaults: source observed, type concept. */
  add(title: string, extra: string[] = [], source = "observed", type = "concept"): string {
    const args = ["add", title, "--source", source];
    if (!extra.includes("--type")) args.push("--type", type);
    const r = this.run([...args, ...extra]);
    assert.equal(r.code, 0, r.err);
    return r.out;
  }

  notePath(slug: string): string {
    return path.join(this.tmp, "notes", slug + ".md");
  }

  read(slug: string): string {
    return fs.readFileSync(this.notePath(slug), "utf8");
  }
}

/** Create a Ctx with a fresh temp directory for each test. */
export function useCtx(): Ctx {
  const ctx = new Ctx();
  beforeEach(() => {
    ctx.tmp = fs.mkdtempSync(path.join(os.tmpdir(), "anote-test-"));
  });
  afterEach(() => {
    fs.rmSync(ctx.tmp, { recursive: true, force: true });
  });
  return ctx;
}

export { assert };
