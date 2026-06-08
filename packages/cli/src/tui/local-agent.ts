import { statSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { createLocalModelResolver, openAgentCLI } from '@proteus/cli-backend';
import {
  CONFIG_PATH,
  agentDbPath,
  createCodexAuthStore,
  resolveLLMConfig,
  resolveMcpServers,
  resolveProviderCredentials,
} from '../config.js';
import type { ChatAppOpts } from './chat-app.js';

export interface OpenLocalTuiAgentOptions {
  model?: string;
  baseUrl?: string;
  auth?: string;
  noAutoEvolve?: boolean;
  initialPrompt?: string;
}

export function openLocalTuiAgent(name: string, opts: OpenLocalTuiAgentOptions): ChatAppOpts & { close: () => void } {
  const dbPath = agentDbPath(name);
  const llmConfig = resolveLLMConfig(opts);
  const providerCredentials = resolveProviderCredentials();
  const codexAuthStore = createCodexAuthStore();
  const modelResolver = createLocalModelResolver({
    llm: llmConfig,
    credentials: providerCredentials,
    codexAuthStore,
  });
  const mcpServers = resolveMcpServers();
  const db = new Database(dbPath);
  const openConfig = { llm: llmConfig, providerCredentials, codexAuthStore, codexConfigPath: CONFIG_PATH };
  const { rt, info } = openAgentCLI(db, dbPath, openConfig);
  const dbSize = statSync(dbPath).size;
  const refreshInfo = () => openAgentCLI(db, dbPath, openConfig).info;
  return {
    rt,
    db,
    info,
    dbSize,
    llmConfig,
    modelResolver,
    refreshInfo,
    noAutoEvolve: opts.noAutoEvolve ?? false,
    mcpServers,
    initialPrompt: opts.initialPrompt,
    close: () => db.close(),
  };
}
