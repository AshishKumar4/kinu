import { existsSync, statSync } from 'node:fs';
import { Database } from 'bun:sqlite';
import { openAgentCLI } from '@proteus/cli-backend';
import { agentDbPath, resolveAgentRef, resolveLLMConfig, resolveProviderCredentials } from '../config.js';
import { ACCENT, DIM, printAgentStatus, printError } from '../display.js';

export async function statusCommand(name: string, opts: {
  model?: string; baseUrl?: string; auth?: string;
}): Promise<void> {
  const configured = resolveAgentRef(name);
  if (configured?.mode === 'cloud') {
    console.log(`\n${DIM('Cloud agent:')} ${ACCENT(configured.name)}`);
    console.log(DIM('Use the dashboard for detailed cloud status, or run:'));
    console.log(`  ${ACCENT(`proteus run ${configured.name} "status"`)}\n`);
    return;
  }
  name = configured?.localName ?? configured?.name ?? name;
  const dbPath = agentDbPath(name);
  if (!existsSync(dbPath)) {
    printError(`Agent "${name}" not found.`, `Create it with: proteus create ${name}`);
    process.exit(1);
  }

  const llmConfig = resolveLLMConfig(opts);
  const db = new Database(dbPath);
  const { info } = openAgentCLI(db, dbPath, {
    llm: llmConfig,
    providerCredentials: resolveProviderCredentials(),
  });
  const dbSize = statSync(dbPath).size;

  const conversationCount = (db.query('SELECT COUNT(DISTINCT session_id) as c FROM messages').get() as { c: number })?.c ?? 0;

  printAgentStatus(info, dbSize, { conversationCount });
  db.close();
}
