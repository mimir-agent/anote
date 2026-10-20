// anote hook claude. Every run gets a temp HOME, and ANOTE_GRAPH points at a
// directory that must never be created. Settings content is invented.
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
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "anote-hook-")));
  home = path.join(tmp, "home");
  graph = path.join(tmp, "graph");
  fs.mkdirSync(home);
});

afterEach(() => {
  assert.equal(fs.existsSync(graph), false, "hook commands must not create the graph");
  fs.rmSync(tmp, { recursive: true, force: true });
});

function run(args: string[]): Run {
  const env = { ...process.env, HOME: home, ANOTE_GRAPH: graph };
  const r = spawnSync("node", ["--disable-warning=ExperimentalWarning", MAIN, "hook", "claude", ...args], {
    env, cwd: tmp, encoding: "utf8",
  });
  return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
}

const settingsPath = (): string => path.join(home, ".claude", "settings.json");
const backupPath = (): string => settingsPath() + ".anote-backup";
const command = (budget = 2000, g = graph): string => `anote brief --budget ${budget} --graph '${g}'`;
const handler = (cmd: string) => ({ type: "command", command: cmd });
const block = (cmd: string) => ({ hooks: { SessionStart: [{ hooks: [handler(cmd)] }] } });

function writeSettings(text: string): void {
  fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
  fs.writeFileSync(settingsPath(), text);
}

const readJson = (file: string): unknown => JSON.parse(fs.readFileSync(file, "utf8"));

// Invented settings a user might already have: other keys, another hook event,
// and a SessionStart hook of their own.
const EXISTING = {
  model: "example-model",
  permissions: { allow: ["Bash(npm test)"], deny: [] },
  hooks: {
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo checking" }] }],
    SessionStart: [{ matcher: "startup", hooks: [{ type: "command", command: "echo hello" }] }],
  },
};
const EXISTING_TEXT = JSON.stringify(EXISTING, null, 4) + "\n";

describe("hook claude: print", () => {
  it("story 1: prints the block and the target, writes nothing anywhere", () => {
    const r = run([]);
    assert.equal(r.code, 0, r.err);
    const lines = r.out.trimEnd().split("\n");
    const last = lines.pop() as string;
    assert.deepEqual(JSON.parse(lines.join("\n")), block(command()));
    assert.ok(last.includes(settingsPath()), last);
    assert.match(last, /--write/);
    assert.deepEqual(fs.readdirSync(home), []);
    assert.deepEqual(fs.readdirSync(tmp).sort(), ["home"]);
  });

  it("the graph comes from --graph, made absolute", () => {
    const r = run(["--graph", "rel/g", "--json"]);
    assert.equal(r.code, 0, r.err);
    assert.equal(JSON.parse(r.out).command, command(2000, path.join(tmp, "rel", "g")));
    assert.equal(fs.existsSync(path.join(tmp, "rel")), false);
  });

  it("a graph path with a space and a single quote survives the shell exactly", () => {
    const odd = path.join(tmp, "my graph's notes");
    const r = run(["--graph", odd, "--json"]);
    assert.equal(r.code, 0, r.err);
    const cmd = JSON.parse(r.out).command as string;
    const prefix = "anote brief --budget 2000 --graph ";
    assert.ok(cmd.startsWith(prefix), cmd);
    const echoed = spawnSync("sh", ["-c", `printf '%s' ${cmd.slice(prefix.length)}`], { encoding: "utf8" });
    assert.equal(echoed.status, 0, echoed.stderr);
    assert.equal(echoed.stdout, odd);
    assert.equal(fs.existsSync(odd), false);
  });
});

describe("hook claude: --write", () => {
  it("story 2: no settings file: creates it with exactly the hook block", () => {
    const r = run(["--write"]);
    assert.equal(r.code, 0, r.err);
    assert.ok(r.out.includes(settingsPath()), r.out);
    assert.deepEqual(readJson(settingsPath()), block(command()));
    assert.equal(fs.existsSync(backupPath()), false);
    assert.deepEqual(fs.readdirSync(path.join(home, ".claude")), ["settings.json"]);
  });

  it("story 3: existing settings keep every other key and hook; backup is byte-identical", () => {
    writeSettings(EXISTING_TEXT);
    const r = run(["--write"]);
    assert.equal(r.code, 0, r.err);
    assert.ok(r.out.includes(backupPath()), r.out);
    const expected = structuredClone(EXISTING);
    (expected.hooks.SessionStart as unknown[]).push({ hooks: [handler(command())] });
    assert.deepEqual(readJson(settingsPath()), expected);
    assert.equal(fs.readFileSync(backupPath(), "utf8"), EXISTING_TEXT);
  });

  it("an existing file with no hooks key gets one", () => {
    writeSettings('{"model": "example-model"}');
    const r = run(["--write"]);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(readJson(settingsPath()), { model: "example-model", ...block(command()) });
  });

  it("a symlinked settings file is written through, the link kept", () => {
    const real = path.join(tmp, "dotfiles", "settings.json");
    fs.mkdirSync(path.dirname(real), { recursive: true });
    fs.writeFileSync(real, "{}\n");
    fs.mkdirSync(path.join(home, ".claude"));
    fs.symlinkSync(real, settingsPath());
    const r = run(["--write"]);
    assert.equal(r.code, 0, r.err);
    assert.ok(fs.lstatSync(settingsPath()).isSymbolicLink());
    assert.deepEqual(readJson(real), block(command()));
    assert.equal(fs.readFileSync(backupPath(), "utf8"), "{}\n");
  });

  it("a symlinked backup path is refused: its target and the settings stay byte-identical", () => {
    const victim = path.join(tmp, "victim-rc.sh");
    fs.writeFileSync(victim, "export SAFE=1\n");
    writeSettings(EXISTING_TEXT);
    fs.symlinkSync(victim, backupPath());
    for (const extra of [[], ["--force"]]) {
      const r = run(["--write", ...extra]);
      assert.equal(r.code, 1);
      assert.equal(r.out, "");
      assert.match(r.err, /is not a regular file/);
      assert.ok(r.err.includes(backupPath()), r.err);
      assert.match(r.err, /Nothing written/);
      assert.equal(fs.readFileSync(victim, "utf8"), "export SAFE=1\n");
      assert.equal(fs.readFileSync(settingsPath(), "utf8"), EXISTING_TEXT);
      assert.equal(fs.readlinkSync(backupPath()), victim);
      assert.deepEqual(fs.readdirSync(path.join(home, ".claude")).sort(), ["settings.json", "settings.json.anote-backup"]);
    }
  });

  it("a directory at the backup path is refused", () => {
    writeSettings(EXISTING_TEXT);
    fs.mkdirSync(backupPath());
    const r = run(["--write"]);
    assert.equal(r.code, 1);
    assert.match(r.err, /is not a regular file/);
    assert.equal(fs.readFileSync(settingsPath(), "utf8"), EXISTING_TEXT);
    assert.deepEqual(fs.readdirSync(backupPath()), []);
  });

  it("an old regular backup file is replaced with the current settings", () => {
    writeSettings(EXISTING_TEXT);
    fs.writeFileSync(backupPath(), "old backup\n");
    const r = run(["--write"]);
    assert.equal(r.code, 0, r.err);
    assert.equal(fs.readFileSync(backupPath(), "utf8"), EXISTING_TEXT);
  });

  it("the file mode is kept", () => {
    writeSettings("{}\n");
    fs.chmodSync(settingsPath(), 0o600);
    assert.equal(run(["--write"]).code, 0);
    assert.equal(fs.statSync(settingsPath()).mode & 0o777, 0o600);
  });

  it("story 4: a second --write is unchanged; file and backup bytes stay the same", () => {
    writeSettings(EXISTING_TEXT);
    assert.equal(run(["--write"]).code, 0);
    const before = snapshot(home);
    const r = run(["--write"]);
    assert.equal(r.code, 0, r.err);
    assert.match(r.out, /unchanged/);
    assert.deepEqual(snapshot(home), before);
  });

  it("story 4: unchanged right after create writes no backup", () => {
    assert.equal(run(["--write"]).code, 0);
    assert.equal(run(["--write"]).code, 0);
    assert.equal(fs.existsSync(backupPath()), false);
  });

  describe("story 5: files anote cannot safely edit are refused and left untouched", () => {
    const cases: Array<[string, string, RegExp]> = [
      ["invalid JSON", '{"model": ', /not valid JSON/],
      ["a JSON array", "[1, 2]\n", /not a JSON object/],
      ["JSON with // comments", '{\n  // my model\n  "model": "example-model"\n}\n', /comments/],
      ["hooks as a string", '{"hooks": "none"}\n', /"hooks" is not an object/],
      ["hooks.SessionStart as an object", '{"hooks": {"SessionStart": {}}}\n', /"hooks.SessionStart" is not an array/],
      ["a SessionStart entry without a hooks array", '{"hooks": {"SessionStart": [{"hooks": "x"}]}}\n',
        /"hooks.SessionStart\[0\]" is not an object with a "hooks" array/],
    ];
    for (const [name, text, why] of cases) {
      it(name, () => {
        writeSettings(text);
        for (const extra of [[], ["--force"]]) {
          const r = run(["--write", ...extra]);
          assert.equal(r.code, 1);
          assert.equal(r.out, "");
          assert.match(r.err, why);
          assert.ok(r.err.includes(settingsPath()), r.err);
          assert.equal(fs.readFileSync(settingsPath(), "utf8"), text);
          assert.equal(fs.existsSync(backupPath()), false);
          assert.deepEqual(fs.readdirSync(path.join(home, ".claude")), ["settings.json"]);
        }
      });
    }
  });

  it("story 6: a different budget is refused showing both commands; --force replaces only that entry", () => {
    writeSettings(EXISTING_TEXT);
    assert.equal(run(["--write"]).code, 0);
    const installed = fs.readFileSync(settingsPath(), "utf8");
    fs.rmSync(backupPath());

    const r = run(["--write", "--budget", "3000"]);
    assert.equal(r.code, 1);
    assert.ok(r.err.includes(command(2000)), r.err);
    assert.ok(r.err.includes(command(3000)), r.err);
    assert.match(r.err, /--force/);
    assert.equal(fs.readFileSync(settingsPath(), "utf8"), installed);
    assert.equal(fs.existsSync(backupPath()), false);

    const f = run(["--write", "--budget", "3000", "--force"]);
    assert.equal(f.code, 0, f.err);
    assert.ok(f.out.includes(backupPath()), f.out);
    const expected = structuredClone(EXISTING);
    (expected.hooks.SessionStart as unknown[]).push({ hooks: [handler(command(3000))] });
    assert.deepEqual(readJson(settingsPath()), expected);
    assert.equal(fs.readFileSync(backupPath(), "utf8"), installed);
  });

  it("story 6: --force keeps other fields on the replaced handler", () => {
    writeSettings(JSON.stringify({
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: "anote brief --budget 500", timeout: 30 }] }] },
    }));
    const r = run(["--write", "--force"]);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(readJson(settingsPath()), {
      hooks: { SessionStart: [{ hooks: [{ type: "command", command: command(), timeout: 30 }] }] },
    });
  });

  it("two anote brief entries are refused, even with --force", () => {
    const text = JSON.stringify({
      hooks: { SessionStart: [{ hooks: [handler("anote brief"), handler("anote brief --budget 500")] }] },
    });
    writeSettings(text);
    const r = run(["--write", "--force"]);
    assert.equal(r.code, 1);
    assert.match(r.err, /2 anote brief hooks/);
    assert.equal(fs.readFileSync(settingsPath(), "utf8"), text);
    assert.equal(fs.existsSync(backupPath()), false);
  });

  it("story 7: --settings writes elsewhere and leaves ~/.claude untouched", () => {
    const project = path.join(tmp, "project", ".claude", "settings.json");
    const r = run(["--write", "--settings", project]);
    assert.equal(r.code, 0, r.err);
    assert.deepEqual(readJson(project), block(command()));
    assert.deepEqual(fs.readdirSync(home), []);
  });

  it("story 7: a relative --settings resolves against the current directory", () => {
    const r = run(["--write", "--settings", ".claude/settings.json", "--json"]);
    assert.equal(r.code, 0, r.err);
    assert.equal(JSON.parse(r.out).settings, path.join(tmp, ".claude", "settings.json"));
    assert.deepEqual(fs.readdirSync(home), []);
  });

  it("a file where the folder should be: exit 1 with the OS error", () => {
    fs.writeFileSync(path.join(home, ".claude"), "");
    const r = run(["--write"]);
    assert.equal(r.code, 1);
    // The missing-graph warning comes first; the OS error is on its own line.
    assert.match(r.err, /^anote: ENOTDIR: /m);
    assert.equal(fs.readFileSync(path.join(home, ".claude"), "utf8"), "");
  });
});

describe("hook claude: missing graph", () => {
  const warning = (g = graph): string =>
    `warning: no graph at ${g} yet; the hook will report an error until you run anote init\n`;
  const printed = (g: string): string =>
    `${JSON.stringify(block(command(2000, g)), null, 2)}\nThis goes in ${settingsPath()}; run \`anote hook claude --write\` to add it there.\n`;

  it("print: warns on stderr, still prints the hook, exit 0", () => {
    const r = run([]);
    assert.equal(r.code, 0);
    assert.equal(r.err, warning());
    assert.equal(r.out, printed(graph));
  });

  it("--write: warns on stderr, still writes the settings file, exit 0", () => {
    const r = run(["--write"]);
    assert.equal(r.code, 0);
    assert.equal(r.err, warning());
    assert.equal(r.out, `created ${settingsPath()}\n`);
    assert.deepEqual(readJson(settingsPath()), block(command()));
  });

  it("an existing graph: no warning, the same output as before", () => {
    const g = path.join(tmp, "real-graph");
    fs.mkdirSync(g);
    const r = run(["--graph", g]);
    assert.equal(r.code, 0);
    assert.equal(r.err, "");
    assert.equal(r.out, printed(g));
  });
});

describe("hook claude: --json (story 8)", () => {
  const parse = (r: Run): Record<string, unknown> => {
    assert.equal(r.out.trim().startsWith("{"), true, r.out);
    return JSON.parse(r.out) as Record<string, unknown>;
  };

  it("printed, created, unchanged, refused, replaced, added", () => {
    const s = settingsPath();
    const b = backupPath();
    assert.deepEqual(parse(run(["--json"])), { action: "printed", settings: s, command: command() });
    assert.deepEqual(fs.readdirSync(home), []);
    assert.deepEqual(parse(run(["--write", "--json"])), { action: "created", settings: s, command: command() });
    assert.deepEqual(parse(run(["--write", "--json"])), { action: "unchanged", settings: s, command: command() });

    const refused = run(["--write", "--json", "--budget", "500"]);
    assert.equal(refused.code, 1);
    assert.deepEqual(parse(refused), { action: "refused", settings: s, command: command(500) });

    const replaced = run(["--write", "--json", "--budget", "500", "--force"]);
    assert.equal(replaced.code, 0, replaced.err);
    assert.deepEqual(parse(replaced), { action: "replaced", settings: s, command: command(500), backup: b });

    writeSettings("{}");
    assert.deepEqual(parse(run(["--write", "--json"])), { action: "added", settings: s, command: command(), backup: b });
  });

  it("refused for a file it cannot edit, nothing else on stdout", () => {
    writeSettings("[]");
    const r = run(["--write", "--json"]);
    assert.equal(r.code, 1);
    assert.deepEqual(parse(r), { action: "refused", settings: settingsPath(), command: command() });
  });
});

describe("hook claude: usage", () => {
  it("story 9: --budget 199 and 10001 exit 2 and write nothing", () => {
    for (const budget of ["199", "10001"]) {
      for (const extra of [[], ["--write"]]) {
        const r = run(["--budget", budget, ...extra]);
        assert.equal(r.code, 2, budget);
        assert.equal(r.out, "");
        assert.match(r.err, /--budget must be between 200 and 10000/);
        assert.deepEqual(fs.readdirSync(home), []);
      }
    }
  });

  it("--budget 200 and 10000 are accepted", () => {
    assert.equal(run(["--budget", "200"]).code, 0);
    assert.equal(run(["--budget", "10000"]).code, 0);
  });

  it("`anote hook` alone prints the hook help; an unknown agent is a usage error", () => {
    const env = { ...process.env, HOME: home, ANOTE_GRAPH: graph };
    const h = spawnSync("node", ["--disable-warning=ExperimentalWarning", MAIN, "hook"], { env, encoding: "utf8" });
    assert.equal(h.status, 0);
    assert.match(h.stdout, /^usage: anote hook /);
    assert.match(h.stdout, /claude/);
    const u = spawnSync("node", ["--disable-warning=ExperimentalWarning", MAIN, "hook", "codex"], { env, encoding: "utf8" });
    assert.equal(u.status, 2);
    assert.match(u.stderr, /invalid choice: 'codex'/);
  });

  it("anote --help lists hook", () => {
    const env = { ...process.env, HOME: home, ANOTE_GRAPH: graph };
    const h = spawnSync("node", ["--disable-warning=ExperimentalWarning", MAIN, "--help"], { env, encoding: "utf8" });
    assert.match(h.stdout, /\n {4}hook {6}/);
  });
});
