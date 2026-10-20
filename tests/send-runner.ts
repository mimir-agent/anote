// Runs the real CLI with the fake PDS injected and real network refused.
// FAKE_PDS_STATE names a JSON file with the fake's state; every request, and
// every read of ANOTE_PUBLISH_APP_PASSWORD, is appended to FAKE_PDS_LOG.
import * as fs from "node:fs";
import { appendLine, fakeTransport, installNetworkGuard } from "./fake-pds.ts";
import type { FakeState } from "./fake-pds.ts";

const logFile = process.env["FAKE_PDS_LOG"] as string;
const state = JSON.parse(fs.readFileSync(process.env["FAKE_PDS_STATE"] as string, "utf8")) as FakeState;
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

const { setTransport } = await import("../src/commands/send.ts");
const { main } = await import("../src/cli.ts");
setTransport(fakeTransport(state, (l) => appendLine(logFile, l)));
process.exitCode = await main(process.argv.slice(2));
