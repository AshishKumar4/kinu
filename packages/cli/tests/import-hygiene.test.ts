/**
 * Command modules must not capture the terminal at import time: every CLI
 * invocation (including the installer's `kinu setup`) imports the command
 * graph, so an eagerly-loaded TUI library that touches stdin or termios would
 * starve simple prompts. opentui therefore loads only behind dynamic imports
 * on the TUI launch paths, and importing the command graph must leave
 * process.stdin completely untouched.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, expect, test } from "bun:test";

const srcDir = resolve(__dirname, "../src");
// The probe must live inside the package so @opentui/core resolves from it.
const fixtures = mkdtempSync(join(__dirname, "import-probe-"));
afterAll(() => rmSync(fixtures, { recursive: true, force: true }));

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

test("importing the setup/chat command graph leaves stdin untouched and opentui unloaded", () => {
  const probePath = join(fixtures, "probe.ts");
  writeFileSync(probePath, PROBE);
  const run = spawnSync(process.execPath, [probePath], {
    cwd: resolve(__dirname, ".."),
    encoding: "utf8",
    timeout: 30_000,
  });
  expect(run.status).toBe(0);
  const result = JSON.parse(run.stdout.trim().split("\n").at(-1)!);
  expect(result.afterCommands.stdin).toEqual({ data: 0, readable: 0, keypress: 0, isRaw: false });
  expect(result.afterCommands.opentuiLoaded).toBe(false);
  expect(result.controlLoaded).toBe(true);
}, 40_000);
