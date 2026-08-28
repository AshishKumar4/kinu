/**
 * Terminal display — branded output, box drawing, spinners, tables.
 * Single source of truth for all CLI visual output.
 */

import chalk from 'chalk';
import type { Command } from 'commander';
import { BUILTIN_TOOLS, describeToolCall, summarizeToolCall, parseRefusal } from '@kinu.run/core';
import type { SearchNode, ReasoningEffort, JsonObject } from '@kinu.run/core';
import { clipText } from './tui/format';
import type { WorkspaceInfo } from '@kinu.run/core/identity';
import { guideFailure } from './provider-guidance';
import cliPackage from '../package.json' with { type: 'json' };

// ── Brand ────────────────────────────────────────────────────────

// The Kinu design system the product renders — cf-backend index.css :root is
// the source of truth. Fixed hexes assume the dark terminal the TUI paints;
// NO_COLOR still strips everything through chalk.
const INK = {
  sheen: '#E3D2AE',   // --c-accent-fg — brand ink
  thread: '#E0A458',  // --c-accent — fills, strokes, the winning line
  success: '#8FBC8B', // --c-success — mock --good
  warning: '#E8B97A', // --c-warning — derived tan
  danger: '#C97B6B',  // --c-danger — mock --bad
  dim: '#9C9184',     // --c-text-3
} as const;

const BRAND = chalk.bold.hex(INK.sheen)('Kinu');
const VERSION = cliPackage.version;
const DIM = chalk.dim;
const ACCENT = chalk.hex(INK.thread);
const OK = chalk.hex(INK.success);
const WARN = chalk.hex(INK.warning);
const ERR = chalk.hex(INK.danger);
const MUTED = chalk.hex(INK.dim);

export { BRAND, VERSION, DIM, ACCENT, OK, WARN, ERR, MUTED };

// ── Box drawing ──────────────────────────────────────────────────

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

// ── Spinner ──────────────────────────────────────────────────────

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const isTTY = process.stdout.isTTY ?? false;

export function createSpinner(initialMessage: string) {
  let i = 0;
  let message = initialMessage;
  let timer: ReturnType<typeof setInterval> | null = null;
  return {
    start() {
      if (!isTTY) return;
      timer = setInterval(() => {
        const frame = ACCENT(SPINNER_FRAMES[i % SPINNER_FRAMES.length]);
        process.stdout.write(`\r\x1b[K${frame} ${message}`);
        i++;
      }, 80);
    },
    /** Replace the live status. Piped output gets one plain line instead. */
    update(next: string) {
      message = next;
      if (!isTTY) console.log(`${DIM('·')} ${next}`);
    },
    /** Print a line that stays in the scrollback, above the live status. */
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

// ── Turn status line for chat ────────────────────────────────────

export interface TurnStatus {
  /** The turn entered a named state (`thinking`, `calling run`). */
  show(label: string): void;
  /** Release the row; the label is remembered for `resume`. */
  clear(): void;
  /** Redraw the last shown label — after a consent question gave the row back. */
  resume(): void;
}

/**
 * The chat turn's live status line. The LABEL is state: only a client event
 * names it (the same vocabulary the TUI's phase line uses), so the line never
 * claims work the turn is not doing — during a tool call it says `calling`,
 * not `thinking`. The interval only animates frames under a live label, and
 * `hold` surrenders the row to whatever has the user's attention (typed
 * steering input, an unanswered consent question).
 */
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
      if (!timer) timer = setInterval(draw, 80);
      draw();
    },
  };
}

// ── Agent created card ───────────────────────────────────────────

export function printCreatedCard(name: string, purpose: string, model: string, dbPath: string): void {
  const w = termWidth();
  const L = (label: string) => DIM(label.padEnd(10));
  console.log('');
  console.log(`${BRAND} ${DIM('— Workspace Created')}`);
  console.log(boxTop(w));
  console.log(boxRow(L('Name:'), ACCENT(name), w));
  console.log(boxRow(L('Mission:'), clipText(purpose, w - 18), w));
  console.log(boxRow(L('Model:'), MUTED(model), w));
  console.log(boxRow(L('Database:'), MUTED(dbPath), w));
  console.log(boxBot(w));
  console.log(`\n${DIM('Start chatting:')} ${ACCENT(`kinu chat ${name}`)}\n`);
}

// ── Agent status card ────────────────────────────────────────────

export function printAgentStatus(info: WorkspaceInfo, dbSize: number, extra?: {
  conversationCount?: number;
  model?: string | null;
  reasoningEffort?: ReasoningEffort | null;
}): void {
  const w = termWidth();
  console.log('');
  console.log(`${BRAND} ${DIM('— Workspace Status')}`);
  console.log(boxTop(w));

  const L = (label: string) => DIM(label.padEnd(14));

  // Identity: the slug and nothing else. It IS the workspace's id.
  console.log(boxRow(L('Name:'), ACCENT(info.name), w));
  console.log(boxRow(L('Mission:'), info.purpose.slice(0, w - 22), w));
  const created = info.createdAt ? new Date(info.createdAt).toLocaleDateString() : '—';
  console.log(boxRow(L('Created:'), DIM(created), w));
  console.log(boxRow(L('Database:'), DIM(formatBytes(dbSize)), w));
  console.log(boxRow(L('Model:'), extra?.model ?? '(default)', w));
  console.log(boxRow(L('Effort:'), extra?.reasoningEffort ?? 'medium (chat default)', w));
  console.log(DIM(`${BOX.v}${'─'.repeat(w - 3)}`));

  // Evolution section
  console.log(boxRow(L('Scaffold:'), `v${info.scaffoldVersion}`, w));
  console.log(boxRow(L('MCTS Nodes:'), String(info.searchNodeCount), w));
  console.log(boxRow(L('Tasks:'), String(info.taskCount), w));
  if (extra?.conversationCount !== undefined) {
    console.log(boxRow(L('Chats:'), String(extra.conversationCount), w));
  }
  console.log(DIM(`${BOX.v}${'─'.repeat(w - 3)}`));

  // Tools section
  console.log(boxRow(L('Tools:'), `${BUILTIN_TOOLS.length} built-in + ${info.craftedToolCount} crafted`, w));
  console.log(boxRow(L('Memory:'), formatBytes(info.memorySize), w));
  console.log(boxBot(w));
  console.log('');
}

// ── Agent list table ─────────────────────────────────────────────

export function printAgentList(agents: Array<{
  name: string;
  mode: 'local' | 'cloud';
  purpose: string;
  scaffoldVersion: number;
  toolCount: number;
  lastActive?: string;
  dbSize?: number;
}>): void {
  if (agents.length === 0) {
    console.log(`\n${DIM('No agents found.')} Create one with: ${ACCENT('kinu create <name>')}\n`);
    return;
  }

  console.log('');
  console.log(`${BRAND} ${DIM(`— ${agents.length} agent${agents.length === 1 ? '' : 's'}`)}`);
  console.log('');

  // Adaptive column widths. NAME is an IDENTIFIER: it is what the user pastes
  // into `kinu debug <name>`, so it is never clipped — a silently truncated
  // name is a different valid-looking name, and one such clip sent a session
  // chasing a phantom "not in your registry" defect. PURPOSE is prose and
  // absorbs the squeeze instead.
  const maxName = Math.max(4, ...agents.map(a => a.name.length));
  const nameW = maxName + 2;
  const modeW = 8;
  const purposeW = Math.max(12, termWidth() - nameW - modeW - 24);

  const hdr = `  ${MUTED('NAME'.padEnd(nameW))}${MUTED('MODE'.padEnd(modeW))}${MUTED('PURPOSE'.padEnd(purposeW))} ${MUTED('VER')}  ${MUTED('SIZE')}`;
  console.log(hdr);
  console.log(`  ${DIM('─'.repeat(termWidth() - 4))}`);

  for (const a of agents) {
    // PURPOSE clips (prose); NAME only pads (identifier).
    const name = ACCENT(a.name.padEnd(nameW));
    const mode = DIM(a.mode.padEnd(modeW));
    const purpose = DIM(a.purpose.slice(0, purposeW - 2).padEnd(purposeW));
    const ver = `v${a.scaffoldVersion}`.padEnd(4);
    const size = a.dbSize ? DIM(formatBytes(a.dbSize).padStart(8)) : DIM('    —   ');
    console.log(`  ${name}${mode}${purpose} ${ver}  ${size}`);
  }
  console.log('');
}

// ── Search tree visualization ────────────────────────────────────

export function printSearchTree(nodes: SearchNode[]): void {
  if (nodes.length === 0) {
    console.log(DIM('  (no search history)'));
    return;
  }

  console.log(`\n${DIM('MCTS Search Tree:')}`);
  for (const n of nodes) {
    const indent = '  '.repeat(n.depth + 1);
    const icon = n.status === 'terminal' ? OK('●')
      : n.status === 'pruned' ? ERR('○')
      : n.status === 'failed' ? ERR('✗')
      : WARN('◌');
    const value = WARN(n.value.toFixed(3));
    const visits = DIM(`n=${n.visits}`);
    const action = clipText(n.action.replace(/\n/g, ' '), 50);
    console.log(`${indent}${icon} ${value} ${visits} ${DIM(action)}`);
  }
  console.log('');
}

// ── Tool call display (for chat) ─────────────────────────────────

/**
 * A tool call, as a person reads it: what it is doing, then the arguments that
 * say which thing.
 *
 * Until the summary vocabulary was hoisted out of cf-backend this printed the
 * raw argument VALUES, JSON-encoded, comma-joined and clipped at 70 characters
 * — so a file edit read `edit, /a/b.ts, [{"old":"import {…` while the web chat
 * card, from the same arguments, read `Edited b.ts — 3 replacements`. The
 * fallback below is what the CLI had for every tool; it now applies only to
 * MCP and crafted tools, whose argument contracts nothing knows.
 */
export function printToolCall(toolName: string, args: JsonObject): void {
  console.log(`\n${DIM('  ▸ ')}${MUTED(toolName)} ${DIM('━'.repeat(Math.max(1, 40 - toolName.length)))}`);
  const action = describeToolCall(toolName, args);
  if (action) console.log(`${DIM('  ')}${ACCENT(action)}`);
  const summary = summarizeToolCall(toolName, args);
  if (summary) console.log(`${DIM('  ')}${MUTED(summary)}`);
}

/**
 * A tool result, as a person reads it. A refusal — the `{reason, error}`
 * payload executor tools answer failures on (core exec-result.ts) — renders as
 * prose under a ✗, not as the JSON the model reads; everything else keeps the
 * five-line preview, and every cut carries an ellipsis saying it cut.
 */
export function printToolResult(result: string): void {
  const refusal = parseRefusal(result);
  if (refusal) {
    const [head, ...rest] = refusal.error.split('\n');
    if (head) console.log(`${DIM('  ✗ ')}${ERR(head)} ${DIM(`(${refusal.reason})`)}`);
    else console.log(`${DIM('  ✗ ')}${ERR(refusal.reason)}`);
    for (const line of rest) console.log(`${DIM('      ')}${MUTED(line)}`);
    console.log(DIM('  ' + '━'.repeat(44)));
    return;
  }
  const lines = result.split('\n');
  for (const line of lines.slice(0, 5)) {
    console.log(`${DIM('  → ')}${MUTED(clipText(line, 70))}`);
  }
  if (lines.length > 5) console.log(DIM(`  → … (${lines.length - 5} more lines)`));
  console.log(DIM('  ' + '━'.repeat(44)));
}

// ── Evolution event (for chat) ───────────────────────────────────

const EVOLUTION_ICONS = new Map<string, string>([
  ['reflection', '◔'], ['craft_discovered', '✚'], ['consolidation', '⟳'],
  ['scaffold_proposed', '✎'], ['mcts_started', '⌕'], ['mcts_complete', '✓'],
]);

export function printEvolutionEvent(type: string, message: string): void {
  const icon = EVOLUTION_ICONS.get(type) ?? '•';
  console.log(MUTED(`  ${icon} ${clipText(message, 70)}`));
}

// ── Error formatting ─────────────────────────────────────────────

export function printError(message: string, hint?: string): void {
  console.error(`\n${ERR('error')} ${message}`);
  if (hint) console.error(`${DIM('hint:')} ${hint}`);
  console.error('');
}

/** A command that could not complete: the failure in the provider's words,
 *  plus the next command when the failure class implies one. Every command
 *  action funnels here, so no thrown value can reach a user unrendered. */
export function printFailure(failure: { readonly cause: unknown }): void {
  const { message, hint } = guideFailure(failure);
  printError(message, hint);
}

/** The same block for surfaces that own their output stream — the run/chat
 *  transcripts, where an error is one entry among the streamed events rather
 *  than the end of the process. */
export function formatFailure(failure: { readonly cause: unknown }): string {
  const { message, hint } = guideFailure(failure);
  return hint ? `${ERR('error')} ${message}\n${DIM('hint:')} ${hint}` : `${ERR('error')} ${message}`;
}

// ── Help screen ──────────────────────────────────────────────────

/** Where a command lands when it was registered without a `.helpGroup()`. Its
 *  existence is the drift guarantee: a new command is always listed. */
const UNGROUPED_HEADING = 'Other commands:';

/** Environment variables that apply to every command. Per-command options are
 *  deliberately not repeated here — `kinu <command> --help` owns those. */
export const GLOBAL_ENVIRONMENT: ReadonlyArray<readonly [string, string]> = [
  ['KINU_HOME', 'Workspace + config directory (default ~/.kinu)'],
  ['KINU_ORIGIN', 'Kinu app origin'],
  ['KINU_TOKEN', 'Account access token (CI)'],
  ['KINU_MODEL', 'Default model ID'],
  ['KINU_BASE_URL', 'LLM API base URL'],
  ['KINU_AUTH', 'LLM auth header value'],
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

export interface HelpEntry {
  /** The registration itself — what a renderer needs for options/aliases. */
  command: Command;
  /** Invocation term, e.g. `workspace delete <name>`. */
  term: string;
  description: string;
  heading: string;
}

/** Every runnable command in the tree, in registration order, with its heading
 *  inherited from the nearest ancestor that declared one. The one walk behind
 *  both the `--help` screen and the generated CLI reference, so neither can
 *  list a command the other misses. */
export function commandEntries(program: Command): HelpEntry[] {
  const helper = program.createHelp();
  // visibleCommands() applies the hidden-command policy but also appends
  // Commander's implicit `help` placeholder, which is not a registered command;
  // intersecting with .commands keeps the policy and drops the placeholder.
  const children = (cmd: Command): Command[] =>
    helper.visibleCommands(cmd).filter((child) => cmd.commands.includes(child));

  const entries: HelpEntry[] = [];
  const walk = (parent: Command, prefix: string, inherited: string): void => {
    for (const cmd of children(parent)) {
      const term = `${prefix}${cmd.name()}${argumentSuffix(cmd)}`;
      const heading = cmd.helpGroup() || inherited;
      if (children(cmd).length > 0) walk(cmd, `${term} `, heading);
      else entries.push({ command: cmd, term, description: cmd.description(), heading });
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

/**
 * The branded root help, rendered from the registered command tree. Nothing is
 * curated by hand here, so `--help` cannot drift from what the CLI accepts;
 * grouping and wording live on the registrations themselves (src/program.ts).
 */
export function renderHelp(program: Command): string {
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
      lines.push(...helpRow(ACCENT(entry.term), entry.term.length, entry.description, termColumn, width));
    }
  }

  lines.push('', chalk.bold('Options:'));
  lines.push(...helpRow(DIM('-v, --version'), 13, 'Print the installed version', termColumn, width));
  lines.push(...helpRow(DIM('-h, --help'), 10, `Show this help; \`${program.name()} <command> --help\` for one command`, termColumn, width));

  lines.push('', chalk.bold('Environment:'));
  for (const [name, description] of GLOBAL_ENVIRONMENT) {
    lines.push(...helpRow(DIM(name), name.length, description, termColumn, width));
  }

  lines.push('', chalk.bold('Examples:'));
  for (const example of HELP_EXAMPLES) lines.push(`  ${DIM('$')} ${example}`);
  lines.push('');
  return lines.join('\n');
}

/** One `term    description` row, wrapping the description under a hanging
 *  indent. An over-long term takes its own line so the column never shears. */
function helpRow(term: string, termLength: number, description: string, termColumn: number, width: number): string[] {
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

// ── Utilities ────────────────────────────────────────────────────

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
