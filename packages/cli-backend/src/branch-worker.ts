/**
 * Branch worker process — runs inside a forked child process.
 *
 * Each MCTS branch gets its own isolated SQLite database.
 * Loads crafted tools from the PARENT's DB so branches can leverage
 * the agent's learned capabilities during exploration.
 *
 * Protocol:
 *   Parent → Child: { method: 'explore'|'reflect', args: any }
 *   Child → Parent: { method: string, result?: any, error?: string }
 *
 * There is deliberately no 'evaluate' method: branch scoring happens in the
 * parent process at the engine seam (core mcts/evaluation.ts), grounded in
 * execution — branches must not rate themselves.
 */

import { Database } from 'bun:sqlite';
import { generateText } from 'ai';
import {
  DEFAULT_WORKERS_AI_MODEL_ID,
  diversityDirective,
  formatInheritedContext,
  parseModelSpec,
  reasoningEffortOptions,
  type CraftedTool,
  type LLMProviderConfig,
} from '@proteus/core';
import { createLocalModelResolver, type LocalProviderCredentials } from './model-resolver.js';
import { createFileCodexAuthStore } from './codex-auth-store.js';

const dbPath = process.argv[2];
if (!dbPath) {
  console.error('[branch-worker] No database path provided');
  process.exit(1);
}

const llmConfig: LLMProviderConfig = {
  name: process.env.PROTEUS_LLM_NAME ?? 'workers-ai',
  baseURL: process.env.PROTEUS_BASE_URL ?? '',
  headers: readJson<Record<string, string>>(process.env.PROTEUS_LLM_HEADERS) ?? {
    Authorization: process.env.PROTEUS_AUTH ?? '',
  },
  model: process.env.PROTEUS_MODEL ?? DEFAULT_WORKERS_AI_MODEL_ID,
};

const modelResolver = createLocalModelResolver({
  llm: llmConfig,
  credentials: {
    ...(readJson<LocalProviderCredentials>(process.env.PROTEUS_PROVIDER_CREDENTIALS) ?? {}),
    ...(process.env.CODEX_ACCESS_TOKEN ? { codexAccessToken: process.env.CODEX_ACCESS_TOKEN } : {}),
  },
  codexAuthStore: process.env.PROTEUS_CONFIG_PATH
    ? createFileCodexAuthStore(process.env.PROTEUS_CONFIG_PATH)
    : undefined,
});

// Open the branch's SQLite DB for trace storage
const db = new Database(dbPath);
db.exec('PRAGMA journal_mode = WAL');
db.exec(`CREATE TABLE IF NOT EXISTS traces (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  step INTEGER NOT NULL, text TEXT NOT NULL,
  code_used TEXT, created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
)`);

// Load crafted tools from the parent DB if available
let craftedToolHints = '';
let parentDb: Database | null = null;
try {
  const parentDbPath = process.env.PROTEUS_PARENT_DB;
  if (parentDbPath) {
    parentDb = new Database(parentDbPath, { readonly: true });
    const tools = parentDb.query('SELECT name, description FROM crafted_tools').all() as CraftedTool[];
    if (tools.length > 0) {
      craftedToolHints = '\nKnown patterns:\n' + tools.map(t => `- ${t.name}: ${t.description}`).join('\n');
    }
  }
} catch {}

process.on('message', async (msg: { method: string; args: unknown }) => {
  try {
    let result: unknown;
    switch (msg.method) {
      case 'explore': {
        const { history, siblings = [] } = msg.args as {
          history: Array<{ role: string; content: string }>;
          tools: unknown[];
          siblings?: readonly string[];
        };
        const context = formatInheritedContext(history);
        // Mirror cf-backend/src/exploration.ts: ask for a ```js implementation
        // when applicable so the branch is execution-groundable (the grounded
        // evaluator runs extracted code) — not prose-only.
        const { model, providerOptions } = resolveLowEffortModel();
        const { text } = await generateText({
          model,
          system: 'You are an expert agent exploring one approach to solve a task.' + craftedToolHints +
            '\n\nIf your approach involves code, include it in a ```js code block.',
          messages: [{ role: 'user' as const, content: `Prior context:\n${context}\n\nPropose ONE specific concrete approach. Include a code implementation if applicable.${diversityDirective(siblings)}` }],
          ...(providerOptions ? { providerOptions } : {}),
        });
        const trimmed = text.trim();
        const codeMatch = trimmed.match(/```(?:js|javascript|typescript|ts)?\n([\s\S]*?)```/);
        const codeUsed = codeMatch?.[1]?.trim() ?? null;
        // Persist code_used so reflect + the parent's trace inspection see it.
        db.run('INSERT INTO traces (step, text, code_used) VALUES (?, ?, ?)', [1, trimmed, codeUsed]);
        result = { text: trimmed, codeUsed };
        break;
      }
      case 'reflect': {
        const { task } = msg.args as { task: string };
        // Read the branch's own trace table (mirror cf generateReflection): the
        // reflection is about the attempt this branch actually made, not the
        // bare task string.
        const traces = db.query('SELECT text FROM traces ORDER BY step').all() as Array<{ text: string }>;
        const attempt = traces.map(t => t.text).join('\n');
        const { model, providerOptions } = resolveLowEffortModel();
        const { text } = await generateText({
          model,
          messages: [{ role: 'user' as const, content: `Task: ${task}\nAttempt: ${attempt}\n\nWhat specifically went wrong? One sentence.` }],
          ...(providerOptions ? { providerOptions } : {}),
        });
        result = text.trim();
        break;
      }
      default:
        throw new Error(`Unknown method: ${msg.method}`);
    }
    process.send!({ method: msg.method, result });
  } catch (err) {
    // Always carry a message: an empty one reads as "no error" to any
    // presence-checking caller and hides the real failure.
    const message = err instanceof Error && err.message ? err.message : String(err) || 'branch worker failed';
    process.send!({ method: msg.method, error: message });
  }
});

process.send?.({ method: 'ready' });

process.once('exit', () => {
  try { parentDb?.close(); } catch {}
  try { db.close(); } catch {}
});

function readStoredModelSpec(): string | null {
  try {
    const row = parentDb?.query("SELECT value FROM agent_config WHERE key = 'model' LIMIT 1").get() as { value: string } | null | undefined;
    return row?.value ?? null;
  } catch {
    return null;
  }
}

function resolveLowEffortModel() {
  const spec = modelResolver.normalizeSpecSync(readStoredModelSpec());
  return {
    model: modelResolver.resolveModel(spec),
    providerOptions: reasoningEffortOptions('low', parseModelSpec(spec).provider),
  };
}

function readJson<T>(raw: string | undefined): T | null {
  if (!raw) return null;
  try { return JSON.parse(raw) as T; }
  catch { return null; }
}
