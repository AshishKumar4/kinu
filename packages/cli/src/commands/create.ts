import { mkdirSync, existsSync } from 'node:fs';
import * as readline from 'node:readline';
import { Database } from 'bun:sqlite';
import {
  createAgent,
  initSearchTables,
  initScaffoldTables,
  initCraftScoreTables,
} from '@proteus/core';
import {
  agentDbPath, agentDir, ensureAgentHome, resolveLLMConfig,
  upsertAgentConfig, writeAliasShim, pathHint, requireAuthConfig,
  type AgentMode,
} from '../config.js';
import { createCloudAgent } from '../cloud-api.js';
import { ACCENT, DIM, OK, createSpinner, printCreatedCard, printError } from '../display.js';

export async function createCommand(name: string | undefined, opts: {
  purpose?: string; model?: string; baseUrl?: string; auth?: string;
  mode?: string; alias?: string; aliasAgent?: boolean;
}): Promise<void> {
  ensureAgentHome();
  const interactive = process.stdin.isTTY && (!name || !opts.mode);
  if (!name) {
    name = interactive
      ? await ask('Agent name', 'jarvis')
      : undefined;
  }
  if (!name) throw new Error('Agent name required.');
  const mode = await resolveMode(opts.mode, interactive);
  const purpose = opts.purpose ?? `A helpful AI assistant named ${name}.`;
  const alias = opts.aliasAgent === false
    ? undefined
    : opts.alias ?? (interactive ? await ask('Alias command', name) : name);

  if (mode === 'cloud') {
    const auth = requireAuthConfig();
    const spinner = createSpinner('Creating cloud agent...');
    spinner.start();
    const agent = await createCloudAgent(auth.origin, auth.token, { name, displayName: name, purpose });
    upsertAgentConfig({
      name,
      mode: 'cloud',
      cloudName: agent.name,
      alias: alias || undefined,
      purpose,
    });
    let aliasPathText = '';
    if (alias) aliasPathText = writeAliasShim(name, alias);
    spinner.stop('Cloud agent created');
    console.log(`\n${OK('✓')} ${ACCENT(name)} ${DIM('cloud agent')}`);
    if (alias) console.log(`${DIM('Alias:')} ${ACCENT(alias)} ${DIM(aliasPathText)}`);
    const hint = pathHint();
    if (hint) console.log(DIM(hint));
    console.log(`\n${DIM('Run:')} ${ACCENT(alias || `proteus run ${name}`)} ${DIM('"do something"')}\n`);
    return;
  }

  const dir = agentDir(name);
  const dbPath = agentDbPath(name);

  if (existsSync(dbPath)) {
    printError(`Agent "${name}" already exists.`, `Use a different name or delete ${dir}`);
    process.exit(1);
  }

  const llmConfig = resolveLLMConfig(opts);

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

  upsertAgentConfig({
    name,
    mode: 'local',
    localName: name,
    alias: alias || undefined,
    purpose,
  });
  if (alias) writeAliasShim(name, alias);

  spinner.stop('Agent created');
  printCreatedCard(name, purpose, llmConfig.model, dbPath);
  const hint = pathHint();
  if (hint) console.log(DIM(hint));
}

async function resolveMode(raw: string | undefined, interactive: boolean): Promise<AgentMode> {
  if (raw) {
    if (raw === 'local' || raw === 'cloud') return raw;
    throw new Error('--mode must be local or cloud');
  }
  if (!interactive) return 'cloud';
  const answer = (await ask('Mode (cloud/local)', 'cloud')).toLowerCase();
  if (answer === 'local' || answer === 'l') return 'local';
  return 'cloud';
}

async function ask(label: string, fallback: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise<string>(resolve => rl.question(`${DIM(label)} ${DIM(`[${fallback}]`)} ${ACCENT('›')} `, resolve));
  rl.close();
  return answer.trim() || fallback;
}
