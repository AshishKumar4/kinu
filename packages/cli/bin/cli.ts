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
import { daemonCommand } from '../src/commands/daemon.js';
import { setupCommand } from '../src/commands/setup.js';
import { sessionsCommand } from '../src/commands/sessions.js';
import { doctorCommand, uninstallCommand, updateCommand } from '../src/commands/self.js';
import { evolveCommand } from '../src/commands/evolve.js';
import { statusCommand } from '../src/commands/status.js';
import { listCommand } from '../src/commands/list.js';
import { jobsCommand, modelCommand, toolsCommand, triggersCommand } from '../src/commands/control.js';
import {
  eventsCommand,
  execCommand,
  executorsCommand,
  gepaCommand,
  headsCommand,
  mctsCommand,
  memoryCommand,
  productCommand,
  stateCommand,
  stopCommand,
  timelineCommand,
  webhookCommand,
} from '../src/commands/inspect.js';
import { exportCommand, importCommand } from '../src/commands/export-import.js';
import { printHelp, printError } from '../src/display.js';

const program = new Command();

program
  .name('proteus')
  .description('Create, chat with, and evolve persistent AI agents')
  .version('0.1.0', '-v, --version')
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
    .option('--origin <url>', 'Proteus app origin for first-use sign-in')
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

program
  .command('setup')
  .description('Connect your account; optionally configure local-only model credentials')
  .option('--origin <url>', 'Proteus app origin')
  .option('--provider <name>', 'Provider: codex, openai, openrouter, anthropic, openai-compatible, skip')
  .option('--model <id>', 'Default model for the selected provider')
  .option('--local-model', 'Configure credentials for local-only agents')
  .option('-y, --yes', 'Accept recommended setup choices where possible')
  .option('--skip-cloud', 'Skip account sign-in')
  .action(wrapAction(setupCommand));

llmOpts(
  program
    .command('run <name> [prompt...]')
    .description('Run an agent once, or open chat when no prompt is provided')
    .option('-p, --print', 'Print response and exit')
    .option('--mode <mode>', 'Output mode: text, json, or rpc', 'text')
    .option('-c, --continue', 'Continue the latest recorded CLI session')
    .option('-r, --resume', 'Resume the latest recorded CLI session')
    .option('--session <idOrPath>', 'Use a recorded CLI session')
    .option('--fork <idOrPath>', 'Fork a recorded CLI session into a new session')
    .option('--session-dir <dir>', 'Override CLI session storage directory')
    .option('--no-session', 'Do not record this CLI run')
    .option('-n, --name <label>', 'Human-readable session label'),
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

llmOpts(
  program
    .command('model <name> [spec]')
    .description('Show or change an agent model'),
).action(wrapAction(modelCommand));

llmOpts(
  program
    .command('tools <name>')
    .description('List an agent tool surface'),
).action(wrapAction(toolsCommand));

llmOpts(
  program
    .command('triggers <name> [action] [value]')
    .description('List, schedule, cancel, or create agent triggers')
    .option('--auth-mode <mode>', 'Webhook auth mode: hmac, bearer, or mtls')
    .option('--secret <value>', 'Webhook secret for hmac or bearer auth')
    .option('--content-type <type>', 'Accepted webhook content type')
    .option('--rate-limit <n>', 'Webhook deliveries per minute'),
).action(wrapAction(triggersCommand));

llmOpts(
  program
    .command('jobs <name> [action] [id]')
    .description('List or cancel background jobs'),
).action(wrapAction(jobsCommand));

program
  .command('list')
  .description('List all agents')
  .action(wrapAction(listCommand));

program
  .command('stop <name>')
  .description('Stop current cloud work or cancel local background jobs')
  .option('--json', 'Print raw JSON')
  .action(wrapAction(stopCommand));

program
  .command('state <name>')
  .description('Show the durable agent state snapshot')
  .option('--json', 'Print raw JSON')
  .action(wrapAction(stateCommand));

program
  .command('memory <name> [query...]')
  .description('Read or search agent memory')
  .option('--limit <n>', 'Search result limit')
  .option('--json', 'Print raw JSON')
  .action(wrapAction(memoryCommand));

program
  .command('events <name>')
  .description('List recent agent events')
  .option('--variant <name>', 'Filter by event variant')
  .option('--since <time>', 'Filter events after a timestamp or date')
  .option('--limit <n>', 'Event limit')
  .option('--json', 'Print raw JSON')
  .action(wrapAction(eventsCommand));

program
  .command('timeline <name>')
  .description('List the run/evolution/MCTS timeline')
  .option('--limit <n>', 'Timeline row limit')
  .option('--json', 'Print raw JSON')
  .action(wrapAction(timelineCommand));

program
  .command('mcts <name> [nodeId]')
  .description('Inspect MCTS search history')
  .option('--json', 'Print raw JSON')
  .action(wrapAction(mctsCommand));

program
  .command('heads <name>')
  .description('Inspect parallel reasoning branch runs')
  .option('--limit <n>', 'Run limit')
  .option('--json', 'Print raw JSON')
  .action(wrapAction(headsCommand));

program
  .command('gepa <name> [runId]')
  .description('Inspect GEPA optimization runs')
  .option('--limit <n>', 'Run limit')
  .option('--json', 'Print raw JSON')
  .action(wrapAction(gepaCommand));

program
  .command('executors <name> [executor] [command...]')
  .description('List executors, or run a command in one')
  .option('--json', 'Print raw JSON')
  .action(wrapAction(executorsCommand));

program
  .command('exec <name> <executor> [command...]')
  .description('Run a command through an agent executor')
  .option('--json', 'Print raw JSON')
  .action(wrapAction(execCommand));

program
  .command('product <name>')
  .description('Inspect product self-customization state')
  .option('--limit <n>', 'Change limit')
  .option('--json', 'Print raw JSON')
  .action(wrapAction(productCommand));

program
  .command('webhook <name> <label>')
  .description('Create a durable webhook trigger for a cloud agent')
  .option('--auth-mode <mode>', 'Webhook auth mode: hmac, bearer, or mtls')
  .option('--secret <value>', 'Webhook secret for hmac or bearer auth')
  .option('--content-type <type>', 'Accepted webhook content type')
  .option('--rate-limit <n>', 'Webhook deliveries per minute')
  .option('--json', 'Print raw JSON')
  .action(wrapAction(webhookCommand));

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
  .command('sessions [agent]')
  .description('List recorded CLI sessions')
  .option('--session-dir <dir>', 'Override CLI session storage directory')
  .option('--path', 'Show session file paths')
  .option('--show <idOrPath>', 'Show a specific session path')
  .action(wrapAction(sessionsCommand));

program
  .command('desktop [action]')
  .description('Connect or inspect the local desktop execution daemon')
  .option('--label <name>', 'Device label')
  .action(wrapAction(desktopCommand));

program
  .command('daemon [action]')
  .description('Manage the local scheduler daemon for local agent alarms')
  .action(wrapAction(daemonCommand));

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

program
  .command('update [target]')
  .description('Update the installed Proteus command')
  .option('--origin <url>', 'Proteus app origin')
  .option('--force', 'Reinstall even if already current')
  .action(wrapAction(updateCommand));

program
  .command('uninstall')
  .description('Remove the installed Proteus command')
  .option('--purge', 'Also remove ~/.proteus data')
  .action(wrapAction(uninstallCommand));

program
  .command('doctor')
  .description('Inspect local Proteus CLI installation state')
  .action(wrapAction(doctorCommand));

// No args or root --help: show branded help. Subcommand help is left to
// Commander so `proteus run --help` and friends show the selected command.
const topLevelArgs = process.argv.slice(2);
if (
  topLevelArgs.length === 0 ||
  (topLevelArgs.length === 1 && (topLevelArgs[0] === '--help' || topLevelArgs[0] === '-h'))
) {
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
