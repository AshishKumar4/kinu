import chalk from 'chalk';
import type { Command } from 'commander';
import { BUILTIN_TOOLS, describeToolCall, summarizeToolCall, TUI_MARKS } from '@kinu.run/core';
import type { SearchNode, ReasoningEffort, JsonObject, JsonValue, ToolOutcome } from '@kinu.run/core';
import { clipText } from '@kinu.run/core';
import { guideFailure } from './provider-guidance';
import cliPackage from '../package.json' with { type: 'json' };

// Kinu design tokens; cf-backend index.css :root is the source of truth. Fixed hexes assume a dark terminal.
const INK = {
  sheen: '#E3D2AE',   // --c-accent-fg — brand ink
  thread: '#E0A458',  // --c-accent — fills, strokes, the winning line
  success: '#8FBC8B', // --c-success — mock --good
  warning: '#E8B97A', // --c-warning — derived tan
  danger: '#C97B6B',  // --c-danger — mock --bad
  dim: '#9C9184',     // --c-text-3
} as const;

const BRAND = chalk.bold.hex(INK.sheen)('Kinu');

/** Folded in at bundle time (`bun build --define process.env.KINU_BUILD_STAMP`); a source run carries none. */
const BUILD_STAMP = process.env.KINU_BUILD_STAMP;

const VERSION = BUILD_STAMP === undefined ? cliPackage.version : `${cliPackage.version}+${BUILD_STAMP}`;

const DIM = chalk.dim;

const ACCENT = chalk.hex(INK.thread);

const OK = chalk.hex(INK.success);

const WARN = chalk.hex(INK.warning);

const ERR = chalk.hex(INK.danger);

const MUTED = chalk.hex(INK.dim);

export { BRAND, VERSION, DIM, ACCENT, OK, WARN, ERR, MUTED };

const BOX = { tl: '┌', tr: '┐', bl: '└', br: '┘', h: '─', v: '│' } as const;

function termWidth(): number {
  return Math.min(process.stdout.columns ?? 80, 80);
}

function boxTop(width: number): string {
  return DIM(`${BOX.tl}${'─'.repeat(width - 2)}`);
}

function boxBot(width: number): string {
  return DIM(`${BOX.bl}${'─'.repeat(width - 2)}`);
}

function boxRow(label: string, value: string, width: number): string {
  const raw = `${label}${value}`;
  const padding = Math.max(0, width - 4 - stripAnsi(raw).length);

  return `${DIM(BOX.v)} ${label}${value}${' '.repeat(padding)}`;
}

function stripAnsi(s: string): string {
  return s.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g'), '');
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const isTTY = process.stdout.isTTY ?? false;

export function createSpinner(initialMessage: string) {
  let i = 0;
  let message = initialMessage;
  let timer: ReturnType<typeof setInterval> | null = null;

  const paint = () => {
    process.stdout.write(`\r\x1b[K${ACCENT(SPINNER_FRAMES[i % SPINNER_FRAMES.length])} ${message}`);
    i++;
  };

  return {
    start() {
      if (!isTTY) return;
      timer = setInterval(paint, 80);
    },
    /** Paints immediately, not only on the interval, so a phase shorter than one frame still reaches a terminal. Piped output gets one plain line. */
    update(next: string) {
      message = next;

      if (isTTY) paint();
      else console.log(`${DIM('·')} ${next}`);
    },
    note(line: string) {
      if (isTTY) process.stdout.write(`\r\x1b[K`);
      console.log(line);
    },
    stop(finalMessage?: string) {
      if (timer) clearInterval(timer);

      if (isTTY) process.stdout.write(`\r\x1b[K`);

      if (finalMessage) console.log(`${OK('✓')} ${finalMessage}`);
    },
    fail(finalMessage: string) {
      if (timer) clearInterval(timer);

      if (isTTY) process.stdout.write(`\r\x1b[K`);
      console.log(`${ERR('✗')} ${finalMessage}`);
    },
  };
}

export interface TurnStatus {
  show(label: string): void;
  clear(): void;
  resume(): void;
}

/** Only a client event names the label, so the line never claims work the turn is not doing. `hold` surrenders the row. */
export function createTurnStatus(opts: { hold?: () => boolean; tty?: boolean } = {}): TurnStatus {
  const tty = opts.tty ?? isTTY;
  let frame = 0;
  let label: string | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;

  const draw = () => {
    if (label === null || opts.hold?.()) return;
    process.stdout.write(`\r\x1b[K${ACCENT(SPINNER_FRAMES[frame % SPINNER_FRAMES.length])} ${DIM(label)}`);
    frame++;
  };

  return {
    show(next) {
      label = next;

      if (!tty || timer) return;
      timer = setInterval(draw, 80);
      draw();
    },
    clear() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }

      if (tty && label !== null) process.stdout.write('\r\x1b[K');
    },
    resume() {
      if (label === null || !tty) return;

      timer ??= setInterval(draw, 80);
      draw();
    },
  };
}

export function printCreatedCard(name: string, purpose: string, model: string, dbPath: string): void {
  const w = termWidth();
  const L = (label: string) => DIM(label.padEnd(10));
  console.log('');
  console.log(`${BRAND} ${DIM('· workspace created')}`);
  console.log(boxTop(w));
  console.log(boxRow(L('Name:'), ACCENT(name), w));
  console.log(boxRow(L('Mission:'), clipText(purpose, w - 18), w));
  console.log(boxRow(L('Model:'), MUTED(model), w));
  console.log(boxRow(L('Database:'), MUTED(dbPath), w));
  console.log(boxBot(w));
  console.log(`\n${DIM('Start chatting:')} ${ACCENT(`kinu chat ${name}`)}\n`);
}

export interface AgentStatusInfo {
  name: string;
  purpose: string;
  createdAt: number;
  scaffoldVersion: number;
  searchNodeCount: number;
  taskCount: number;
  craftedToolCount: number;
  memorySize: number;
}

export function printAgentStatus(info: AgentStatusInfo, dbSize: number, extra?: {
  conversationCount?: number;
  model?: string | null;
  reasoningEffort?: ReasoningEffort | null;
}): void {
  const w = termWidth();
  console.log('');
  console.log(`${BRAND} ${DIM('· workspace status')}`);
  console.log(boxTop(w));

  const L = (label: string) => DIM(label.padEnd(14));

  console.log(boxRow(L('Name:'), ACCENT(info.name), w));
  console.log(boxRow(L('Mission:'), info.purpose.slice(0, w - 22), w));
  const created = info.createdAt ? new Date(info.createdAt).toLocaleDateString() : '—';
  console.log(boxRow(L('Created:'), DIM(created), w));
  console.log(boxRow(L('Database:'), DIM(formatBytes(dbSize)), w));
  console.log(boxRow(L('Model:'), extra?.model ?? '(default)', w));
  console.log(boxRow(L('Effort:'), extra?.reasoningEffort ?? 'medium (chat default)', w));
  console.log(DIM(`${BOX.v}${'─'.repeat(w - 3)}`));

  console.log(boxRow(L('Scaffold:'), `v${info.scaffoldVersion}`, w));
  console.log(boxRow(L('MCTS nodes:'), String(info.searchNodeCount), w));
  console.log(boxRow(L('Tasks:'), String(info.taskCount), w));

  if (extra?.conversationCount !== undefined) {
    console.log(boxRow(L('Chats:'), String(extra.conversationCount), w));
  }

  console.log(DIM(`${BOX.v}${'─'.repeat(w - 3)}`));

  console.log(boxRow(L('Tools:'), `${BUILTIN_TOOLS.length} built-in + ${info.craftedToolCount} crafted`, w));
  console.log(boxRow(L('Memory:'), formatBytes(info.memorySize), w));
  console.log(boxBot(w));
  console.log('');
}

export function printAgentList(agents: Array<{
  name: string;
  mode: 'local' | 'cloud';
  purpose: string;
  scaffoldVersion: number;
  lastActive?: string;
  dbSize?: number;
}>): void {
  if (agents.length === 0) {
    console.log(`\n${DIM('No workspaces yet.')} Create one with: ${ACCENT('kinu create <name>')}\n`);

    return;
  }

  console.log('');
  console.log(`${BRAND} ${DIM(`· ${plural(agents.length, 'workspace')}`)}`);
  console.log('');

  // NAME is an identifier users paste into `kinu debug <name>`, so it never clips; PURPOSE absorbs the squeeze.
  const maxName = Math.max(4, ...agents.map(a => a.name.length));
  const nameW = maxName + 2;
  const modeW = 8;
  const purposeW = Math.max(12, termWidth() - nameW - modeW - 24);

  const hdr = `  ${MUTED('NAME'.padEnd(nameW))}${MUTED('MODE'.padEnd(modeW))}${MUTED('PURPOSE'.padEnd(purposeW))} ${MUTED('VER')}  ${MUTED('SIZE')}`;
  console.log(hdr);
  console.log(`  ${DIM('─'.repeat(termWidth() - 4))}`);

  for (const a of agents) {
    const name = ACCENT(a.name.padEnd(nameW));
    const mode = DIM(a.mode.padEnd(modeW));
    const purpose = DIM(a.purpose.slice(0, purposeW - 2).padEnd(purposeW));
    const ver = (a.mode === 'cloud' ? '—' : `v${a.scaffoldVersion}`).padEnd(4);
    const size = a.dbSize ? DIM(formatBytes(a.dbSize).padStart(8)) : DIM('    —   ');
    console.log(`  ${name}${mode}${purpose} ${ver}  ${size}`);
  }

  console.log('');
}

export interface SearchTreeNode {
  depth: number;
  status: string;
  action: string | null;
  value: number;
  visits: number;
}

/** Open reads as pending. */
const SEARCH_STATUS_ICON: Record<SearchTreeNode['status'], string> = {
  terminal: OK('●'),
  pruned: ERR('○'),
  failed: ERR('✗'),
  open: WARN('◌'),
};

export function renderSearchTreeLines(nodes: readonly SearchTreeNode[]): string[] {
  return nodes.map((node) => {
    const indent = '  '.repeat(node.depth + 1);

    const icon = SEARCH_STATUS_ICON[node.status];

    const value = WARN(node.value.toFixed(3));
    const visits = DIM(`n=${node.visits}`);
    const action = clipText((node.action ?? '').replace(/\n/g, ' '), 50);

    return `${indent}${icon} ${value} ${visits} ${DIM(action)}`;
  });
}

export function printSearchTree(nodes: SearchNode[]): void {
  if (nodes.length === 0) {
    console.log(DIM('  (no search history)'));

    return;
  }

  console.log(`\n${DIM('MCTS search tree:')}`);

  for (const line of renderSearchTreeLines(nodes)) console.log(line);
  console.log('');
}

/** Summarized as the web chat card does; the raw-argument fallback applies only to MCP and crafted tools. */
export function printToolCall(toolName: string, args: JsonObject): void {
  console.log(`\n${DIM('  ▸ ')}${MUTED(toolName)} ${DIM('━'.repeat(Math.max(1, 40 - toolName.length)))}`);
  const action = describeToolCall(toolName, args);

  if (action) console.log(`${DIM('  ')}${ACCENT(action)}`);
  const summary = summarizeToolCall(toolName, args);

  if (summary) console.log(`${DIM('  ')}${MUTED(summary)}`);
}

export function printToolResult(result: string, outcome: ToolOutcome): void {
  if (!outcome.success) {
    console.log(ERR('  ' + TUI_MARKS.failure + ' failed (' + (outcome.reason ?? 'unclassified') + ')'));

    for (const line of result.split('\n')) console.log(MUTED('      ' + line));

    return;
  }

  const lines = result.split('\n');

  for (const line of lines.slice(0, 5)) {
    console.log(`${DIM('  → ')}${MUTED(clipText(line, 70))}`);
  }

  if (lines.length > 5) console.log(DIM(`  → … (${lines.length - 5} more lines)`));
  console.log(DIM('  ' + '━'.repeat(44)));
}

const EVOLUTION_ICONS = new Map<string, string>([
  ['reflection', '◔'], ['craft_discovered', '✚'], ['consolidation', '⟳'],
  ['scaffold_proposed', '✎'], ['mcts_started', '⌕'], ['mcts_complete', '✓'],
]);

export function printEvolutionEvent(type: string, message: string): void {
  const icon = EVOLUTION_ICONS.get(type) ?? '•';
  console.log(MUTED(`  ${icon} ${clipText(message, 70)}`));
}

export function printError(message: string, hint?: string): void {
  console.error(`\n${ERR('error')} ${message}`);

  if (hint) console.error(`${DIM('hint:')} ${hint}`);
  console.error('');
}

/** Every command action funnels here, so no thrown value reaches a user unrendered. */
export function printFailure(failure: { readonly cause: unknown }): void {
  const { message, hint } = guideFailure(failure);
  printError(message, hint);
}

export function formatFailure(failure: { readonly cause: unknown }): string {
  const { message, hint } = guideFailure(failure);

  return hint ? `${ERR('error')} ${message}\n${DIM('hint:')} ${hint}` : `${ERR('error')} ${message}`;
}

/** Guarantees a command registered without `.helpGroup()` is still listed. */
const UNGROUPED_HEADING = 'Other commands:';

export const GLOBAL_ENVIRONMENT: ReadonlyArray<readonly [string, string]> = [
  ['KINU_HOME', 'Where Kinu keeps workspaces and config (default ~/.kinu)'],
  ['KINU_ORIGIN', 'Kinu app origin'],
  ['KINU_TOKEN', 'Account access token, for CI'],
  ['KINU_MODEL', 'Default model ID'],
  ['KINU_BASE_URL', 'Base URL of your own model endpoint'],
  ['KINU_AUTH', 'Auth header value for that endpoint'],
];

export const HELP_EXAMPLES: ReadonlyArray<string> = [
  'kinu setup',
  'kinu provider connect codex',
  'kinu create jarvis --mode cloud --alias jarvis',
  'jarvis "review this repo"',
  'kinu transcripts jarvis',
  'kinu daemon status',
  'kinu connect',
];

/** Keyed by the command object so a rename cannot orphan the example. */
const COMMAND_EXAMPLES = new WeakMap<Command, string>();

export function setCommandExample(command: Command, example: string): void {
  COMMAND_EXAMPLES.set(command, example);
  command.addHelpText('after', `\nExample:\n  $ ${example}`);
}

export interface HelpEntry {
  command: Command;
  term: string;
  description: string;
  heading: string;
  example: string | undefined;
}

/** The one walk behind `--help` and the generated CLI reference, so neither misses a command. */
export function commandEntries(program: Command): HelpEntry[] {
  const helper = program.createHelp();

  // visibleCommands() also appends Commander's implicit `help` placeholder; intersecting with .commands drops it.
  const children = (cmd: Command): Command[] =>
    helper.visibleCommands(cmd).filter((child) => cmd.commands.includes(child));

  const entries: HelpEntry[] = [];

  const walk = (parent: Command, prefix: string, inherited: string): void => {
    for (const cmd of children(parent)) {
      const term = `${prefix}${cmd.name()}${argumentSuffix(cmd)}`;
      const heading = cmd.helpGroup() || inherited;

      if (children(cmd).length > 0) walk(cmd, `${term} `, heading);
      else entries.push({ command: cmd, term, description: cmd.description(), heading, example: COMMAND_EXAMPLES.get(cmd) });
    }
  };

  walk(program, '', UNGROUPED_HEADING);

  return entries;
}

function argumentSuffix(cmd: Command): string {
  const args = cmd.registeredArguments.map((arg) => {
    const name = `${arg.name()}${arg.variadic ? '...' : ''}`;

    return arg.required ? `<${name}>` : `[${name}]`;
  });

  return args.length > 0 ? ` ${args.join(' ')}` : '';
}

/** Rendered from the command tree so `--help` cannot drift; grouping lives on the registrations (src/program.ts). */
function renderHelp(program: Command): string {
  const entries = commandEntries(program);
  const width = termWidth();
  const termColumn = Math.min(Math.max(0, ...entries.map((e) => e.term.length)) + 2, 34);

  const lines: string[] = [
    '',
    `${BRAND} ${DIM(`v${VERSION}`)}`,
    DIM(program.description()),
    '',
    `${chalk.bold('Usage:')}  ${program.name()} <command> [options]`,
  ];

  const headings = [...new Set(entries.map((e) => e.heading))];

  for (const heading of headings) {
    lines.push('', chalk.bold(heading));

    for (const entry of entries.filter((e) => e.heading === heading)) {
      lines.push(...helpRow({ term: ACCENT(entry.term), termLength: entry.term.length, description: entry.description, termColumn, width }));
    }
  }

  lines.push('', chalk.bold('Options:'));
  lines.push(...helpRow({ term: DIM('-v, --version'), termLength: 13, description: 'Print the installed version', termColumn, width }));
  lines.push(...helpRow({ term: DIM('-h, --help'), termLength: 10, description: `Show this help; \`${program.name()} <command> --help\` for one command`, termColumn, width }));

  lines.push('', chalk.bold('Environment:'));

  for (const [name, description] of GLOBAL_ENVIRONMENT) {
    lines.push(...helpRow({ term: DIM(name), termLength: name.length, description, termColumn, width }));
  }

  lines.push('', chalk.bold('Examples:'));

  for (const example of HELP_EXAMPLES) lines.push(`  ${DIM('$')} ${example}`);
  lines.push('');

  return lines.join('\n');
}

/** An over-long term takes its own line so the column never shears. */
interface HelpRow {
  readonly term: string;
  readonly termLength: number;
  readonly description: string;
  readonly termColumn: number;
  readonly width: number;
}

function helpRow({ term, termLength, description, termColumn, width }: HelpRow): string[] {
  const gutter = '  ';
  const descriptionWidth = Math.max(24, width - gutter.length - termColumn);
  const wrapped = description ? wrapText(description, descriptionWidth) : [];
  const continuation = `${gutter}${' '.repeat(termColumn)}`;

  if (termLength + 1 > termColumn) {
    return [`${gutter}${term}`, ...wrapped.map((line) => `${continuation}${DIM(line)}`)];
  }

  const [first = '', ...rest] = wrapped;

  return [
    `${gutter}${term}${' '.repeat(termColumn - termLength)}${DIM(first)}`,
    ...rest.map((line) => `${continuation}${DIM(line)}`),
  ];
}

function wrapText(text: string, width: number): string[] {
  const lines: string[] = [];
  let current = '';

  for (const word of text.split(/\s+/)) {
    if (!current) current = word;
    else if (current.length + 1 + word.length <= width) current += ` ${word}`;
    else { lines.push(current); current = word; }
  }

  if (current) lines.push(current);

  return lines;
}

export function printHelp(program: Command): void {
  console.log(renderHelp(program));
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;

  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;

  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function printJson(value: JsonValue): void {
  console.log(JSON.stringify(value, null, 2));
}

export function plural(count: number, noun: string, pluralNoun = `${noun}s`): string {
  return `${count} ${count === 1 ? noun : pluralNoun}`;
}

export function formatWhen(epochMs: number): string {
  return new Date(epochMs).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}
