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

// Once-a-day background refresh, after the command has dispatched and never
// awaited: the check is fail-soft and bounded, and the refresh it starts is a
// detached child, so no command waits on either. shouldCheckForUpdate
// suppresses it in non-TTY runs (CI, pipes, --json), when opted out, and
// within 24h. `kinu update` itself is exempt: it is the refresh.
if (topLevelArgs[0] !== 'update') {
  // runStartupUpdateCheck never throws: its own catch prints what a check that
  // can never succeed has to say and swallows what a background probe may
  // meet. Not awaited, so the command's exit does not wait on the probe.
  runStartupUpdateCheck({ log: (line) => console.error(DIM(line)) })
    .catch((...rejection: [unknown]) => { printFailure({ cause: rejection[0] }); });
}
