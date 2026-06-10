/**
 * Terminal display — branded output, box drawing, spinners, tables.
 * Single source of truth for all CLI visual output.
 */

import chalk from 'chalk';
import type { AgentInfo, SearchNode } from '@proteus/core';

// ── Brand ────────────────────────────────────────────────────────

const BRAND = chalk.bold.cyan('🔱 Proteus');
const VERSION = '0.1.0';
const DIM = chalk.dim;
const ACCENT = chalk.cyan;
const OK = chalk.green;
const WARN = chalk.yellow;
const ERR = chalk.red;
const MUTED = chalk.gray;

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
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

// ── Spinner ──────────────────────────────────────────────────────

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const isTTY = process.stdout.isTTY ?? false;

export function createSpinner(message: string) {
  let i = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  return {
    start() {
      if (!isTTY) return;
      timer = setInterval(() => {
        const frame = ACCENT(SPINNER_FRAMES[i % SPINNER_FRAMES.length]);
        process.stdout.write(`\r${frame} ${message}`);
        i++;
      }, 80);
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

// ── Typing indicator for chat ────────────────────────────────────

export function createTypingIndicator(agentName: string) {
  let i = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  return {
    start() {
      if (!isTTY) return;
      timer = setInterval(() => {
        process.stdout.write(`\r${ACCENT(agentName)} ${DIM(SPINNER_FRAMES[i % SPINNER_FRAMES.length])} `);
        i++;
      }, 80);
    },
    stop() {
      if (timer) clearInterval(timer);
      if (isTTY) process.stdout.write(`\r\x1b[K`);
    },
  };
}

// ── Header ───────────────────────────────────────────────────────

export function printHeader(): void {
  console.log(`\n${BRAND} ${DIM(`v${VERSION}`)}\n`);
}

// ── Agent created card ───────────────────────────────────────────

export function printCreatedCard(name: string, purpose: string, model: string, dbPath: string): void {
  const w = termWidth();
  const L = (label: string) => DIM(label.padEnd(10));
  console.log('');
  console.log(`${BRAND} ${DIM('— Agent Created')}`);
  console.log(boxTop(w));
  console.log(boxRow(L('Name:'), ACCENT(name), w));
  console.log(boxRow(L('Mission:'), purpose.slice(0, w - 18), w));
  console.log(boxRow(L('Model:'), MUTED(model), w));
  console.log(boxRow(L('Database:'), MUTED(dbPath), w));
  console.log(boxBot(w));
  console.log(`\n${DIM('Start chatting:')} ${ACCENT(`proteus chat ${name}`)}\n`);
}

// ── Agent status card ────────────────────────────────────────────

export function printAgentStatus(info: AgentInfo, dbSize: number, extra?: {
  conversationCount?: number;
}): void {
  const w = termWidth();
  console.log('');
  console.log(`${BRAND} ${DIM('— Agent Status')}`);
  console.log(boxTop(w));

  const L = (label: string) => DIM(label.padEnd(14));

  // Identity section
  console.log(boxRow(L('Name:'), `${ACCENT(info.name)} ${DIM(`(${info.id.slice(0, 12)}...)`)}`, w));
  console.log(boxRow(L('Mission:'), info.purpose.slice(0, w - 22), w));
  console.log(boxRow(L('Created:'), DIM(new Date(info.createdAt).toLocaleDateString()), w));
  console.log(boxRow(L('Database:'), DIM(formatBytes(dbSize)), w));
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
  console.log(boxRow(L('Tools:'), `6 built-in + ${info.craftedToolCount} crafted`, w));
  console.log(boxRow(L('Memory:'), formatBytes(info.memorySize), w));
  console.log(boxBot(w));
  console.log('');
}

// ── Agent list table ─────────────────────────────────────────────

export function printAgentList(agents: Array<{
  name: string;
  purpose: string;
  scaffoldVersion: number;
  toolCount: number;
  lastActive?: string;
  dbSize?: number;
}>): void {
  if (agents.length === 0) {
    console.log(`\n${DIM('No agents found.')} Create one with: ${ACCENT('proteus create <name>')}\n`);
    return;
  }

  console.log('');
  console.log(`${BRAND} ${DIM(`— ${agents.length} agent${agents.length === 1 ? '' : 's'}`)}`);
  console.log('');

  // Adaptive column widths
  const maxName = Math.max(4, ...agents.map(a => a.name.length));
  const nameW = Math.min(maxName + 2, 22);
  const purposeW = Math.max(20, termWidth() - nameW - 24);

  const hdr = `  ${MUTED('NAME'.padEnd(nameW))}${MUTED('PURPOSE'.padEnd(purposeW))} ${MUTED('VER')}  ${MUTED('SIZE')}`;
  console.log(hdr);
  console.log(`  ${DIM('─'.repeat(termWidth() - 4))}`);

  for (const a of agents) {
    const name = ACCENT(a.name.padEnd(nameW));
    const purpose = DIM(a.purpose.slice(0, purposeW - 2).padEnd(purposeW));
    const ver = `v${a.scaffoldVersion}`.padEnd(4);
    const size = a.dbSize ? DIM(formatBytes(a.dbSize).padStart(8)) : DIM('    —   ');
    console.log(`  ${name}${purpose} ${ver}  ${size}`);
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
    const action = n.action.replace(/\n/g, ' ').slice(0, 50);
    console.log(`${indent}${icon} ${value} ${visits} ${DIM(action)}`);
  }
  console.log('');
}

// ── Tool call display (for chat) ─────────────────────────────────

export function printToolCall(toolName: string, args: Record<string, unknown>): void {
  const argStr = Object.entries(args)
    .map(([k, v]) => {
      const s = typeof v === 'string' ? v : JSON.stringify(v);
      return s.length > 60 ? s.slice(0, 57) + '...' : s;
    })
    .join(', ');
  console.log(`\n${DIM('  ⚙ ')}${MUTED(toolName)} ${DIM('━'.repeat(Math.max(1, 40 - toolName.length)))}`);
  if (argStr) console.log(`${DIM('  ')}${MUTED(argStr.slice(0, 70))}`);
}

export function printToolResult(result: string): void {
  const lines = result.split('\n').slice(0, 5);
  for (const line of lines) {
    console.log(`${DIM('  → ')}${MUTED(line.slice(0, 70))}`);
  }
  if (result.split('\n').length > 5) console.log(DIM(`  → ... (${result.split('\n').length - 5} more lines)`));
  console.log(DIM('  ' + '━'.repeat(44)));
}

// ── Evolution event (for chat) ───────────────────────────────────

const EVOLUTION_ICONS: Record<string, string> = {
  reflection: '💡', craft_discovered: '🔧', consolidation: '🧹',
  scaffold_proposed: '🧬', mcts_started: '🔍', mcts_complete: '✓',
};

export function printEvolutionEvent(type: string, message: string): void {
  const icon = EVOLUTION_ICONS[type] ?? '•';
  console.log(MUTED(`  ${icon} ${message.slice(0, 70)}`));
}

// ── Error formatting ─────────────────────────────────────────────

export function printError(message: string, hint?: string): void {
  console.error(`\n${ERR('error')} ${message}`);
  if (hint) console.error(`${DIM('hint:')} ${hint}`);
  console.error('');
}

// ── Help screen ──────────────────────────────────────────────────

export function printHelp(): void {
  console.log('');
  console.log(`${BRAND} ${DIM(`v${VERSION}`)}`);
  console.log(`${DIM('Self-evolving AI agent with MCTS exploration')}\n`);
  console.log(`${chalk.bold('Usage:')}  proteus <command> [options]\n`);
  console.log(`${chalk.bold('Commands:')}`);
  console.log(`  ${ACCENT('setup')}              Connect your account; optionally configure local models`);
  console.log(`  ${ACCENT('provider')}           List or connect model/account providers`);
  console.log(`  ${ACCENT('auth')}               Sign into your Proteus account`);
  console.log(`  ${ACCENT('whoami')}             Show the signed-in account`);
  console.log(`  ${ACCENT('create')} [name]      Create a cloud or local agent`);
  console.log(`  ${ACCENT('run')}    <name>      Run once, open chat, or use JSON/RPC mode`);
  console.log(`  ${ACCENT('chat')}   <name>      Interactive conversation`);
  console.log(`  ${ACCENT('sessions')} [agent]   List recorded CLI sessions`);
  console.log(`  ${ACCENT('alias')}  <agent>     Create an executable alias command`);
  console.log(`  ${ACCENT('connect')}            Link this computer as the execution engine`);
  console.log(`  ${ACCENT('daemon')}             Manage local scheduled agent wakeups`);
  console.log(`  ${ACCENT('status')} <name>      Show agent state and evolution history`);
  console.log(`  ${ACCENT('model')}  <name>      Show or change the active model`);
  console.log(`  ${ACCENT('tools')}  <name>      List the agent tool surface`);
  console.log(`  ${ACCENT('triggers')} <name>    List, schedule, or cancel triggers`);
  console.log(`  ${ACCENT('jobs')}   <name>      List or cancel background jobs`);
  console.log(`  ${ACCENT('evolve')} <name>      Trigger a local MCTS evolution cycle`);
  console.log(`  ${ACCENT('update')}             Update the installed command`);
  console.log(`  ${ACCENT('doctor')}             Inspect local installation state`);
  console.log(`  ${ACCENT('list')}               List all agents`);
  console.log(`\n${chalk.bold('Options:')}`);
  console.log(`  ${DIM('--origin <url>')}      Proteus app origin`);
  console.log(`  ${DIM('--mode <mode>')}       Agent mode: cloud or local`);
  console.log(`  ${DIM('--alias <name>')}      Alias command for create`);
  console.log(`  ${DIM('--session <id>')}      Resume a recorded CLI session`);
  console.log(`  ${DIM('--model <id>')}        Model ID ${DIM('(env: PROTEUS_MODEL)')}`);
  console.log(`  ${DIM('--base-url <url>')}    LLM API base URL ${DIM('(env: PROTEUS_BASE_URL)')}`);
  console.log(`  ${DIM('--auth <header>')}     Auth header ${DIM('(env: PROTEUS_AUTH)')}`);
  console.log(`  ${DIM('--purpose <text>')}    Agent purpose (for create)`);
  console.log(`\n${chalk.bold('Examples:')}`);
  console.log(`  ${DIM('$')} proteus setup`);
  console.log(`  ${DIM('$')} proteus provider connect codex`);
  console.log(`  ${DIM('$')} proteus provider list`);
  console.log(`  ${DIM('$')} proteus create jarvis --mode cloud --alias jarvis`);
  console.log(`  ${DIM('$')} jarvis "review this repo"`);
  console.log(`  ${DIM('$')} jarvis`);
  console.log(`  ${DIM('$')} proteus sessions jarvis`);
  console.log(`  ${DIM('$')} proteus daemon status`);
  console.log(`  ${DIM('$')} proteus connect\n`);
}

// ── Utilities ────────────────────────────────────────────────────

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
