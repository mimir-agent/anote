// Preloaded (node --import) into every CLI the tests spawn through Ctx.run, so
// no test can reach a real host by mistake: fetch and the node:http, https,
// net and tls request functions throw.
import { installNetworkGuard } from "./fake-pds.ts";

installNetworkGuard(() => {});
