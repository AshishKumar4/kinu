/**
 * Interactive chat REPL — a thin presentation layer over LocalAgentSession.
 *
 * The session (in @proteus/cli-backend) owns the whole agent loop: streaming,
 * tool calls, per-turn accounting, evolution, background jobs, and the reactor.
 * This renders its SessionEvent stream to the terminal and feeds it user input.
 */

import * as readline from 'node:readline';
import type { AgentRuntime, AgentInfo, SearchNode, LLMProviderConfig } from '@proteus/core';
import { LocalAgentSession, resolveChatModel, type LocalModelResolver, type LocalSessionDb, type SessionEvent, type McpServerConfig } from '@proteus/cli-backend';
import { defaultAgentSessionId, type CliSession } from './session.js';
import { recordCliSessionEvent } from './session-recorder.js';
import {
  printChatBanner, printSlashHelp, printAgentStatus,
  printSearchTree, printToolCall, printToolResult,
  printEvolutionEvent, createTypingIndicator,
  ACCENT, DIM, MUTED, ERR, WARN,
} from './display.js';

export interface ChatLoopOpts {
  rt: AgentRuntime;
  db: LocalSessionDb;
  info: AgentInfo;
  dbSize: number;
  llmConfig: LLMProviderConfig;
  modelResolver?: LocalModelResolver;
  refreshInfo: () => AgentInfo;
  noAutoEvolve?: boolean;
  mcpServers?: Record<string, McpServerConfig>;
  cliSession?: CliSession;
  localSessionId?: string;
}

export async function runChatLoop(opts: ChatLoopOpts): Promise<void> {
  const { rt, db, dbSize, llmConfig, modelResolver, refreshInfo, noAutoEvolve, mcpServers } = opts;
  let info = opts.info;

  // Per-turn render state — reset on every turn-start so the agent-name header
  // prints once per turn and the typing indicator stops on first output.
  const typing = createTypingIndicator(info.name);
  let headerPrinted = false;

  const session = new LocalAgentSession({
    rt, db, model: resolveChatModel(llmConfig), modelResolver, noAutoEvolve,
    sessionId: opts.localSessionId ?? defaultAgentSessionId(),
    persistMessages: opts.cliSession?.mode !== 'none',
    onEvent: (event) => {
      recordCliSessionEvent(opts.cliSession, event, 'local');
      renderEvent(event, info.name, typing, () => headerPrinted, (v) => { headerPrinted = v; });
    },
  });

  if (mcpServers && Object.keys(mcpServers).length > 0) await session.connectMcp(mcpServers);
  printChatBanner(info, session.toolNames(), !noAutoEvolve);
  // Recover background jobs orphaned by a previous exit.
  void session.recoverBackgroundJobs();

  const prompt = () => `${ACCENT(info.name)} ${DIM('›')} `;
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: prompt() });

  let exiting = false;
  const onExit = async () => {
    if (exiting) return;
    exiting = true;
    // Flush a partial evolution window (5s cap so Ctrl+C never hangs).
    try { await Promise.race([session.end(), new Promise((r) => setTimeout(r, 5000))]); } catch { /* best effort */ }
    console.log(DIM('\n  Goodbye.\n'));
    rl.close();
    process.exit(0);
  };
  process.on('SIGINT', () => { session.interrupt(); void onExit(); });

  rl.prompt();

  for await (const line of rl) {
    const input = line.trim();
    if (!input) { rl.prompt(); continue; }

    if (input.startsWith('/')) {
      const result = await handleSlash(input, rt, info, dbSize, refreshInfo, session);
      if (result === 'exit') { await onExit(); return; }
      if (result === 'refresh') info = refreshInfo();
      rl.prompt();
      continue;
    }

    headerPrinted = false;
    typing.start();
    opts.cliSession?.append('user', { text: input, cwd: process.cwd(), backend: 'local' });
    try {
      await session.send(input);
    } catch (err) {
      typing.stop();
      console.log(`\n${ERR('error')} ${(err as Error).message}\n`);
    }
    if (!headerPrinted) typing.stop();
    console.log('\n');
    rl.prompt();
  }
}

/** Render one SessionEvent to the terminal. */
function renderEvent(
  event: SessionEvent, agentName: string, typing: { stop: () => void },
  getHeader: () => boolean, setHeader: (v: boolean) => void,
): void {
  const header = () => {
    if (getHeader()) return;
    typing.stop();
    process.stdout.write(`\n${ACCENT(agentName)} ${DIM('›')} `);
    setHeader(true);
  };
  switch (event.type) {
    case 'turn-start':
      if (event.kind === 'programmatic') {
        typing.stop();
        setHeader(false);
        console.log(`\n${DIM(`⚡ ${event.event ?? 'event'}`)} ${MUTED(event.text.slice(0, 80))}`);
      }
      break;
    case 'text-delta':
      header();
      process.stdout.write(event.delta);
      break;
    case 'tool-call':
      typing.stop();
      printToolCall(event.toolName, event.args);
      break;
    case 'tool-result':
      printToolResult(event.result);
      break;
    case 'evolution':
      printEvolutionEvent(event.event, event.message);
      break;
    case 'error':
      typing.stop();
      console.log(`\n${ERR('error')} ${event.message}\n`);
      break;
    case 'turn-end':
    case 'broadcast':
      break;
  }
}

// ── Slash commands ────────────────────────────────────────────────

async function handleSlash(
  input: string, rt: AgentRuntime, info: AgentInfo, dbSize: number,
  refreshInfo: () => AgentInfo, session: LocalAgentSession,
): Promise<'exit' | 'refresh' | 'ok'> {
  const cmd = input.split(/\s+/)[0]!.toLowerCase();
  switch (cmd) {
    case '/exit': case '/quit': return 'exit';
    case '/status': printAgentStatus(refreshInfo(), dbSize); return 'refresh';
    case '/help': printSlashHelp(); return 'ok';
    case '/tools': {
      console.log(`\n${DIM('Built-in tools:')}`);
      for (const { name, description } of session.describeTools()) {
        console.log(`  ${ACCENT(name)} ${DIM('—')} ${description}`);
      }
      const crafted = rt.craftStore.list();
      if (crafted.length > 0) {
        console.log(`\n${DIM('Crafted tools:')}`);
        for (const t of crafted) console.log(`  ${ACCENT(t.name)} ${DIM('—')} ${t.description.slice(0, 60)}`);
      }
      console.log('');
      return 'ok';
    }
    case '/memory': {
      const content = await rt.memory.read('memory/MEMORY.md');
      if (content) console.log(`\n${DIM('memory/MEMORY.md:')}\n${MUTED(content.slice(0, 1500))}\n`);
      else console.log(DIM('  Memory is empty.'));
      return 'ok';
    }
    case '/always': {
      const args = input.split(/\s+/).slice(1);
      if (args.length === 0) {
        const cur = session.getAlwaysActiveSkills();
        console.log(cur.length
          ? `\n${DIM('Always-active skills:')} ${cur.join(', ')}\n`
          : DIM('  No always-active skills set. Usage: /always <name>… (or "none" to clear).'));
      } else {
        const names = args[0] === 'none' ? [] : args;
        session.setAlwaysActiveSkills(names);
        console.log(DIM(names.length ? `  Always-active skills: ${names.join(', ')}` : '  Cleared always-active skills.'));
      }
      return 'ok';
    }
    case '/approval': {
      const mode = input.slice(cmd.length).trim();
      if (!mode) {
        console.log(`\n${DIM('Shell approval:')} ${session.getShellApprovalMode().mode}\n`);
        return 'ok';
      }
      if (mode !== 'strict' && mode !== 'allow_all' && mode !== 'deny_all') {
        console.log(WARN('  Usage: /approval strict | allow_all | deny_all'));
        return 'ok';
      }
      const result = session.setShellApprovalMode(mode);
      console.log(`\n${DIM('Shell approval:')} ${ACCENT(result.mode)}\n`);
      return 'ok';
    }
    case '/model': {
      const spec = input.slice(cmd.length).trim();
      if (!spec) {
        const stored = session.getStoredModelSpec().spec;
        console.log(`\n${DIM('Stored model:')} ${stored ?? '(default)'}`);
        console.log(`${DIM('Effective:')} ${session.getEffectiveModelSpec()}\n`);
      } else {
        try {
          const result = session.setModel(spec);
          console.log(`\n${DIM('Model:')} ${ACCENT(result.spec)}\n`);
        } catch (err) {
          console.log(`\n${ERR('error')} ${(err as Error).message}\n`);
        }
      }
      return 'ok';
    }
    case '/models': {
      const providers = await session.listModelProviders();
      if (providers.length === 0) {
        console.log(DIM('  No local provider registry is configured for this session.'));
        return 'ok';
      }
      console.log(`\n${DIM('Providers:')}`);
      for (const p of providers) {
        console.log(`  ${p.available ? ACCENT(p.id) : MUTED(p.id)} ${DIM('—')} ${p.available ? 'available' : p.unavailableReason ?? 'unavailable'}`);
      }
      const models = await session.listAvailableModels();
      if (models.length > 0) {
        console.log(`\n${DIM('Models:')}`);
        for (const m of models.slice(0, 40)) console.log(`  ${ACCENT(`${m.provider}/${m.id}`)} ${DIM('—')} ${m.label ?? m.id}`);
        if (models.length > 40) console.log(DIM(`  … ${models.length - 40} more`));
      }
      console.log('');
      return 'ok';
    }
    case '/tree': {
      const nodes = rt.storage.sql<SearchNode>`SELECT * FROM search_nodes ORDER BY depth, created_at`;
      printSearchTree(nodes);
      return 'ok';
    }
    default:
      console.log(WARN(`  Unknown command: ${cmd}. Type /help`));
      return 'ok';
  }
}
