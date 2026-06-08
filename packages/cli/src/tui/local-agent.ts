import { statSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { openAgentCLI } from '@proteus/cli-backend';
import {
  CONFIG_PATH,
  agentDbPath,
  createCodexAuthStore,
  resolveMcpServers,
  resolveProviderCredentials,
} from '../config.js';
import type { ChatAppOpts } from './chat-app.js';
import { createConfiguredLocalModelResolver } from '../local-model-resolver.js';

export interface OpenLocalTuiAgentOptions {
  model?: string;
  baseUrl?: string;
  auth?: string;
  noAutoEvolve?: boolean;
  initialPrompt?: string;
}

export function openLocalTuiAgent(name: string, opts: OpenLocalTuiAgentOptions): ChatAppOpts & { close: () => void } {
  const dbPath = agentDbPath(name);
  const { llmConfig, resolver: modelResolver } = createConfiguredLocalModelResolver(opts);
  const providerCredentials = resolveProviderCredentials();
  const codexAuthStore = createCodexAuthStore();
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
