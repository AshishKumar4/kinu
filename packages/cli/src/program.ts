/**
 * The registered command surface. Single source of truth: the branded root help
 * (display.ts renderHelp) is derived from this tree, so a command can never be
 * registered without becoming discoverable. `.helpGroup()` carries the curated
 * grouping alongside each registration instead of in a parallel list.
 */

import { Command, Option } from 'commander';
import { createCommand } from './commands/create';
import { acpCommand } from './commands/acp';
import { chatCommand } from './commands/chat';
import { execCommand, runCommand } from './commands/run';
import { authCommand, logoutCommand, whoamiCommand } from './commands/auth';
import { aliasCommand, aliasesCommand, unaliasCommand } from './commands/alias';
import { desktopCommand } from './commands/desktop';
import { daemonCommand } from './commands/daemon';
import { setupCommand } from './commands/setup';
import { providersCommand } from './commands/providers';
import { transcriptsCommand } from './commands/transcripts';
import { doctorCommand, uninstallCommand, updateCommand } from './commands/self';
import { evolveCommand } from './commands/evolve';
import { statusCommand } from './commands/status';
import { listCommand } from './commands/list';
import { effortCommand, jobsCommand, modelCommand, toolsCommand, triggersCommand } from './commands/control';
import {
  alignmentCommand,
  eventsCommand,
  executorsCommand,
  gepaCommand,
  headsCommand,
  mctsCommand,
  memoryCommand,
  releaseCommand,
  stateCommand,
  spendCommand,
  stopCommand,
  timelineCommand,
  webhookCommand,
} from './commands/inspect';
import { debugCommand } from './commands/debug';
import { labelCommand } from './commands/label';
import { exportCommand, importCommand } from './commands/export-import';
import { tokensCommand } from './commands/tokens';
import { workspaceDeleteCommand } from './commands/workspace';
import { printFailure, VERSION } from './display';

/** Help groups, in the order the branded help renders them (first registration
 *  of a group fixes its position). */
const ACCOUNT = 'Account:';
const WORKSPACES = 'Workspaces:';
const RUNNING = 'Running:';
const CONFIGURE = 'Configure:';
const INSPECT = 'Inspect & evolve:';
const THIS_COMPUTER = 'This computer:';

export function buildProgram(): Command {
  const program = new Command();

  program
    .name('kinu')
    .description('Create and chat with self-evolving agent workspaces')
    .version(VERSION, '-v, --version')
    .addHelpCommand(false);

  // Shared LLM options
  const llmOpts = (cmd: Command) => cmd
    .option('--model <id>', 'Model ID (env: KINU_MODEL)')
    .option('--base-url <url>', 'LLM API base URL (env: KINU_BASE_URL)')
    .option('--auth <header>', 'Auth header value (env: KINU_AUTH)');

  // ── Account ────────────────────────────────────────────────────

  program
    .command('setup')
    .helpGroup(ACCOUNT)
    .description('Connect your account; optionally configure local-only model credentials')
    .option('--origin <url>', 'Kinu app origin')
    .option('--provider <name>', 'Provider: codex, openai, openrouter, anthropic, openai-compatible, skip')
    .option('--model <id>', 'Default model for the selected provider')
    .option('--local-model', 'Configure credentials for local-only agents')
    .option('--local', 'Keep the provider key on this machine instead of your Kinu account')
    .option('-y, --yes', 'Accept recommended setup choices where possible')
    .option('--skip-cloud', 'Skip account sign-in')
    .addOption(new Option('--account-only', 'Only complete Kinu account sign-in').hideHelp())
    .action(wrapAction(setupCommand));

  program
    .command('provider [action] [name]')
    .alias('providers')
    .helpGroup(ACCOUNT)
    .description('List, connect, or disconnect model and account providers')
    .option('--origin <url>', 'Kinu app origin')
    .option('--model <id>', 'Default model for the selected provider')
    .option('--local', 'Keep the provider key on this machine instead of your Kinu account')
    .action(wrapAction(providersCommand));

  program
    .command('auth')
    .helpGroup(ACCOUNT)
    .description('Sign the CLI into your Kinu account')
    .option('--origin <url>', 'Kinu app origin')
    .action(wrapAction(authCommand));

  program
    .command('whoami')
    .helpGroup(ACCOUNT)
    .description('Show the signed-in Kinu account')
    .option('--origin <url>', 'Kinu app origin')
    .action(wrapAction(whoamiCommand));

  program
    .command('logout')
    .helpGroup(ACCOUNT)
    .description('Sign out of the Kinu CLI')
    .option('--origin <url>', 'Kinu app origin')
    .action(wrapAction(logoutCommand));

  program
    .command('tokens [action] [name]')
    .helpGroup(ACCOUNT)
    .description('Manage long-lived CI access tokens (list, create, revoke)')
    .option('--name <name>', 'Token name for create')
    .option('--scopes <scopes>', 'Comma-separated scopes: workspace.exec, workspace.read')
    .option('--json', 'Print raw JSON')
    .action(wrapAction(tokensCommand));

  // ── Workspaces ─────────────────────────────────────────────────

  llmOpts(
    program
      .command('create [name]')
      .helpGroup(WORKSPACES)
      .description('Create a new workspace')
      .option('--purpose <text>', 'Mission — what this workspace is for (seeds SOUL.md)')
      .option('--mode <mode>', 'Workspace mode: cloud or local')
      .option('--alias <name>', 'Create an executable alias command')
      .option('--origin <url>', 'Kinu app origin for first-use sign-in')
      .option('--join', 'Add an agent to the workspace already here, inheriting its mission — no name or purpose needed')
      .option('--no-alias-shim', 'Do not create an alias shim'),
  ).action(wrapAction(createCommand));

  program
    .command('list')
    .helpGroup(WORKSPACES)
    .description('List all workspaces')
    .action(wrapAction(listCommand));

  llmOpts(
    program
      .command('status <name>')
      .helpGroup(WORKSPACES)
      .description('Show workspace state and evolution history'),
  ).action(wrapAction(statusCommand));

  program
    .command('workspace')
    .helpGroup(WORKSPACES)
    .description('Manage cloud workspaces')
    .command('delete <name>')
    .description('Permanently delete a cloud workspace')
    .option('-y, --yes', 'Skip the confirmation prompt')
    .action(wrapAction(workspaceDeleteCommand));

  program
    .command('alias <workspace> [alias]')
    .helpGroup(WORKSPACES)
    .description('Create an executable command alias for a workspace')
    .action(wrapAction(aliasCommand));

  program
    .command('unalias <alias>')
    .helpGroup(WORKSPACES)
    .description('Remove an executable command alias')
    .action(wrapAction(unaliasCommand));

  program
    .command('aliases')
    .helpGroup(WORKSPACES)
    .description('List configured workspace aliases')
    .action(wrapAction(aliasesCommand));

  program
    .command('export <name>')
    .helpGroup(WORKSPACES)
    .description('Back up a workspace (local or cloud) to a portable archive')
    .option('-o, --output <file>', 'Output file path')
    .action(wrapAction(exportCommand));

  program
    .command('import <file>')
    .helpGroup(WORKSPACES)
    .description('Restore a workspace archive into a local workspace')
    .option('-n, --name <name>', 'Workspace name (default: the name recorded in the archive)')
    .action(wrapAction(importCommand));

  // ── Running ────────────────────────────────────────────────────

  llmOpts(
    program
      .command('run <name> [prompt...]')
      .helpGroup(RUNNING)
      .description('Run a workspace once, or open chat when no prompt is provided')
      .option('--mode <mode>', 'Output mode: text, json, or rpc', 'text')
      .option('--transcript-dir <dir>', 'Override transcript storage directory')
      .option('--no-transcript', 'Do not record a transcript for this run'),
  ).action(wrapAction(runCommand));

  llmOpts(
    program
      .command('chat [name]')
      .helpGroup(RUNNING)
      .description('Interactive conversation with a workspace')
      .option('--classic', 'Use classic readline interface instead of TUI')
      .option('--transcript-dir <dir>', 'Override transcript storage directory')
      .option('--no-transcript', 'Do not record a transcript for this chat'),
  ).action(wrapAction(chatCommand));

  llmOpts(
    program
      .command('acp <name>')
      .helpGroup(RUNNING)
      .description('Serve a workspace over the Agent Client Protocol on stdio (Zed, JetBrains, neovim)')
      .option('--no-auto-evolve', 'Run without turn/session auto-evolution (local workspaces)')
      .option('--transcript-dir <dir>', 'Override transcript storage directory'),
  ).action(wrapAction(acpCommand));

  llmOpts(
    program
      .command('exec [prompt...]')
      .helpGroup(RUNNING)
      .description('Run one workspace task headlessly and exit (CI-friendly; executor passthrough lives under `executors`)')
      .option('-w, --workspace <name>', 'Workspace to run (defaults to the only configured workspace)')
      .option('--json', 'Emit line-delimited JSON events')
      .option('--no-auto-evolve', 'Run without turn/session auto-evolution (local workspaces)')
      .option('--transcript-dir <dir>', 'Override transcript storage directory')
      .option('--no-transcript', 'Do not record a transcript for this run'),
  ).action(wrapAction(execCommand));

  program
    .command('executors <name> [executor] [command...]')
    .helpGroup(RUNNING)
    .description('List executors, or run a command in one')
    .option('--json', 'Print raw JSON')
    .action(wrapAction(executorsCommand));

  program
    .command('transcripts [agent]')
    .helpGroup(RUNNING)
    .description('List recorded terminal transcripts (diagnostics; never conversations)')
    .option('--transcript-dir <dir>', 'Override transcript storage directory')
    .option('--path', 'Show transcript file paths')
    .option('--show <idOrPath>', 'Show a specific transcript path')
    .action(wrapAction(transcriptsCommand));

  program
    .command('stop <name>')
    .helpGroup(RUNNING)
    .description('Stop current cloud work or cancel local background jobs')
    .option('--json', 'Print raw JSON')
    .action(wrapAction(stopCommand));

  // ── Configure ──────────────────────────────────────────────────

  llmOpts(
    program
      .command('model <name> [spec]')
      .helpGroup(CONFIGURE)
      .description('Show or change a workspace model'),
  ).action(wrapAction(modelCommand));

  program
    .command('effort <name> [level]')
    .helpGroup(CONFIGURE)
    .description('Show or change workspace reasoning effort (low, medium, high)')
    .action(wrapAction(effortCommand));

  llmOpts(
    program
      .command('tools <name>')
      .helpGroup(CONFIGURE)
      .description('List a workspace tool surface'),
  ).action(wrapAction(toolsCommand));

  llmOpts(
    program
      .command('triggers <name> [action] [value]')
      .helpGroup(CONFIGURE)
      .description('List, schedule, cancel, or create workspace triggers')
      .option('--auth-mode <mode>', 'Webhook auth mode: hmac, bearer, or mtls')
      .option('--secret <value>', 'Webhook secret for hmac or bearer auth')
      .option('--content-type <type>', 'Accepted webhook content type')
      .option('--rate-limit <n>', 'Webhook deliveries per minute')
      .option('--json', 'Print raw JSON'),
  ).action(wrapAction(triggersCommand));

  program
    .command('webhook <name> <label>')
    .helpGroup(CONFIGURE)
    .description('Create a durable webhook trigger for a cloud workspace')
    .option('--auth-mode <mode>', 'Webhook auth mode: hmac, bearer, or mtls')
    .option('--secret <value>', 'Webhook secret for hmac or bearer auth')
    .option('--content-type <type>', 'Accepted webhook content type')
    .option('--rate-limit <n>', 'Webhook deliveries per minute')
    .option('--json', 'Print raw JSON')
    .action(wrapAction(webhookCommand));

  // ── Inspect & evolve ───────────────────────────────────────────

  llmOpts(
    program
      .command('evolve <name>')
      .helpGroup(INSPECT)
      .description('Trigger an MCTS evolution cycle')
      .option('--budget <n>', 'MCTS iterations (default: the engine default)')
      .option('--branches <n>', 'Branches per expansion (default: the engine default)')
      .option('--max-cost <usd>', 'Cost ceiling in USD (default: the engine default)'),
  ).action(wrapAction(evolveCommand));

  llmOpts(
    program
      .command('jobs <name> [action] [id]')
      .helpGroup(INSPECT)
      .description('List or cancel background jobs')
      .option('--json', 'Print raw JSON'),
  ).action(wrapAction(jobsCommand));

  program
    .command('state <name>')
    .helpGroup(INSPECT)
    .description('Show the durable workspace state snapshot')
    .option('--json', 'Print raw JSON')
    .action(wrapAction(stateCommand));

  program
    .command('spend <name>')
    .helpGroup(INSPECT)
    .description('Show what the whole workspace spent, by producer and by mission')
    .option('--json', 'Print raw JSON')
    .action(wrapAction(spendCommand));

  program
    .command('memory <name> [query...]')
    .helpGroup(INSPECT)
    .description('Read or search workspace memory')
    .option('--limit <n>', 'Search result limit')
    .option('--json', 'Print raw JSON')
    .action(wrapAction(memoryCommand));

  program
    .command('events <name>')
    .helpGroup(INSPECT)
    .description('List recent workspace events')
    .option('--variant <name>', 'Filter by event variant')
    .option('--since <time>', 'Filter events after a timestamp or date')
    .option('--limit <n>', 'Event limit')
    .option('--json', 'Print raw JSON')
    .action(wrapAction(eventsCommand));

  program
    .command('timeline <name>')
    .helpGroup(INSPECT)
    .description('List the run/evolution/MCTS timeline')
    .option('--limit <n>', 'Timeline row limit')
    .option('--json', 'Print raw JSON')
    .action(wrapAction(timelineCommand));

  program
    .command('mcts <name> [nodeId]')
    .helpGroup(INSPECT)
    .description('Inspect MCTS search history')
    .option('--json', 'Print raw JSON')
    .action(wrapAction(mctsCommand));

  program
    .command('heads <name>')
    .helpGroup(INSPECT)
    .description('Inspect parallel reasoning branch runs')
    .option('--limit <n>', 'Run limit')
    .option('--json', 'Print raw JSON')
    .action(wrapAction(headsCommand));

  program
    .command('debug <name>')
    .helpGroup(INSPECT)
    .description('Fetch everything about a workspace into one bundle: identity, messages, runs and ' +
      'their events, heads, MCTS searches, background jobs, evolution state, memory and facts')
    .option('-o, --out <file>', 'Bundle output path (default: <name>.debug.jsonl)')
    .option('--runs <n>', 'How many recent runs/head-runs/searches to page through')
    .option('--limit <n>', 'Row limit for the smaller sections (messages, jobs, facts, ...)')
    .option('--json', 'Print the assembled summary as JSON instead of a human report')
    .action(wrapAction(debugCommand));

  program
    .command('gepa <name> [runId]')
    .helpGroup(INSPECT)
    .description('Inspect GEPA optimization runs, or run a pass with --run')
    .option('--run', 'Run one optimisation pass over the scaffold')
    .option('--iterations <n>', 'Reflection iterations (--run)')
    .option('--eval-size <n>', 'Labeled turns to draw the split from (--run)')
    .option('--metric-calls <n>', 'Metric-call ceiling (--run)')
    .option('--limit <n>', 'Run limit')
    .option('--json', 'Print raw JSON')
    .action(wrapAction(gepaCommand));

  program
    .command('alignment <name>')
    .helpGroup(INSPECT)
    .description('K_align: correction rate per 100 graded turns, by scaffold version, with 95% intervals')
    .option('--json', 'Print raw JSON')
    .action(wrapAction(alignmentCommand));

  program
    .command('label [action] [name] [file]')
    .helpGroup(INSPECT)
    .description('Hand-label turn outcomes (export | ingest | ensemble | report) to measure and correct the ' +
      'classifier; mine | score for the free behavioural corpus')
    .option('--out <file>', 'Where to write the labeling file (export) or the corpus report (mine, score)')
    .option('--size <n>', 'Turns to draw (export)')
    .option('--labeler <name>', 'Who is labeling (ingest)')
    .option('--models <a,b>', 'Judges to run, comma-separated (ensemble, score; default: one per connected vendor)')
    .option('--root <dir>', 'Claude Code transcript root (mine, score; default: ~/.claude/projects)')
    .option('--projects <a,b>', 'Only projects whose directory name contains one of these (mine, score)')
    .option('--limit <n>', 'Labeled turns to put to the raters (score; default: 25)')
    .option('--json', 'Print raw JSON')
    .action(wrapAction(labelCommand));

  program
    .command('release <name>')
    .helpGroup(INSPECT)
    .description('Inspect the governed release lane: sources, changes, checks, approvals, deployments')
    .option('--limit <n>', 'Change limit')
    .option('--json', 'Print raw JSON')
    .action(wrapAction(releaseCommand));

  // ── This computer ──────────────────────────────────────────────

  program
    .command('connect')
    .helpGroup(THIS_COMPUTER)
    .description('Link this computer as the desktop execution daemon (the link renews itself while the daemon connects; re-run this after 180 idle days)')
    .option('--label <name>', 'Name for this device (default: user@hostname); skips the name prompt')
    .action(wrapAction((opts: { label?: string }) => desktopCommand('connect', opts)));

  program
    .command('desktop [action]')
    .helpGroup(THIS_COMPUTER)
    .description('Connect or inspect the local desktop execution daemon')
    .option('--label <name>', 'Name for this device (default: user@hostname); skips the name prompt')
    .action(wrapAction(desktopCommand));

  program
    .command('daemon [action] [workspace]')
    .helpGroup(THIS_COMPUTER)
    .description('Manage the local scheduler daemon: start, stop, restart, status, logs, tick')
    .action(wrapAction(daemonCommand));

  program
    .command('doctor')
    .helpGroup(THIS_COMPUTER)
    .description('Inspect local Kinu CLI installation state')
    .action(wrapAction(doctorCommand));

  program
    .command('update [target]')
    .helpGroup(THIS_COMPUTER)
    .description('Update the installed Kinu command')
    .option('--origin <url>', 'Kinu app origin')
    .option('--force', 'Reinstall even if already current')
    .action(wrapAction(updateCommand));

  program
    .command('uninstall')
    .helpGroup(THIS_COMPUTER)
    .description('Remove the installed Kinu command')
    .option('--purge', 'Also remove ~/.kinu data')
    .action(wrapAction(uninstallCommand));

  return program;
}

/** Wrap async actions with consistent error handling. The argument tuple stays
 *  generic so each command keeps Commander's own arity and parameter checking;
 *  widening it to `any[]` silently accepted a handler with the wrong signature.
 *
 *  The failure is caught by a `catch` BINDING rather than a `.catch` callback
 *  parameter. Both give `printFailure` an `unknown` — `strict` implies
 *  `useUnknownInCatchVariables` — but only the binding gets there without
 *  declaring `unknown` as a parameter type, which is what the callback form
 *  had to do and what KINU-069's gate refuses. Nothing is cast or suppressed.
 *  The IIFE is `void`ed because Commander's action handler returns nothing: a
 *  returned promise would be a floating one at every call site instead of one
 *  here. */
function wrapAction<Args extends readonly unknown[]>(fn: (...args: Args) => Promise<void>) {
  return (...args: Args) => {
    void (async () => {
      try {
        await fn(...args);
      } catch (error) {
        printFailure({ cause: error });
        process.exit(1);
      }
    })();
  };
}
