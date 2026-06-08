import { existsSync, statSync } from 'node:fs';
import * as readline from 'node:readline';
import { Database } from 'bun:sqlite';
import { createLocalModelResolver, openAgentCLI } from '@proteus/cli-backend';
import {
  agentDbPath,
  CONFIG_PATH,
  createCodexAuthStore,
  listAgentDirs,
  listConfiguredAgentRefs,
  requireAuthConfig,
  resolveAgentRef,
  resolveLLMConfig,
  resolveMcpServers,
  resolveProviderCredentials,
} from '../config.js';
import { runTuiChat } from '../tui/chat-app.js';
import { runChatLoop } from '../chat-loop.js';
import { ensureLocalDaemonRunning } from './daemon.js';
import { printError, ACCENT, DIM } from '../display.js';
import { runCloudChatLoop } from '../cloud-chat-loop.js';
import { createCliSession } from '../session.js';

export async function chatCommand(name: string | undefined, opts: {
  model?: string; baseUrl?: string; auth?: string; classic?: boolean;
}): Promise<void> {
  // No name: let user pick from existing agents
  if (!name) {
    const localAgents = new Set(listAgentDirs());
    const agents = [
      ...[...localAgents].map((agentName) => ({ name: agentName, label: agentName })),
      ...listConfiguredAgentRefs()
        .filter((agent) => agent.mode === 'cloud' || !localAgents.has(agent.localName ?? agent.name))
        .map((agent) => ({
          name: agent.name,
          label: agent.mode === 'cloud' ? `${agent.name} (cloud)` : agent.name,
        })),
    ];
    if (agents.length === 0) {
      printError('No agents found.', 'Create one with: proteus create <name>');
      process.exit(1);
    }
    if (agents.length === 1) {
      name = agents[0]!.name;
    } else {
      console.log(`\n${DIM('Select an agent:')}`);
      agents.forEach((a, i) => console.log(`  ${ACCENT(String(i + 1))} ${a.label}`));
      console.log('');
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      const answer = await new Promise<string>(resolve => rl.question(`${DIM('Agent #: ')}`, resolve));
      rl.close();
      const idx = parseInt(answer, 10) - 1;
      if (idx < 0 || idx >= agents.length) {
        printError('Invalid selection.');
        process.exit(1);
      }
      name = agents[idx]!.name;
    }
  }

  const configured = name ? resolveAgentRef(name) : null;
  if (configured?.mode === 'cloud') {
    const auth = requireAuthConfig();
    const session = createCliSession(configured.name);
    await runCloudChatLoop({
      origin: auth.origin,
      token: auth.token,
      agentName: configured.name,
      cloudName: configured.cloudName ?? configured.name,
      session,
    });
    return;
  }
  if (configured?.mode === 'local') name = configured.localName ?? configured.name;

  const dbPath = agentDbPath(name);
  if (!existsSync(dbPath)) {
    printError(`Agent "${name}" not found.`, `Create it with: proteus create ${name}`);
    process.exit(1);
  }

  const llmConfig = resolveLLMConfig(opts);
  const providerCredentials = resolveProviderCredentials();
  const codexAuthStore = createCodexAuthStore();
  const modelResolver = createLocalModelResolver({
    llm: llmConfig,
    credentials: providerCredentials,
    codexAuthStore,
  });
  ensureLocalDaemonRunning();
  const mcpServers = resolveMcpServers();
  const db = new Database(dbPath);
  const openConfig = { llm: llmConfig, providerCredentials, codexAuthStore, codexConfigPath: CONFIG_PATH };
  const { rt, info } = openAgentCLI(db, dbPath, openConfig);
  const dbSize = statSync(dbPath).size;
  const refreshInfo = () => openAgentCLI(db, dbPath, openConfig).info;

  // Use TUI by default, fall back to classic readline with --classic flag
  // or when stdin is not a TTY (piped input)
  if (opts.classic || !process.stdin.isTTY) {
    await runChatLoop({ rt, db, info, dbSize, llmConfig, modelResolver, refreshInfo, mcpServers });
  } else {
    await runTuiChat({ rt, db, info, dbSize, llmConfig, modelResolver, refreshInfo, noAutoEvolve: false, mcpServers });
  }
  db.close();
}
