import { mkdirSync, existsSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import {
  createAgent,
  initSearchTables,
  initScaffoldTables,
  initCraftScoreTables,
} from '@proteus/core';
import { agentDbPath, agentDir, ensureAgentHome, resolveLLMConfig } from '../config.js';
import { createSpinner, printCreatedCard, printError } from '../display.js';

export async function createCommand(name: string, opts: {
  purpose?: string; model?: string; baseUrl?: string; auth?: string;
}): Promise<void> {
  ensureAgentHome();
  const dir = agentDir(name);
  const dbPath = agentDbPath(name);

  if (existsSync(dbPath)) {
    printError(`Agent "${name}" already exists.`, `Use a different name or delete ${dir}`);
    process.exit(1);
  }

  const llmConfig = resolveLLMConfig(opts);
  const purpose = opts.purpose ?? `A helpful AI assistant named ${name}.`;

  const spinner = createSpinner('Creating agent...');
  spinner.start();

  mkdirSync(dir, { recursive: true });
  const db = new Database(dbPath);
  db.exec('PRAGMA journal_mode = WAL');

  createAgent(db, { name, purpose, llm: llmConfig });
  initSearchTables((ddl: string) => db.exec(ddl));
  initScaffoldTables((ddl: string) => db.exec(ddl));
  initCraftScoreTables((ddl: string) => db.exec(ddl));

  db.close();

  spinner.stop('Agent created');
  printCreatedCard(name, purpose, llmConfig.model, dbPath);
}
