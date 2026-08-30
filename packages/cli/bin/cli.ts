#!/usr/bin/env bun
/**
 * kinu CLI — create, chat with, and evolve persistent AI agents.
 */

import { buildProgram } from '../src/program';
import { chatCommand } from '../src/commands/chat';
import { printHelp, printFailure, DIM } from '../src/display';
import { runStartupUpdateCheck } from '../src/version-check';

const program = buildProgram();

// No args in a real terminal opens the interactive agent flow. Root --help
// remains branded help, and subcommand help is left to Commander.
const topLevelArgs = process.argv.slice(2);
if (topLevelArgs.length === 0) {
  if (process.stdin.isTTY && process.stdout.isTTY) {
    try {
      await chatCommand(undefined, {});
    } catch (err) {
      printFailure({ cause: err });
      process.exit(1);
    }
  } else {
    printHelp(program);
  }
  process.exit(0);
}

if (topLevelArgs.length === 1 && (topLevelArgs[0] === '--help' || topLevelArgs[0] === '-h')) {
  printHelp(program);
  process.exit(0);
}

program.parse();

// Once-a-day "newer Kinu available" notice. The entrypoint owns its bounded,
// fail-soft completion after parsing; shouldCheckForUpdate suppresses it in
// non-TTY runs (CI, pipes, --json), when opted out, and within 24h.
try {
  await runStartupUpdateCheck({ log: (line) => console.error(DIM(line)) });
} catch (cause) {
  printFailure({ cause });
}
