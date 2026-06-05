import { existsSync, readFileSync } from 'node:fs';
import * as readline from 'node:readline';
import { Database } from 'bun:sqlite';
import { createLocalModelResolver, LocalAgentSession, openAgentCLI, resolveChatModel, type SessionEvent } from '@proteus/cli-backend';
import {
  agentDbPath, requireAuthConfig, resolveAgentRef, resolveLLMConfig,
  resolveMcpServers, resolveProviderCredentials,
} from '../config.js';
import { runCloudTurn, type CloudTurnResult } from '../cloud-api.js';
import { chatCommand } from './chat.js';
import { ensureLocalDaemonRunning } from './daemon.js';
import { ACCENT, DIM, ERR, printToolCall, printToolResult } from '../display.js';
import {
  createCliSession,
  defaultAgentSessionId,
  type CliSession,
} from '../session.js';

export async function runCommand(name: string, promptParts: string[], opts: {
  model?: string; baseUrl?: string; auth?: string; classic?: boolean;
  mode?: string; print?: boolean;
  continue?: boolean; resume?: boolean; session?: string; sessionDir?: string; noSession?: boolean; name?: string; fork?: string;
}): Promise<void> {
  const outputMode = normalizeOutputMode(opts.mode);
  const agent = resolveAgentRef(name);
  const mode = agent?.mode ?? (existsSync(agentDbPath(name)) ? 'local' : 'cloud');
  const canonicalName = agent?.name ?? name;

  if (outputMode === 'rpc') {
    await runRpc(canonicalName, mode, opts);
    return;
  }

  const prompt = await buildPrompt(promptParts);

  if (!prompt) {
    if (mode === 'cloud') {
      console.log(DIM('Cloud interactive chat is not streaming yet. Use:'));
      console.log(`  ${ACCENT(`proteus run ${canonicalName} "your task"`)}\n`);
      return;
    }
    await chatCommand(canonicalName, opts);
    return;
  }

  const session = createCliSession(canonicalName, opts);
  session.append('user', { text: prompt, cwd: process.cwd(), backend: mode });

  if (mode === 'cloud') {
    const auth = requireAuthConfig();
    const result = await runCloudTurn(auth.origin, auth.token, agent?.cloudName ?? canonicalName, prompt, process.cwd());
    session.append('assistant', { text: result.text, toolCalls: result.toolCalls ?? [], steps: result.steps ?? 0 });
    if (outputMode === 'json') writeCloudJsonEvents(session, canonicalName, result);
    else if (result.text.trim()) console.log(result.text);
    return;
  }

  ensureLocalDaemonRunning();
  await runLocalTurn(canonicalName, prompt, opts, session, outputMode);
}

async function runLocalTurn(
  name: string,
  prompt: string,
  opts: {
    model?: string; baseUrl?: string; auth?: string;
    noSession?: boolean; session?: string; continue?: boolean; resume?: boolean; fork?: string;
  },
  cliSession: CliSession,
  outputMode: 'text' | 'json',
): Promise<void> {
  const dbPath = agentDbPath(name);
  if (!existsSync(dbPath)) throw new Error(`Agent "${name}" not found. Create it with: proteus create ${name}`);

  const writer = outputMode === 'json' ? new JsonEventWriter(cliSession, name) : null;
  const llmConfig = resolveLLMConfig(opts);
  const providerCredentials = resolveProviderCredentials();
  const modelResolver = createLocalModelResolver({ llm: llmConfig, credentials: providerCredentials });
  const mcpServers = resolveMcpServers();
  const db = new Database(dbPath);
  const { rt } = openAgentCLI(db, dbPath, { llm: llmConfig, providerCredentials });
  const session = new LocalAgentSession({
    rt,
    db,
    model: resolveChatModel(llmConfig),
    modelResolver,
    sessionId: durableLocalSessionId(opts, cliSession),
    persistMessages: !opts.noSession,
    onEvent: (event) => {
      recordLocalSessionEvent(cliSession, event);
      if (writer) writer.write(event);
      else renderEvent(event);
    },
  });
  if (Object.keys(mcpServers).length > 0) await session.connectMcp(mcpServers);
  try {
    await session.recoverBackgroundJobs();
    await session.send(prompt);
    await session.end();
  } finally {
    db.close();
  }
}

async function runRpc(
  name: string,
  agentMode: 'cloud' | 'local',
  opts: {
    model?: string; baseUrl?: string; auth?: string;
    noSession?: boolean; session?: string; continue?: boolean; resume?: boolean; fork?: string;
  },
): Promise<void> {
  const cliSession = createCliSession(name, opts);
  const output = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
  output({ type: 'session', id: cliSession.id, agent: name, backend: agentMode, cwd: process.cwd() });

  if (agentMode === 'cloud') {
    const auth = requireAuthConfig();
    const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      const cmd = parseRpc(line);
      if (!cmd.ok) { output({ type: 'response', success: false, error: cmd.error }); continue; }
      if (cmd.value.type === 'exit' || cmd.value.type === 'shutdown') break;
      if (cmd.value.type !== 'prompt') {
        output({ id: cmd.value.id, type: 'response', command: cmd.value.type, success: false, error: 'Unsupported command' });
        continue;
      }
      const message = String(cmd.value.message ?? '').trim();
      if (!message) {
        output({ id: cmd.value.id, type: 'response', command: 'prompt', success: false, error: 'message required' });
        continue;
      }
      cliSession.append('user', { text: message, backend: 'cloud' });
      output({ type: 'turn_start', id: cmd.value.id });
      const result = await runCloudTurn(auth.origin, auth.token, name, message, process.cwd());
      cliSession.append('assistant', { text: result.text, toolCalls: result.toolCalls ?? [], steps: result.steps ?? 0 });
      output({ type: 'message_end', role: 'assistant', text: result.text });
      output({ id: cmd.value.id, type: 'response', command: 'prompt', success: true });
      output({ type: 'turn_end', steps: result.steps ?? 0 });
    }
    return;
  }

  const dbPath = agentDbPath(name);
  if (!existsSync(dbPath)) throw new Error(`Agent "${name}" not found. Create it with: proteus create ${name}`);
  ensureLocalDaemonRunning();
  const llmConfig = resolveLLMConfig(opts);
  const providerCredentials = resolveProviderCredentials();
  const modelResolver = createLocalModelResolver({ llm: llmConfig, credentials: providerCredentials });
  const mcpServers = resolveMcpServers();
  const db = new Database(dbPath);
  const { rt } = openAgentCLI(db, dbPath, { llm: llmConfig, providerCredentials });
  const session = new LocalAgentSession({
    rt,
    db,
    model: resolveChatModel(llmConfig),
    modelResolver,
    sessionId: durableLocalSessionId(opts, cliSession),
    persistMessages: !opts.noSession,
    onEvent: (event) => {
      recordLocalSessionEvent(cliSession, event);
      output({ type: 'event', event });
    },
  });
  if (Object.keys(mcpServers).length > 0) await session.connectMcp(mcpServers);
  try {
    await session.recoverBackgroundJobs();
    const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      const cmd = parseRpc(line);
      if (!cmd.ok) { output({ type: 'response', success: false, error: cmd.error }); continue; }
      if (cmd.value.type === 'exit' || cmd.value.type === 'shutdown') break;
      if (cmd.value.type === 'get_state') {
        output({ id: cmd.value.id, type: 'response', command: 'get_state', success: true, data: {
          agent: name,
          backend: 'local',
          sessionId: cliSession.id,
          tools: session.toolNames(),
          model: session.getEffectiveModelSpec(),
        } });
        continue;
      }
      if (cmd.value.type !== 'prompt') {
        output({ id: cmd.value.id, type: 'response', command: cmd.value.type, success: false, error: 'Unsupported command' });
        continue;
      }
      const message = String(cmd.value.message ?? '').trim();
      if (!message) {
        output({ id: cmd.value.id, type: 'response', command: 'prompt', success: false, error: 'message required' });
        continue;
      }
      cliSession.append('user', { text: message, backend: 'local' });
      await session.send(message);
      output({ id: cmd.value.id, type: 'response', command: 'prompt', success: true });
    }
  } finally {
    await session.end().catch(() => {});
    db.close();
  }
}

function durableLocalSessionId(opts: {
  noSession?: boolean;
  session?: string;
  continue?: boolean;
  resume?: boolean;
  fork?: string;
}, cliSession: CliSession): string {
  if (opts.noSession) return cliSession.id;
  if (opts.session || opts.continue || opts.resume || opts.fork) return cliSession.id;
  return defaultAgentSessionId();
}

function renderEvent(event: SessionEvent): void {
  switch (event.type) {
    case 'text-delta':
      process.stdout.write(event.delta);
      break;
    case 'tool-call':
      printToolCall(event.toolName, event.args);
      break;
    case 'tool-result':
      printToolResult(event.result);
      break;
    case 'error':
      console.log(`\n${ERR('error')} ${event.message}`);
      break;
    case 'turn-end':
      console.log('');
      break;
    case 'turn-start':
    case 'evolution':
    case 'broadcast':
      break;
  }
}

async function buildPrompt(parts: string[]): Promise<string> {
  const stdin = !process.stdin.isTTY ? await new Response(Bun.stdin.stream()).text() : '';
  const chunks: string[] = [];
  for (const part of parts) {
    if (part.startsWith('@') && part.length > 1) {
      const path = part.slice(1);
      const content = readFileSync(path, 'utf-8');
      chunks.push(`<file path="${escapeAttr(path)}">\n${content}\n</file>`);
    } else {
      chunks.push(part);
    }
  }
  if (stdin.trim()) chunks.push(`<stdin>\n${stdin.trim()}\n</stdin>`);
  return chunks.join(' ').trim();
}

function writeCloudJsonEvents(session: CliSession, agent: string, result: CloudTurnResult): void {
  const output = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
  output({ type: 'session', id: session.id, agent, backend: 'cloud', cwd: process.cwd() });
  output({ type: 'turn_start', kind: 'user' });
  for (const call of result.toolCalls ?? []) {
    output({ type: 'tool_call', toolName: call.name, args: call.args });
    if (call.result !== undefined) output({ type: 'tool_result', toolName: call.name, result: call.result });
  }
  output({ type: 'message_end', role: 'assistant', text: result.text });
  output({ type: 'turn_end', steps: result.steps ?? 0 });
}

class JsonEventWriter {
  private wroteHeader = false;
  constructor(private readonly session: CliSession, private readonly agent: string) {}
  write(event: SessionEvent): void {
    if (!this.wroteHeader) {
      process.stdout.write(`${JSON.stringify({ type: 'session', id: this.session.id, agent: this.agent, backend: 'local', cwd: process.cwd() })}\n`);
      this.wroteHeader = true;
    }
    process.stdout.write(`${JSON.stringify(event)}\n`);
  }
}

function recordLocalSessionEvent(session: CliSession, event: SessionEvent): void {
  switch (event.type) {
    case 'tool-call':
      session.append('tool_call', { toolName: event.toolName, args: event.args });
      break;
    case 'tool-result':
      session.append('tool_result', { toolName: event.toolName, result: event.result });
      break;
    case 'turn-end':
      session.append('assistant', {
        text: event.turn.assistantResponse,
        steps: event.turn.steps,
        durationMs: event.turn.durationMs,
        hadError: event.turn.hadError,
      });
      break;
    case 'error':
      session.append('error', { message: event.message });
      break;
  }
}

function parseRpc(line: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  try {
    const value = JSON.parse(line) as unknown;
    if (!value || typeof value !== 'object' || !('type' in value)) return { ok: false, error: 'Command must be an object with type' };
    return { ok: true, value: value as Record<string, unknown> };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function normalizeOutputMode(raw: string | undefined): 'text' | 'json' | 'rpc' {
  const mode = (raw ?? 'text').toLowerCase();
  if (mode === 'text' || mode === 'json' || mode === 'rpc') return mode;
  throw new Error('--mode must be text, json, or rpc');
}
