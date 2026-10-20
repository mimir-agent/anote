// anote hook codex. Every run gets a temp HOME with CODEX_HOME unset unless a
// test sets it, and ANOTE_GRAPH points at a directory that must never be
// created. Hooks file content is invented.
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { assert, snapshot } from "./helpers.ts";
import type { Run } from "./helpers.ts";

const MAIN = path.resolve(import.meta.dirname, "..", "src", "main.ts");

let tmp = "";
let home = "";
let graph = "";

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "anote-hook-codex-")));
  home = path.join(tmp, "home");
  graph = path.join(tmp, "graph");
  fs.mkdirSync(home);
});

afterEach(() => {
  assert.equal(fs.existsSync(graph), false, "hook commands must not create the graph");
  fs.rmSync(tmp, { recursive: true, force: true });
});

function run(args: string[], extraEnv: Record<string, string> = {}): Run {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, ANOTE_GRAPH: graph, ...extraEnv };
  if (!("CODEX_HOME" in extraEnv)) delete env["CODEX_HOME"];
  const r = spawnSync("node", ["--disable-warning=ExperimentalWarning", MAIN, "hook", "codex", ...args], {
    env, cwd: tmp, encoding: "utf8",
  });
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
}

const TRUST =
  "Codex runs this hook only after you trust it: open /hooks in Codex and approve it. Project hooks also need the project's .codex folder to be trusted.";
const WARNING = (): string => `warning: no graph at ${graph} yet; the hook will report an error until you run anote init\n`;

const hooksPath = (): string => path.join(home, ".codex", "hooks.json");
const backupPath = (): string => hooksPath() + ".anote-backup";
// Run from source, the hook names the repo's launcher by its absolute path.
const LAUNCHER = path.resolve(import.meta.dirname, "..", "anote");
const command = (budget = 2000, g = graph): string => `'${LAUNCHER}' brief --budget ${budget} --graph '${g}'`;
const handler = (cmd: string) => ({ type: "command", command: cmd });
const block = (cmd: string) => ({ hooks: { SessionStart: [{ hooks: [handler(cmd)] }] } });

function writeHooks(text: string): void {
  fs.mkdirSync(path.dirname(hooksPath()), { recursive: true });
  fs.writeFileSync(hooksPath(), text);
}

const readJson = (file: string): unknown => JSON.parse(fs.readFileSync(file, "utf8"));

// An invented hooks.json a Codex user might already have: a description, a
// SessionStart group of their own, and a PreToolUse group.
const EXISTING = {
  description: "invented example hooks",
  hooks: {
    SessionStart: [{ matcher: "startup|resume", hooks: [{ type: "command", command: "echo invented-codex-hook" }] }],
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo invented-pre-tool" }] }],
  },
};
const EXISTING_TEXT = JSON.stringify(EXISTING, null, 4) + "\n";

describe("hook codex: print", () => {
  it("story 1: prints the block, the target and the trust line; writes nothing anywhere", () => {
    const r = run([]);
    assert.equal(r.code, 0, r.err);
    assert.equal(
      r.out,
      `${JSON.stringify(block(command()), null, 2)}\nThis goes in ${hooksPath()}; run \`anote hook codex --write\` to add it there.\n${TRUST}\n`,
    );
    assert.equal(r.err, WARNING());
    assert.deepEqual(fs.readdirSync(home), []);
    assert.deepEqual(fs.readdirSync(tmp).sort(), ["home"]);
  });

  it("the block has no matcher, timeout, statusMessage or additionalContextLimit", () => {
    const printed = run([]).out;
    const json = JSON.parse(printed.slice(0, printed.indexOf("\nThis goes in"))) as unknown;
    assert.deepEqual(json, block(command()));
    for (const key of ["matcher", "timeout", "statusMessage", "additionalContextLimit"]) {
      assert.equal(printed.includes(`"${key}"`), false, key);
    }
  });
});

describe("hook codex: CODEX_HOME", () => {
  it("story 2: CODEX_HOME moves the default for print and --write; ~/.codex is not created", () => {
    const ch = path.join(tmp, "ch");
    const target = path.join(ch, "hooks.json");
    const p = run([], { CODEX_HOME: ch });
    assert.equal(p.code, 0, p.err);
    assert.ok(p.out.includes(`This goes in ${target};`), p.out);
    assert.equal(fs.existsSync(ch), false);

    const w = run(["--write"], { CODEX_HOME: ch });
    assert.equal(w.code, 0, w.err);
    assert.equal(w.out, `created ${target}\n${TRUST}\n`);
    assert.deepEqual(readJson(target), block(command()));
    assert.deepEqual(fs.readdirSync(ch), ["hooks.json"]);
    assert.deepEqual(fs.readdirSync(home), []);
  });

  it("--settings overrides CODEX_HOME", () => {
    const ch = path.join(tmp, "ch");
    const project = path.join(tmp, "project", ".codex", "hooks.json");
    const r = run(["--write", "--settings", project], { CODEX_HOME: ch });
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(readJson(project), block(command()));
    assert.equal(fs.existsSync(ch), false);
    assert.deepEqual(fs.readdirSync(home), []);
  });
});

describe("hook codex: --write", () => {
  it("story 3: no ~/.codex: creates hooks.json with exactly the block; ends with the trust line", () => {
    const r = run(["--write"]);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, `created ${hooksPath()}\n${TRUST}\n`);
    assert.deepEqual(readJson(hooksPath()), block(command()));
    assert.deepEqual(fs.readdirSync(home), [".codex"]);
    assert.deepEqual(fs.readdirSync(path.join(home, ".codex")), ["hooks.json"]);
  });

  it("story 4: existing hooks survive, one SessionStart group is added; backup is byte-identical", () => {
    writeHooks(EXISTING_TEXT);
    const r = run(["--write"]);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, `added the hook to ${hooksPath()}\nbackup: ${backupPath()}\n${TRUST}\n`);
    const expected = structuredClone(EXISTING);
    (expected.hooks.SessionStart as unknown[]).push({ hooks: [handler(command())] });
    assert.deepEqual(readJson(hooksPath()), expected);
    assert.equal(fs.readFileSync(backupPath(), "utf8"), EXISTING_TEXT);
    assert.deepEqual(fs.readdirSync(path.join(home, ".codex")).sort(), ["hooks.json", "hooks.json.anote-backup"]);
  });

  it("story 5: a second --write is unchanged: file and backup bytes the same, no trust line", () => {
    writeHooks(EXISTING_TEXT);
    assert.equal(run(["--write"]).code, 0);
    const before = snapshot(home);
    const r = run(["--write"]);
    assert.equal(r.code, 0, r.err);
    assert.equal(r.out, `unchanged: ${hooksPath()} already has this hook\n`);
    assert.equal(r.err.includes(TRUST), false, r.err);
    assert.deepEqual(snapshot(home), before);
  });

  describe("story 6: files anote cannot safely edit are refused and left untouched", () => {
    const cases: Array<[string, string, RegExp]> = [
      ["invalid JSON", '{"hooks": ', /not valid JSON/],
      ["a JSON array", "[1, 2]\n", /not a JSON object/],
      ["JSON with // comments", '{\n  // invented comment\n  "description": "invented"\n}\n', /comments/],
      ["hooks as a string", '{"hooks": "none"}\n', /"hooks" is not an object/],
      ["hooks.SessionStart as an object", '{"hooks": {"SessionStart": {}}}\n', /"hooks.SessionStart" is not an array/],
    ];
    for (const [name, text, why] of cases) {
      it(name, () => {
        writeHooks(text);
        for (const extra of [[], ["--force"]]) {
          const r = run(["--write", ...extra]);
          assert.equal(r.code, 1);
          assert.equal(r.out, "");
          assert.match(r.err, why);
          assert.ok(r.err.includes(hooksPath()), r.err);
          assert.equal(r.err.includes(TRUST), false, r.err);
          assert.equal(fs.readFileSync(hooksPath(), "utf8"), text);
          assert.equal(fs.existsSync(backupPath()), false);
          assert.deepEqual(fs.readdirSync(path.join(home, ".codex")), ["hooks.json"]);
        }
      });
    }
  });

  it("story 7: a different budget is refused showing both commands; --force replaces only that handler", () => {
    writeHooks(EXISTING_TEXT);
    assert.equal(run(["--write"]).code, 0);
    const installed = fs.readFileSync(hooksPath(), "utf8");
    fs.rmSync(backupPath());

    const r = run(["--write", "--budget", "3000"]);
    assert.equal(r.code, 1);
    assert.ok(r.err.includes(`installed: ${command(2000)}\n`), r.err);
    assert.ok(r.err.includes(`this run:  ${command(3000)}\n`), r.err);
    assert.match(r.err, /--force/);
    assert.equal(fs.readFileSync(hooksPath(), "utf8"), installed);
    assert.equal(fs.existsSync(backupPath()), false);

    const f = run(["--write", "--budget", "3000", "--force"]);
    assert.equal(f.code, 0, f.err);
    assert.equal(f.out, `replaced the anote brief hook in ${hooksPath()}\nbackup: ${backupPath()}\n${TRUST}\n`);
    const expected = structuredClone(EXISTING);
    (expected.hooks.SessionStart as unknown[]).push({ hooks: [handler(command(3000))] });
    assert.deepEqual(readJson(hooksPath()), expected);
    assert.equal(fs.readFileSync(backupPath(), "utf8"), installed);
  });

  it("story 7: a different graph is refused without --force", () => {
    assert.equal(run(["--write"]).code, 0);
    const other = path.join(tmp, "other-graph");
    const r = run(["--write", "--graph", other]);
    assert.equal(r.code, 1);
    assert.ok(r.err.includes(`this run:  ${command(2000, other)}\n`), r.err);
    assert.deepEqual(readJson(hooksPath()), block(command()));
    assert.equal(fs.existsSync(other), false);
  });

  it("only the named hooks file and its backup are touched under ~/.codex", () => {
    writeHooks(EXISTING_TEXT);
    const codex = path.join(home, ".codex");
    fs.writeFileSync(path.join(codex, "config.toml"), 'model = "invented-model"\n');
    fs.writeFileSync(path.join(codex, "auth.json"), '{"invented": true}\n');
    fs.chmodSync(path.join(codex, "auth.json"), 0o000);
    try {
      assert.equal(run(["--write"]).code, 0);
      assert.equal(run(["--write", "--budget", "500", "--force"]).code, 0);
    } finally {
      fs.chmodSync(path.join(codex, "auth.json"), 0o600);
    }
    assert.deepEqual(fs.readdirSync(codex).sort(), ["auth.json", "config.toml", "hooks.json", "hooks.json.anote-backup"]);
    assert.equal(fs.readFileSync(path.join(codex, "config.toml"), "utf8"), 'model = "invented-model"\n');
    assert.equal(fs.readFileSync(path.join(codex, "auth.json"), "utf8"), '{"invented": true}\n');
  });
});

describe("hook codex: usage", () => {
  it("story 8: --budget 199 and 8001 exit 2 and write nothing; 8000 works", () => {
    for (const budget of ["199", "8001"]) {
      for (const extra of [[], ["--write"]]) {
        const r = run(["--budget", budget, ...extra]);
        assert.equal(r.code, 2, budget);
        assert.equal(r.out, "");
        assert.match(r.err, /--budget must be between 200 and 8000/);
        assert.deepEqual(fs.readdirSync(home), []);
      }
    }
    const ok = run(["--write", "--budget", "8000"]);
    assert.equal(ok.code, 0, ok.err);
    assert.deepEqual(readJson(hooksPath()), block(command(8000)));
  });

  it("`anote hook` lists codex; `anote --help` names Codex", () => {
    const env = { ...process.env, HOME: home, ANOTE_GRAPH: graph };
    const h = spawnSync("node", ["--disable-warning=ExperimentalWarning", MAIN, "hook"], { env, encoding: "utf8" });
    assert.equal(h.status, 0);
    assert.match(h.stdout, /\{claude,codex\}/);
    assert.match(h.stdout, /\n {2}codex {7}Codex CLI/);
    const m = spawnSync("node", ["--disable-warning=ExperimentalWarning", MAIN, "--help"], { env, encoding: "utf8" });
    assert.match(m.stdout, /Claude Code or Codex hook/);
    const c = spawnSync("node", ["--disable-warning=ExperimentalWarning", MAIN, "hook", "codex", "--help"], { env, encoding: "utf8" });
    assert.equal(c.status, 0);
    assert.match(c.stdout, /^usage: anote hook codex /);
    assert.match(c.stdout, /200 to 8000/);
  });
});

describe("hook codex: --json (story 10)", () => {
  const parse = (r: Run): Record<string, unknown> => {
    assert.equal(r.out.trim().startsWith("{"), true, r.out);
    return JSON.parse(r.out) as Record<string, unknown>;
  };

  it("printed, created, unchanged, refused, replaced, added; the trust line goes to stderr", () => {
    const s = hooksPath();
    const b = backupPath();
    const trusted = (r: Run, expected: boolean): void => assert.equal(r.err.includes(TRUST), expected, r.err);

    const printed = run(["--json"]);
    assert.deepEqual(parse(printed), { action: "printed", settings: s, command: command() });
    trusted(printed, true);
    assert.deepEqual(fs.readdirSync(home), []);

    const created = run(["--write", "--json"]);
    assert.deepEqual(parse(created), { action: "created", settings: s, command: command() });
    trusted(created, true);

    const unchanged = run(["--write", "--json"]);
    assert.deepEqual(parse(unchanged), { action: "unchanged", settings: s, command: command() });
    trusted(unchanged, false);

    const refused = run(["--write", "--json", "--budget", "500"]);
    assert.equal(refused.code, 1);
    assert.deepEqual(parse(refused), { action: "refused", settings: s, command: command(500) });
    trusted(refused, false);

    const replaced = run(["--write", "--json", "--budget", "500", "--force"]);
    assert.equal(replaced.code, 0, replaced.err);
    assert.deepEqual(parse(replaced), { action: "replaced", settings: s, command: command(500), backup: b });
    trusted(replaced, true);

    writeHooks("{}");
    const added = run(["--write", "--json"]);
    assert.deepEqual(parse(added), { action: "added", settings: s, command: command(), backup: b });
    trusted(added, true);
  });

  it("refused for a file it cannot edit, nothing else on stdout", () => {
    writeHooks("[]");
    const r = run(["--write", "--json"]);
    assert.equal(r.code, 1);
    assert.deepEqual(parse(r), { action: "refused", settings: hooksPath(), command: command() });
  });
});
