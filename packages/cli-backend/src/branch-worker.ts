/**
 * Branch worker process — runs inside a forked child process.
 *
 * Each MCTS branch gets its own isolated SQLite database.
 * Loads crafted tools from the PARENT's DB so branches can leverage
 * the agent's learned capabilities during exploration.
 *
 * Protocol:
 *   Parent → Child: { method: 'explore'|'evaluate'|'reflect', args: any }
 *   Child → Parent: { method: string, result?: any, error?: string }
 */

import { Database } from 'bun:sqlite';
import { createVercelAILLM } from '@proteus/core';
import type { CraftedTool } from '@proteus/core';

const dbPath = process.argv[2];
if (!dbPath) {
  console.error('[branch-worker] No database path provided');
  process.exit(1);
}

const llmConfig = {
  name: 'workers-ai',
  baseURL: process.env.PROTEUS_BASE_URL ?? '',
  headers: { 'Authorization': process.env.PROTEUS_AUTH ?? '' },
  model: process.env.PROTEUS_MODEL ?? '@cf/moonshotai/kimi-k2.6',
};

const llm = createVercelAILLM(llmConfig);

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
try {
  const parentDbPath = process.env.PROTEUS_PARENT_DB;
  if (parentDbPath) {
    const parentDb = new Database(parentDbPath, { readonly: true });
    const tools = parentDb.query('SELECT name, description FROM crafted_tools').all() as CraftedTool[];
    if (tools.length > 0) {
      craftedToolHints = '\nKnown patterns:\n' + tools.map(t => `- ${t.name}: ${t.description}`).join('\n');
    }
    parentDb.close();
  }
} catch {}

process.on('message', async (msg: { method: string; args: unknown }) => {
  try {
    let result: unknown;
    switch (msg.method) {
      case 'explore': {
        const { history } = msg.args as {
          history: Array<{ role: string; content: string }>;
          tools: unknown[];
        };
        const context = history
          .map(m => `${m.role}: ${m.content}`)
          .join('\n')
          .slice(-800);
        const response = await llm.complete(
          `You are an expert exploring one approach to solve a task.${craftedToolHints}\n\n` +
          `Context:\n${context}\n\n` +
          `Propose ONE specific concrete approach in 2-3 sentences.`
        );
        const text = response.trim();
        // Store trace in the branch's own DB
        db.run('INSERT INTO traces (step, text) VALUES (?, ?)', [1, text]);
        result = { text, codeUsed: null };
        break;
      }
      case 'evaluate': {
        const { task } = msg.args as { task: string };
        const response = await llm.complete(
          `Rate this approach for effectiveness (0.0-1.0):\n${task.slice(0, 500)}\n\n` +
          `Respond ONLY with JSON: {"score": <float>, "reason": "<5 words>"}`
        );
        try {
          const m = response.match(/\{[^}]+\}/);
          const parsed = JSON.parse(m?.[0] ?? '{"score":0.5}');
          result = Math.min(1, Math.max(0, Number(parsed.score) || 0.5));
        } catch { result = 0.5; }
        break;
      }
      case 'reflect': {
        const { task } = msg.args as { task: string };
        const response = await llm.complete(
          `What specifically went wrong with this approach?\n${task.slice(0, 500)}\n\n` +
          `One sentence only.`
        );
        result = response.trim();
        break;
      }
      default:
        throw new Error(`Unknown method: ${msg.method}`);
    }
    process.send!({ method: msg.method, result });
  } catch (err) {
    process.send!({ method: msg.method, error: (err as Error).message });
  }
});

process.send?.({ method: 'ready' });
