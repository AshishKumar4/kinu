#!/usr/bin/env bun
/**
 * proteus CLI — create, chat with, and evolve persistent AI agents.
 */

import { Command } from 'commander';
import { createCommand } from '../src/commands/create.js';
import { chatCommand } from '../src/commands/chat.js';
import { runCommand } from '../src/commands/run.js';
import { authCommand, logoutCommand, whoamiCommand } from '../src/commands/auth.js';
import { aliasCommand, aliasesCommand, unaliasCommand } from '../src/commands/alias.js';
import { desktopCommand } from '../src/commands/desktop.js';
import { evolveCommand } from '../src/commands/evolve.js';
import { statusCommand } from '../src/commands/status.js';
import { listCommand } from '../src/commands/list.js';
import { exportCommand, importCommand } from '../src/commands/export-import.js';
import { printHelp, printError } from '../src/display.js';

const program = new Command();

program
  .name('proteus')
  .description('Create, chat with, and evolve persistent AI agents')
  .version('0.1.0', '-v, --version')
  .helpOption(false)
  .addHelpCommand(false);

// Shared LLM options
const llmOpts = (cmd: Command) => cmd
  .option('--model <id>', 'Model ID (env: PROTEUS_MODEL)')
  .option('--base-url <url>', 'LLM API base URL (env: PROTEUS_BASE_URL)')
  .option('--auth <header>', 'Auth header value (env: PROTEUS_AUTH)');

llmOpts(
  program
    .command('create [name]')
    .description('Create a new agent identity')
    .option('--purpose <text>', 'Agent purpose')
    .option('--mode <mode>', 'Agent mode: cloud or local')
    .option('--alias <name>', 'Create an executable alias command')
    .option('--no-alias-agent', 'Do not create an alias shim'),
).action(wrapAction(createCommand));

program
  .command('auth')
  .description('Sign the CLI into your Proteus account')
  .option('--origin <url>', 'Proteus app origin')
  .action(wrapAction(authCommand));

program
  .command('whoami')
  .description('Show the signed-in Proteus account')
  .option('--origin <url>', 'Proteus app origin')
  .action(wrapAction(whoamiCommand));

program
  .command('logout')
  .description('Sign out of the Proteus CLI')
  .option('--origin <url>', 'Proteus app origin')
  .action(wrapAction(logoutCommand));

llmOpts(
  program
    .command('run <name> [prompt...]')
    .description('Run an agent once, or open chat when no prompt is provided'),
).action(wrapAction(runCommand));

llmOpts(
  program
    .command('chat [name]')
    .description('Interactive conversation with an agent')
    .option('--classic', 'Use classic readline interface instead of TUI'),
).action(wrapAction(chatCommand));

llmOpts(
  program
    .command('evolve <name>')
    .description('Trigger an MCTS evolution cycle')
    .option('--budget <n>', 'MCTS iterations', '2')
    .option('--branches <n>', 'Branches per expansion', '2'),
).action(wrapAction(evolveCommand));

llmOpts(
  program
    .command('status <name>')
    .description('Show agent state and evolution history'),
).action(wrapAction(statusCommand));

program
  .command('list')
  .description('List all agents')
  .action(wrapAction(listCommand));

program
  .command('alias <agent> [alias]')
  .description('Create an executable command alias for an agent')
  .action(wrapAction(aliasCommand));

program
  .command('unalias <alias>')
  .description('Remove an executable command alias')
  .action(wrapAction(unaliasCommand));

program
  .command('aliases')
  .description('List configured agent aliases')
  .action(wrapAction(aliasesCommand));

program
  .command('desktop [action]')
  .description('Connect or inspect the local desktop execution daemon')
  .option('--label <name>', 'Device label')
  .action(wrapAction(desktopCommand));

program
  .command('connect')
  .description('Link this computer as the desktop execution daemon')
  .option('--label <name>', 'Device label')
  .action(wrapAction((opts: { label?: string }) => desktopCommand('connect', opts)));

program
  .command('export <name>')
  .description('Export agent database')
  .option('-o, --output <file>', 'Output file path')
  .action(wrapAction(exportCommand));

program
  .command('import <file>')
  .description('Import agent database')
  .option('-n, --name <name>', 'Agent name (default: derived from filename)')
  .action(wrapAction(importCommand));

// No args or --help: show branded help
if (process.argv.length <= 2 || process.argv.includes('--help') || process.argv.includes('-h')) {
  printHelp();
  process.exit(0);
}

program.parse();

// Wrap async actions with consistent error handling
function wrapAction(fn: (...args: any[]) => Promise<void>) {
  return (...args: any[]) => {
    fn(...args).catch((err: Error) => {
      printError(err.message);
      process.exit(1);
    });
  };
}
