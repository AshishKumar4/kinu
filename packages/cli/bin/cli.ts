#!/usr/bin/env bun
/**
 * proteus CLI — create, chat with, and evolve persistent AI agents.
 */

import { Command, Option } from 'commander';
import { createCommand } from '../src/commands/create.js';
import { chatCommand } from '../src/commands/chat.js';
import { execCommand, runCommand } from '../src/commands/run.js';
import { authCommand, logoutCommand, whoamiCommand } from '../src/commands/auth.js';
import { aliasCommand, aliasesCommand, unaliasCommand } from '../src/commands/alias.js';
import { desktopCommand } from '../src/commands/desktop.js';
import { daemonCommand } from '../src/commands/daemon.js';
import { setupCommand } from '../src/commands/setup.js';
import { providersCommand } from '../src/commands/providers.js';
import { sessionsCommand } from '../src/commands/sessions.js';
import { doctorCommand, uninstallCommand, updateCommand } from '../src/commands/self.js';
import { evolveCommand } from '../src/commands/evolve.js';
import { statusCommand } from '../src/commands/status.js';
import { listCommand } from '../src/commands/list.js';
import { effortCommand, jobsCommand, modelCommand, toolsCommand, triggersCommand } from '../src/commands/control.js';
import {
  alignmentCommand,
  eventsCommand,
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
import { tokensCommand } from '../src/commands/tokens.js';
import { workspaceDeleteCommand } from '../src/commands/workspace.js';
import { printHelp, printError, DIM, VERSION } from '../src/display.js';
import { runStartupUpdateCheck } from '../src/version-check.js';

const program = new Command();

program
  .name('proteus')
  .description('Create and chat with self-evolving agent workspaces')
  .version(VERSION, '-v, --version')
  .addHelpCommand(false);

// Shared LLM options
const llmOpts = (cmd: Command) => cmd
  .option('--model <id>', 'Model ID (env: PROTEUS_MODEL)')
  .option('--base-url <url>', 'LLM API base URL (env: PROTEUS_BASE_URL)')
  .option('--auth <header>', 'Auth header value (env: PROTEUS_AUTH)');

llmOpts(
  program
    .command('create [name]')
    .description('Create a new workspace')
    .option('--purpose <text>', 'Workspace purpose')
    .option('--mode <mode>', 'Workspace mode: cloud or local')
    .option('--alias <name>', 'Create an executable alias command')
    .option('--origin <url>', 'Proteus app origin for first-use sign-in')
    .option('--no-alias-shim', 'Do not create an alias shim'),
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
  .command('tokens [action] [name]')
  .description('Manage long-lived CI access tokens (list, create, revoke)')
  .option('--name <name>', 'Token name for create')
  .option('--scopes <scopes>', 'Comma-separated scopes: workspace.exec, workspace.read')
  .option('--json', 'Print raw JSON')
  .action(wrapAction(tokensCommand));

program
  .command('setup')
  .description('Connect your account; optionally configure local-only model credentials')
  .option('--origin <url>', 'Proteus app origin')
  .option('--provider <name>', 'Provider: codex, openai, openrouter, anthropic, openai-compatible, skip')
  .option('--model <id>', 'Default model for the selected provider')
  .option('--local-model', 'Configure credentials for local-only agents')
  .option('-y, --yes', 'Accept recommended setup choices where possible')
  .option('--skip-cloud', 'Skip account sign-in')
  .addOption(new Option('--account-only', 'Only complete Proteus account sign-in').hideHelp())
  .action(wrapAction(setupCommand));

program
  .command('provider [action] [name]')
  .alias('providers')
  .description('List or connect model and account providers')
  .option('--origin <url>', 'Proteus app origin')
  .option('--model <id>', 'Default model for the selected provider')
  .action(wrapAction(providersCommand));

llmOpts(
  program
    .command('run <name> [prompt...]')
    .description('Run a workspace once, or open chat when no prompt is provided')
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
    .description('Interactive conversation with a workspace')
    .option('--classic', 'Use classic readline interface instead of TUI')
    .option('-c, --continue', 'Continue the latest recorded CLI session')
    .option('-r, --resume', 'Resume the latest recorded CLI session')
    .option('--session <idOrPath>', 'Use a recorded CLI session')
    .option('--fork <idOrPath>', 'Fork a recorded CLI session into a new session')
    .option('--session-dir <dir>', 'Override CLI session storage directory')
    .option('--no-session', 'Do not record this CLI chat'),
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
    .description('Show workspace state and evolution history'),
).action(wrapAction(statusCommand));

llmOpts(
  program
    .command('model <name> [spec]')
    .description('Show or change a workspace model'),
).action(wrapAction(modelCommand));

program
  .command('effort <name> [level]')
  .description('Show or change workspace reasoning effort (low, medium, high)')
  .action(wrapAction(effortCommand));

llmOpts(
  program
    .command('tools <name>')
    .description('List a workspace tool surface'),
).action(wrapAction(toolsCommand));

llmOpts(
  program
    .command('triggers <name> [action] [value]')
    .description('List, schedule, cancel, or create workspace triggers')
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
  .description('List all workspaces')
  .action(wrapAction(listCommand));

const workspaceCommand = program
  .command('workspace')
  .description('Manage cloud workspaces');

workspaceCommand
  .command('delete <name>')
  .description('Permanently delete a cloud workspace')
  .option('-y, --yes', 'Skip the confirmation prompt')
  .action(wrapAction(workspaceDeleteCommand));

program
  .command('stop <name>')
  .description('Stop current cloud work or cancel local background jobs')
  .option('--json', 'Print raw JSON')
  .action(wrapAction(stopCommand));

program
  .command('state <name>')
  .description('Show the durable workspace state snapshot')
  .option('--json', 'Print raw JSON')
  .action(wrapAction(stateCommand));

program
  .command('memory <name> [query...]')
  .description('Read or search workspace memory')
  .option('--limit <n>', 'Search result limit')
  .option('--json', 'Print raw JSON')
  .action(wrapAction(memoryCommand));

program
  .command('events <name>')
  .description('List recent workspace events')
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

llmOpts(
  program
    .command('exec [prompt...]')
    .description('Run one workspace task headlessly and exit (CI-friendly; executor passthrough lives under `executors`)')
    .option('-w, --workspace <name>', 'Workspace to run (defaults to the only configured workspace)')
    .option('--json', 'Emit line-delimited JSON events')
    .option('--no-auto-evolve', 'Run without turn/session auto-evolution (local workspaces)')
    .option('--resume <sessionId>', 'Continue a recorded CLI session')
    .option('--session-dir <dir>', 'Override CLI session storage directory')
    .option('--no-session', 'Do not record this run')
    .option('-n, --name <label>', 'Human-readable session label'),
).action(wrapAction(execCommand));

program
  .command('alignment <name>')
  .description('K_align: correction rate per 100 graded turns, by scaffold version, with 95% intervals')
  .option('--json', 'Print raw JSON')
  .action(wrapAction(alignmentCommand));

program
  .command('product <name>')
  .description('Inspect product self-customization state')
  .option('--limit <n>', 'Change limit')
  .option('--json', 'Print raw JSON')
  .action(wrapAction(productCommand));

program
  .command('webhook <name> <label>')
  .description('Create a durable webhook trigger for a cloud workspace')
  .option('--auth-mode <mode>', 'Webhook auth mode: hmac, bearer, or mtls')
  .option('--secret <value>', 'Webhook secret for hmac or bearer auth')
  .option('--content-type <type>', 'Accepted webhook content type')
  .option('--rate-limit <n>', 'Webhook deliveries per minute')
  .option('--json', 'Print raw JSON')
  .action(wrapAction(webhookCommand));

program
  .command('alias <workspace> [alias]')
  .description('Create an executable command alias for a workspace')
  .action(wrapAction(aliasCommand));

program
  .command('unalias <alias>')
  .description('Remove an executable command alias')
  .action(wrapAction(unaliasCommand));

program
  .command('aliases')
  .description('List configured workspace aliases')
  .action(wrapAction(aliasesCommand));

program
  .command('sessions [workspace]')
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
  .description('Manage the local scheduler daemon: start, stop, restart, status, logs')
  .action(wrapAction(daemonCommand));

program
  .command('connect')
  .description('Link this computer as the desktop execution daemon')
  .option('--label <name>', 'Device label')
  .action(wrapAction((opts: { label?: string }) => desktopCommand('connect', opts)));

program
  .command('export <name>')
  .description('Export workspace database')
  .option('-o, --output <file>', 'Output file path')
  .action(wrapAction(exportCommand));

program
  .command('import <file>')
  .description('Import workspace database')
  .option('-n, --name <name>', 'Workspace name (default: derived from filename)')
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

// No args in a real terminal opens the interactive agent flow. Root --help
// remains branded help, and subcommand help is left to Commander.
const topLevelArgs = process.argv.slice(2);
if (topLevelArgs.length === 0) {
  if (process.stdin.isTTY && process.stdout.isTTY) {
    try {
      await chatCommand(undefined, {});
    } catch (err) {
      printError(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  } else {
    printHelp();
  }
  process.exit(0);
}

if (topLevelArgs.length === 1 && (topLevelArgs[0] === '--help' || topLevelArgs[0] === '-h')) {
  printHelp();
  process.exit(0);
}

program.parse();

// Once-a-day "newer Proteus available" notice. Fire-and-forget and fail-soft:
// it never blocks the command, and shouldCheckForUpdate suppresses it in
// non-TTY runs (CI, pipes, --json), when opted out, and within 24h.
void runStartupUpdateCheck({ log: (line) => console.error(DIM(line)) });

// Wrap async actions with consistent error handling
function wrapAction(fn: (...args: any[]) => Promise<void>) {
  return (...args: any[]) => {
    fn(...args).catch((err: Error) => {
      printError(err.message);
      process.exit(1);
    });
  };
}
