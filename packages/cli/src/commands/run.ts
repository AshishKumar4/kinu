import { existsSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { createLocalModelResolver, LocalAgentSession, openAgentCLI, resolveChatModel, type SessionEvent } from '@proteus/cli-backend';
import {
  agentDbPath, requireAuthConfig, resolveAgentRef, resolveLLMConfig,
  resolveMcpServers, resolveProviderCredentials,
} from '../config.js';
import { runCloudTurn } from '../cloud-api.js';
import { chatCommand } from './chat.js';
import { ACCENT, DIM, ERR, printToolCall, printToolResult } from '../display.js';

export async function runCommand(name: string, promptParts: string[], opts: {
  model?: string; baseUrl?: string; auth?: string; classic?: boolean;
}): Promise<void> {
  const prompt = promptParts.join(' ').trim();
  const agent = resolveAgentRef(name);
  const mode = agent?.mode ?? (existsSync(agentDbPath(name)) ? 'local' : 'cloud');
  const canonicalName = agent?.name ?? name;

  if (!prompt) {
    if (mode === 'cloud') {
      console.log(DIM('Cloud interactive chat is not streaming yet. Use:'));
      console.log(`  ${ACCENT(`proteus run ${canonicalName} "your task"`)}\n`);
      return;
    }
    await chatCommand(canonicalName, opts);
    return;
  }

  if (mode === 'cloud') {
    const auth = requireAuthConfig();
    const result = await runCloudTurn(auth.origin, auth.token, agent?.cloudName ?? canonicalName, prompt, process.cwd());
    if (result.text.trim()) console.log(result.text);
    return;
  }

  await runLocalTurn(canonicalName, prompt, opts);
}

async function runLocalTurn(name: string, prompt: string, opts: { model?: string; baseUrl?: string; auth?: string }): Promise<void> {
  const dbPath = agentDbPath(name);
  if (!existsSync(dbPath)) throw new Error(`Agent "${name}" not found. Create it with: proteus create ${name}`);

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
    onEvent: renderEvent,
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
