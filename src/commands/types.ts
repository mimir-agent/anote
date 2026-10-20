// Shared shapes for command modules, plus the output helper.
import type { Args } from "../args.ts";
import { print } from "../util.ts";

/** A command returns an exit code, or nothing for 0 (send returns a promise of one). */
export type CommandFn = (a: Args) => number | void | Promise<number | void>;

/** Print JSON when --json is set, otherwise the text (skipped when empty). */
export function emit(a: Args, data: unknown, text: string): void {
  if (a.flag("json")) print(JSON.stringify(data, null, 2));
  else if (text) print(text);
}
