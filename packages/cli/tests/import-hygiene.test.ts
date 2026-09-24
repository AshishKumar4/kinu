/**
 * Every CLI invocation (including `kinu setup`) imports the command graph, so opentui loads only behind
 * dynamic imports: importing the graph must leave process.stdin untouched.
 */
import { join, resolve } from "node:path";
import { expect, test } from "bun:test";
import { present, runToExit } from '@kinu.run/test-utils';

const srcDir = resolve(__dirname, "../src");

const PROBE = `
const stdinState = () => ({
  data: process.stdin.listenerCount('data'),
  readable: process.stdin.listenerCount('readable'),
  keypress: process.stdin.listenerCount('keypress'),
  isRaw: Boolean(process.stdin.isRaw),
});
const opentuiPath = require.resolve('@opentui/core');
await import(${JSON.stringify(join(srcDir, "commands/setup.ts"))});
await import(${JSON.stringify(join(srcDir, "commands/chat.ts"))});
const afterCommands = { stdin: stdinState(), opentuiLoaded: Boolean(require.cache[opentuiPath]) };
await import('@opentui/core'); // positive control: the cache check detects loads
console.log(JSON.stringify({ afterCommands, controlLoaded: Boolean(require.cache[opentuiPath]) }));
process.exit(0);
`;

test("importing the setup/chat command graph leaves stdin untouched and opentui unloaded", async () => {
  const run = await runToExit([process.execPath, "-e", PROBE], { cwd: resolve(__dirname, "..") });

  expect(run.exitCode).toBe(0);
  const result = JSON.parse(present(run.stdout.trim().split("\n").at(-1), 'the last line of stdout'));
  expect(result.afterCommands.stdin).toEqual({ data: 0, readable: 0, keypress: 0, isRaw: false });
  expect(result.afterCommands.opentuiLoaded).toBe(false);
  expect(result.controlLoaded).toBe(true);
});
