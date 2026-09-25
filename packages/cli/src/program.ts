/** Command registry; root help (display.ts renderHelp) derives from it. */

import { Command, Option } from 'commander';
import { MODEL_OPTION_FLAG } from './options';
import { createCommand } from './commands/create';
import { acpCommand } from './commands/acp';
import { chatCommand } from './commands/chat';
import { execCommand, runCommand } from './commands/run';
import { authCommand, logoutCommand, sessionsCommand, whoamiCommand } from './commands/auth';
import { aliasCommand, aliasesCommand, unaliasCommand } from './commands/alias';
import { desktopCommand } from './commands/desktop';
import { daemonCommand } from './commands/daemon';
import { deployCommand } from './commands/deploy';
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
  actorsCommand,
  stateCommand,
  spendCommand,
  stopCommand,
  timelineCommand,
  webhookCommand,
} from './commands/inspect';
import { debugCommand } from './commands/debug';
import { labelCommand } from './commands/label';
import { exportCommand, importCommand } from './commands/export-import';
import { ACCESS_TOKEN_SCOPES, tokensCommand } from './commands/tokens';
import { workspaceDeleteCommand } from './commands/workspace';
import { printFailure, setCommandExample, VERSION } from './display';

/** Render order; a group's first registration fixes its position. */
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
    .helpOption('-h, --help', 'Show help for this command')
    .addHelpCommand(false);

  const llmOpts = (cmd: Command) => cmd
    .option(`${MODEL_OPTION_FLAG} <id>`, 'Model ID (env: KINU_MODEL)')
    .option('--base-url <url>', 'Base URL of your own model endpoint (env: KINU_BASE_URL)')
    .option('--auth <header>', 'Auth header value for that endpoint (env: KINU_AUTH)');

  program
    .command('setup')
    .helpGroup(ACCOUNT)
    .description('Sign in to Kinu and pick a model provider for local workspaces')
    .option('--origin <url>', 'Kinu app origin')
    .option('--provider <name>', 'Provider: workers-ai, codex, openai, openrouter, anthropic, openai-compatible, opencode, skip')
    .option(`${MODEL_OPTION_FLAG} <id>`, 'Default model for the selected provider')
    .option('--local-model', 'Set up a model provider for local workspaces')
    .option('--local', 'Keep the provider key on this machine instead of your Kinu account')
    .option('-y, --yes', 'Take the recommended choice at each prompt where there is one')
    .option('--skip-cloud', 'Skip account sign-in')
    .addOption(new Option('--account-only', 'Only sign in to Kinu').hideHelp())
    .action(wrapAction(setupCommand));

  program
    .command('provider [action] [name] [account]')
    .alias('providers')
    .helpGroup(ACCOUNT)
    .description('List, connect or disconnect model providers and their accounts, and pick each default account')
    .option('--origin <url>', 'Kinu app origin')
    .option(`${MODEL_OPTION_FLAG} <id>`, 'Default model for the selected provider')
    .option('--local', 'Keep the provider key on this machine instead of your Kinu account')
    .action(wrapAction(providersCommand));

  program
    .command('auth')
    .helpGroup(ACCOUNT)
    .description('Sign in to your Kinu account')
    .option('--origin <url>', 'Kinu app origin')
    .action(wrapAction(authCommand));

  program
    .command('whoami')
    .helpGroup(ACCOUNT)
    .description('Show which Kinu account you are signed in to')
    .option('--origin <url>', 'Kinu app origin')
    .action(wrapAction(whoamiCommand));

  program
    .command('logout')
    .helpGroup(ACCOUNT)
    .description('Sign out and revoke this CLI session')
    .option('--origin <url>', 'Kinu app origin')
    .action(wrapAction(logoutCommand));

  program
    .command('sessions [action] [hash]')
    .helpGroup(ACCOUNT)
    .description('List or revoke CLI sessions')
    .option('--origin <url>', 'Kinu app origin')
    .action(wrapAction(sessionsCommand));

  program
    .command('tokens [action] [name]')
    .helpGroup(ACCOUNT)
    .description('List, create or revoke access tokens for CI')
    .option('--name <name>', 'Token name for create')
    .option('--scopes <scopes>', `Comma-separated scopes: ${ACCESS_TOKEN_SCOPES.join(', ')}`)
    .option('--json', 'Print raw JSON')
    .action(wrapAction(tokensCommand));

  llmOpts(
    program
      .command('create [name]')
      .helpGroup(WORKSPACES)
      .description('Create a workspace')
      .option('--purpose <text>', 'Say what this workspace is for. It seeds SOUL.md')
      .option('--mode <mode>', 'Workspace mode: cloud or local')
      .option('--alias <name>', 'Also create a shell command with this name that runs the workspace')
      .option('--origin <url>', 'Kinu app origin for first-use sign-in')
      .option('--join', 'Add an agent to the workspace in this directory. It takes the workspace mission, so it needs no name or purpose')
      .option('--no-alias-shim', 'Do not create the alias shell command'),
  ).action(wrapAction(createCommand));

  program
    .command('list')
    .helpGroup(WORKSPACES)
    .description('List your workspaces')
    .action(wrapAction(listCommand));

  llmOpts(
    program
      .command('status <name>')
      .helpGroup(WORKSPACES)
      .description('Show a workspace\'s mission, model and evolution state'),
  ).action(wrapAction(statusCommand));

  program
    .command('workspace')
    .helpGroup(WORKSPACES)
    .description('Manage cloud workspaces')
    .command('delete <name>')
    .description('Delete a cloud workspace for good')
    .option('-y, --yes', 'Skip the confirmation prompt')
    .action(wrapAction(workspaceDeleteCommand));

  program
    .command('alias <workspace> [alias]')
    .helpGroup(WORKSPACES)
    .description('Create a shell command that runs a workspace')
    .action(wrapAction(aliasCommand));

  program
    .command('unalias <alias>')
    .helpGroup(WORKSPACES)
    .description('Remove a workspace\'s shell command')
    .action(wrapAction(unaliasCommand));

  program
    .command('aliases')
    .helpGroup(WORKSPACES)
    .description('List workspace shell commands')
    .action(wrapAction(aliasesCommand));

  program
    .command('export <name>')
    .helpGroup(WORKSPACES)
    .description('Back up a workspace, local or cloud, to an archive file')
    .option('-o, --output <file>', 'Output file path')
    .action(wrapAction(exportCommand));

  program
    .command('import <file>')
    .helpGroup(WORKSPACES)
    .description('Restore a workspace archive as a local workspace')
    .option('-n, --name <name>', 'Workspace name (default: the name recorded in the archive)')
    .action(wrapAction(importCommand));

  llmOpts(
    program
      .command('run <name> [prompt...]')
      .helpGroup(RUNNING)
      .description('Run one prompt in a workspace, or open chat when there is no prompt')
      .option('--mode <mode>', 'Output mode: text, json, or rpc', 'text')
      .option('--transcript-dir <dir>', 'Where to store transcripts')
      .option('--no-transcript', 'Do not record a transcript for this run'),
  ).action(wrapAction(runCommand));

  llmOpts(
    program
      .command('chat [name]')
      .helpGroup(RUNNING)
      .description('Chat with a workspace')
      .option('--classic', 'Use the line-by-line chat instead of the full-screen TUI')
      .option('--transcript-dir <dir>', 'Where to store transcripts')
      .option('--no-transcript', 'Do not record a transcript for this chat'),
  ).action(wrapAction(chatCommand));

  llmOpts(
    program
      .command('acp <name>')
      .helpGroup(RUNNING)
      .description('Serve a workspace over the Agent Client Protocol on stdio (Zed, JetBrains, neovim, Marimo)')
      .option('--no-auto-evolve', 'Turn off evolution after turns and sessions (local workspaces)')
      .option('--transcript-dir <dir>', 'Where to store transcripts'),
  ).action(wrapAction(acpCommand));

  llmOpts(
    program
      .command('exec [prompt...]')
      .helpGroup(RUNNING)
      .description('Run one task without the TUI and exit, for CI and scripts')
      .option('-w, --workspace <name>', 'Workspace to run (default: the only one configured)')
      .option('--json', 'Emit line-delimited JSON events')
      .option('--no-auto-evolve', 'Turn off evolution after turns and sessions (local workspaces)')
      .option('--transcript-dir <dir>', 'Where to store transcripts')
      .option('--no-transcript', 'Do not record a transcript for this run'),
  ).action(wrapAction(execCommand));

  program
    .command('executors <name> [executor] [command...]')
    .helpGroup(RUNNING)
    .description('List a workspace\'s executors, or run a command in one')
    .option('--json', 'Print raw JSON')
    .action(wrapAction(executorsCommand));

  program
    .command('transcripts [agent]')
    .helpGroup(RUNNING)
    .description('List terminal transcripts recorded for diagnostics (they cannot be reopened as chats)')
    .option('--transcript-dir <dir>', 'Where transcripts are stored')
    .option('--path', 'Show transcript file paths')
    .option('--show <idOrPath>', 'Show one transcript\'s file path')
    .action(wrapAction(transcriptsCommand));

  program
    .command('stop <name>')
    .helpGroup(RUNNING)
    .description('Stop a cloud workspace\'s current work, or cancel a local workspace\'s background jobs')
    .option('--json', 'Print raw JSON')
    .action(wrapAction(stopCommand));

  llmOpts(
    program
      .command('model <name> [spec]')
      .helpGroup(CONFIGURE)
      .description('Show or change a workspace\'s model'),
  ).action(wrapAction(modelCommand));

  program
    .command('effort <name> [level]')
    .helpGroup(CONFIGURE)
    .description('Show or change a workspace\'s reasoning effort')
    .action(wrapAction(effortCommand));

  llmOpts(
    program
      .command('tools <name>')
      .helpGroup(CONFIGURE)
      .description('List the tools a workspace can use'),
  ).action(wrapAction(toolsCommand));

  llmOpts(
    program
      .command('triggers <name> [action] [value]')
      .helpGroup(CONFIGURE)
      .description('List, schedule, cancel or create workspace triggers')
      .option('--auth-mode <mode>', 'Webhook auth mode: hmac, bearer, or mtls')
      .option('--secret <value>', 'Webhook secret for hmac or bearer auth')
      .option('--content-type <type>', 'Accepted webhook content type')
      .option('--rate-limit <n>', 'Webhook deliveries per minute')
      .option('--json', 'Print raw JSON'),
  ).action(wrapAction(triggersCommand));

  program
    .command('webhook <name> <label>')
    .helpGroup(CONFIGURE)
    .description('Create a webhook trigger for a cloud workspace')
    .option('--auth-mode <mode>', 'Webhook auth mode: hmac, bearer, or mtls')
    .option('--secret <value>', 'Webhook secret for hmac or bearer auth')
    .option('--content-type <type>', 'Accepted webhook content type')
    .option('--rate-limit <n>', 'Webhook deliveries per minute')
    .option('--json', 'Print raw JSON')
    .action(wrapAction(webhookCommand));

  llmOpts(
    program
      .command('evolve <name>')
      .helpGroup(INSPECT)
      .description('Run an MCTS search for one improvement to a local workspace')
      .option('--budget <n>', 'MCTS iterations (default: the engine default)')
      .option('--branches <n>', 'Branches per expansion (default: the engine default)')
      .option('--max-cost <usd>', 'Cost limit in USD (default: the engine default)'),
  ).action(wrapAction(evolveCommand));

  llmOpts(
    program
      .command('jobs <name> [action] [id]')
      .helpGroup(INSPECT)
      .description('List or cancel background jobs')
      .option('--json', 'Print raw JSON'),
  ).action(wrapAction(jobsCommand));

  program
    .command('actors <name> [actorId]')
    .helpGroup(INSPECT)
    .description('List every actor a workspace holds, or show one by id')
    .option('--json', 'Print raw JSON')
    .action(wrapAction(actorsCommand));

  program
    .command('state <name>')
    .helpGroup(INSPECT)
    .description('Show the workspace state snapshot')
    .option('--json', 'Print raw JSON')
    .action(wrapAction(stateCommand));

  program
    .command('spend <name>')
    .helpGroup(INSPECT)
    .description('Show what a workspace spent, by producer and by mission')
    .option('--json', 'Print raw JSON')
    .action(wrapAction(spendCommand));

  program
    .command('memory <name> [query...]')
    .helpGroup(INSPECT)
    .description('Read or search a workspace\'s memory')
    .option('--limit <n>', 'Search result limit')
    .option('--json', 'Print raw JSON')
    .action(wrapAction(memoryCommand));

  program
    .command('events <name>')
    .helpGroup(INSPECT)
    .description('List a workspace\'s recent events')
    .option('--variant <name>', 'Filter by event variant')
    .option('--since <time>', 'Filter events after a timestamp or date')
    .option('--limit <n>', 'Event limit')
    .option('--json', 'Print raw JSON')
    .action(wrapAction(eventsCommand));

  program
    .command('timeline <name>')
    .helpGroup(INSPECT)
    .description('List a workspace\'s runs, evolutions and MCTS searches in order')
    .option('--limit <n>', 'Timeline row limit')
    .option('--json', 'Print raw JSON')
    .action(wrapAction(timelineCommand));

  program
    .command('mcts <name> [nodeId]')
    .helpGroup(INSPECT)
    .description('Show a workspace\'s MCTS search history')
    .option('--json', 'Print raw JSON')
    .action(wrapAction(mctsCommand));

  program
    .command('heads <name>')
    .helpGroup(INSPECT)
    .description('Show parallel reasoning branch runs')
    .option('--limit <n>', 'Run limit')
    .option('--json', 'Print raw JSON')
    .action(wrapAction(headsCommand));

  program
    .command('debug <name>')
    .helpGroup(INSPECT)
    .description('Save everything about a workspace to one file: identity, messages, runs and '
      + 'their events, heads, MCTS searches, background jobs, evolution state, memory and facts')
    .option('-o, --out <file>', 'Bundle output path (default: <name>.debug.jsonl)')
    .option('--runs <n>', 'How many recent runs, head runs and searches to include')
    .option('--limit <n>', 'Row limit for the smaller sections (messages, jobs, facts and so on)')
    .option('--json', 'Print the summary as JSON instead of text')
    .action(wrapAction(debugCommand));

  program
    .command('gepa <name> [runId]')
    .helpGroup(INSPECT)
    .description('Show GEPA optimisation runs, or run one pass with --run')
    .option('--run', 'Run one optimisation pass over the scaffold')
    .option('--iterations <n>', 'Reflection iterations (--run)')
    .option('--eval-size <n>', 'Labeled turns to draw the split from (--run)')
    .option('--metric-calls <n>', 'Most metric calls to make (--run)')
    .option('--limit <n>', 'Run limit')
    .option('--json', 'Print raw JSON')
    .action(wrapAction(gepaCommand));

  program
    .command('alignment <name>')
    .helpGroup(INSPECT)
    .description('Show K_align: corrections per 100 graded turns for each scaffold version, with 95% intervals')
    .option('--json', 'Print raw JSON')
    .action(wrapAction(alignmentCommand));

  program
    .command('label [action] [name] [file]')
    .helpGroup(INSPECT)
    .description('Label turn outcomes by hand to measure and correct the classifier (export, ingest, '
      + 'ensemble, report), or build a corpus from Claude Code transcripts (mine, score)')
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
    .command('connect')
    .helpGroup(THIS_COMPUTER)
    .description('Connect this computer so your agents can run commands on it')
    .option('--label <name>', 'Name for this device (default: the hostname); skips the name prompt')
    .action(wrapAction((opts: { label?: string }) => desktopCommand('connect', opts)));

  program
    .command('desktop [action]')
    .helpGroup(THIS_COMPUTER)
    .description('Connect this computer, or show its connection status and daemon logs')
    .option('--label <name>', 'Name for this device (default: the hostname); skips the name prompt')
    .action(wrapAction(desktopCommand));

  program
    .command('daemon [action] [workspace]')
    .helpGroup(THIS_COMPUTER)
    .description('Start, stop or check the local scheduler daemon, or run one pass by hand with tick')
    .action(wrapAction(daemonCommand));

  program
    .command('deploy [target] [action]')
    .helpGroup(THIS_COMPUTER)
    .description('Run your own Kinu: `deploy cloudflare` in your Cloudflare account, '
      + '`deploy local [start|stop|status]` on this computer')
    .option('--origin <url>', 'Kinu app origin')
    .option('--port <n>', 'Port for the local instance (default 8787)')
    .action(wrapAction(deployCommand));

  program
    .command('doctor')
    .helpGroup(THIS_COMPUTER)
    .description('Check the installed Kinu CLI: paths, origin and version')
    .action(wrapAction(doctorCommand));

  program
    .command('update [target]')
    .helpGroup(THIS_COMPUTER)
    .description('Update the installed Kinu command')
    .option('--origin <url>', 'Kinu app origin')
    .option('--force', 'Reinstall even when already up to date')
    // Detached startup-check child: refresh silently, leave the launcher alone.
    .addOption(new Option('--background', 'Stage and swap the CLI tree silently').hideHelp())
    .action(wrapAction(updateCommand));

  program
    .command('uninstall')
    .helpGroup(THIS_COMPUTER)
    .description('Remove the installed Kinu command')
    .option('--purge', 'Also delete ~/.kinu and everything in it')
    .action(wrapAction(uninstallCommand));

  for (const [path, example] of COMMAND_EXAMPLES) setCommandExample(commandAt(program, path), example);

  return program;
}

/** One real invocation for each command, by the words a user types after `kinu`. */
const COMMAND_EXAMPLES: ReadonlyArray<readonly [string, string]> = [
  ['setup', 'kinu setup --provider codex'],
  ['provider', 'kinu provider connect openrouter'],
  ['auth', 'kinu auth'],
  ['whoami', 'kinu whoami'],
  ['logout', 'kinu logout'],
  ['sessions', 'kinu sessions revoke --all'],
  ['tokens', 'kinu tokens create --name ci --scopes workspace.read,workspace.exec'],
  ['create', 'kinu create jarvis --mode local --purpose "Keep this repo\'s tests green"'],
  ['list', 'kinu list'],
  ['status', 'kinu status jarvis'],
  ['workspace delete', 'kinu workspace delete jarvis'],
  ['alias', 'kinu alias jarvis j'],
  ['unalias', 'kinu unalias j'],
  ['aliases', 'kinu aliases'],
  ['export', 'kinu export jarvis -o jarvis.kinu.jsonl'],
  ['import', 'kinu import jarvis.kinu.jsonl --name jarvis-copy'],
  ['run', 'kinu run jarvis "summarise yesterday\'s commits"'],
  ['chat', 'kinu chat jarvis'],
  ['acp', 'kinu acp jarvis'],
  ['exec', 'kinu exec -w jarvis --json "run the test suite and report failures"'],
  ['executors', 'kinu executors jarvis'],
  ['transcripts', 'kinu transcripts jarvis --path'],
  ['stop', 'kinu stop jarvis'],
  ['model', 'kinu model jarvis anthropic/claude-sonnet-4-7'],
  ['effort', 'kinu effort jarvis high'],
  ['tools', 'kinu tools jarvis'],
  ['triggers', 'kinu triggers jarvis every "0 9 * * 1-5"'],
  ['webhook', 'kinu webhook jarvis github-push --auth-mode hmac --secret "$HOOK_SECRET"'],
  ['evolve', 'kinu evolve jarvis --budget 4'],
  ['jobs', 'kinu jobs jarvis'],
  ['actors', 'kinu actors jarvis'],
  ['state', 'kinu state jarvis --json'],
  ['spend', 'kinu spend jarvis'],
  ['memory', 'kinu memory jarvis deploy steps'],
  ['events', 'kinu events jarvis --since 2026-09-01 --limit 20'],
  ['timeline', 'kinu timeline jarvis --limit 20'],
  ['mcts', 'kinu mcts jarvis'],
  ['heads', 'kinu heads jarvis --limit 5'],
  ['debug', 'kinu debug jarvis -o jarvis.debug.jsonl'],
  ['gepa', 'kinu gepa jarvis --run --iterations 3'],
  ['alignment', 'kinu alignment jarvis'],
  ['label', 'kinu label export jarvis --size 20'],
  ['connect', 'kinu connect --label studio'],
  ['desktop', 'kinu desktop status'],
  ['daemon', 'kinu daemon tick jarvis'],
  ['deploy', 'kinu deploy local start --port 8787'],
  ['doctor', 'kinu doctor'],
  ['update', 'kinu update'],
  ['uninstall', 'kinu uninstall'],
];

function commandAt(program: Command, path: string): Command {
  let command = program;

  for (const name of path.split(' ')) {
    const next = command.commands.find((child) => child.name() === name);

    if (next === undefined) throw new Error(`No registered command "${path}" to attach an example to`);
    command = next;
  }

  return command;
}

/** The generic tuple keeps Commander's arity checks. */
function wrapAction<Args extends readonly unknown[]>(fn: (...args: Args) => Promise<void>) {
  return async (...args: Args) => {
    try {
      await fn(...args);
    } catch (cause) {
      printFailure({ cause });
      process.exit(1);
    }
  };
}
