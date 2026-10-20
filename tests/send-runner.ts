// Runs the real CLI with the fake PDS injected and real network refused.
// FAKE_PDS_STATE names a JSON file with the fake's state; every request, and
// every read of ANOTE_PUBLISH_APP_PASSWORD, is appended to FAKE_PDS_LOG. The
// fake's state (with any records written) is saved back to FAKE_PDS_STATE at
// the end, so a test can run send again against the same repo. FAKE_TTY=1
// makes send treat stdin as a terminal.
import * as fs from "node:fs";
import { appendLine, fakeTransport, installNetworkGuard } from "./fake-pds.ts";
import type { FakeState } from "./fake-pds.ts";

const logFile = process.env["FAKE_PDS_LOG"] as string;
const stateFile = process.env["FAKE_PDS_STATE"] as string;
const state = JSON.parse(fs.readFileSync(stateFile, "utf8")) as FakeState;
const tty = process.env["FAKE_TTY"] === "1";
installNetworkGuard((l) => appendLine(logFile, l));

const SECRET = "ANOTE_PUBLISH_APP_PASSWORD";
const env = process.env;
process.env = new Proxy(env, {
  get(t, k) {
    if (k === SECRET) appendLine(logFile, { secretRead: true });
    return Reflect.get(t, k);
  },
  has(t, k) {
    if (k === SECRET) appendLine(logFile, { secretRead: true });
    return Reflect.has(t, k);
  },
  getOwnPropertyDescriptor(t, k) {
    if (k === SECRET) appendLine(logFile, { secretRead: true });
    return Reflect.getOwnPropertyDescriptor(t, k);
  },
});

const { setInteractive, setTransport } = await import("../src/commands/send.ts");
const { main } = await import("../src/cli.ts");
setTransport(fakeTransport(state, (l) => appendLine(logFile, l)));
setInteractive(() => tty);
try {
  process.exitCode = await main(process.argv.slice(2));
} finally {
  fs.writeFileSync(stateFile, JSON.stringify(state));
}
