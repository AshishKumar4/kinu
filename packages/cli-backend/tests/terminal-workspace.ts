/**
 * The workspace and the model a terminal-transition test drives.
 *
 * Shared by the in-process suite and by the child process it kills, because both
 * have to open the SAME workspace: a fixture that bootstrapped its own would
 * prove recovery over a database shaped differently from the one the interrupted
 * turn wrote.
 */
import { Database } from 'bun:sqlite';
import type { LanguageModelV2CallOptions } from '@ai-sdk/provider';
import {
  captureAlternateTakes, createAgentConfigStore, initAgentConfigTable,
  initAlternateTakesTable, initScaffoldTables, initSearchTables,
  INITIAL_SCAFFOLD_SOURCE,
  type LLMProviderConfig,
} from '@kinu.run/core';
import { TestLanguageModelV2 } from './test-language-model';
import { createCLIRuntime, type CLIRuntime } from '../src/runtime';

const DUMMY_LLM: LLMProviderConfig = {
  name: 'fake', baseURL: 'http://localhost:0', headers: {}, model: 'fake-model',
};

const USAGE = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };

/**
 * The workspace, over whichever database the caller names.
 *
 * `:memory:` for a suite that restarts by constructing a second session; a real
 * path for one that restarts by opening a second PROCESS. The bytes are the same
 * either way, which is the point.
 */
export function openTerminalWorkspace(dbPath: string) {
  const db = new Database(dbPath);
  db.exec(`CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL DEFAULT 'default', parent_id TEXT,
    role TEXT NOT NULL, content TEXT NOT NULL,
    created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000))`);
  const rt = createCLIRuntime(db, { dbPath, llm: DUMMY_LLM });
  initSearchTables(rt.storage.execRaw, rt.storage.sql);
  initAlternateTakesTable(rt.storage.execRaw, rt.storage.sql);
  initScaffoldTables(rt.storage.execRaw, rt.storage.sql);
  initAgentConfigTable(rt.storage.execRaw);
  return { db, rt };
}

/** A pending scaffold candidate, sampled on every turn — what makes a turn owe
 *  a shadow trial at all. */
export async function armShadowTrials(rt: CLIRuntime): Promise<void> {
  await rt.identity.scaffold.write(INITIAL_SCAFFOLD_SOURCE);
  void rt.storage.sql`INSERT OR IGNORE INTO scaffold_versions (version, written_at, rationale)
    VALUES (0, ${Date.now()}, ${'initial bootstrap'})`;
  void rt.storage.sql`INSERT OR REPLACE INTO scaffold_versions (version, written_at, rationale, status)
    VALUES (1, ${Date.now()}, ${'candidate'}, ${'pending'})`;
  createAgentConfigStore(rt.storage.sql).setShadowSampleRate(1);
}

/** One competing take set, captured mid-turn the way a real search converge
 *  captures it, waiting to be claimed by whatever turn is credited. */
export function captureTakes(rt: CLIRuntime, rootId: string, at: number): void {
  void rt.storage.sql`INSERT INTO search_nodes (root_id, id, task, action, observation, value, visits, depth, status)
    VALUES (${rootId}, ${rootId}, ${'pick a strategy'}, ${'A'}, ${'go with A'}, 0.9, 3, 1, 'open')`;
  void rt.storage.sql`INSERT INTO search_nodes (root_id, id, task, action, observation, value, visits, depth, status)
    VALUES (${rootId}, ${`${rootId}-alt`}, ${'pick a strategy'}, ${'B'}, ${'go with B'}, 0.85, 3, 1, 'open')`;
  captureAlternateTakes(rt.storage.sql, {
    rootId, task: 'pick a strategy', winnerId: rootId, epsilon: 0.1, now: at,
  });
}

/**
 * A streaming model that answers, plus the non-streaming arm the naming lane
 * drives.
 *
 * `titleCalls` is the auto-title observable: the lane makes exactly one round
 * trip each time it runs, so two calls across a restart is the effect having run
 * twice — which a count of rows could not show, because every other effect here
 * is keyed and therefore silently idempotent.
 *
 * `onGenerate` runs INSIDE that round trip, which is the only seam a test has for
 * cutting through the middle of an effect body: the provisional title has landed
 * and the generated one has not.
 */
export function scriptedModel(
  answer: string,
  opts: {
    readonly toolCall?: { name: string; input: unknown };
    readonly onGenerate?: () => void | Promise<void>;
    /** Runs INSIDE the streaming call, before the answer, with that call's
     *  prompt. The seam a test uses to hold ONE turn open while something else
     *  happens to the ledger — a retry falling due, another process opening. */
    readonly onStream?: (prompt: LanguageModelV2CallOptions['prompt']) => Promise<void>;
  } = {},
) {
  const state = { titleCalls: 0 };
  let step = 0;
  const model = new TestLanguageModelV2({
    provider: 'fake',
    modelId: 'fake-model',
    doGenerate: async () => {
      state.titleCalls += 1;
      await opts.onGenerate?.();
      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ title: 'Parser Work' }) }],
        finishReason: 'stop' as const,
        usage: USAGE,
        response: { id: 'r', modelId: 'fake-model', timestamp: new Date() },
        warnings: [],
      };
    },
    doStream: async (options) => {
      step += 1;
      await opts.onStream?.(options.prompt);
      const callsTool = opts.toolCall !== undefined && step === 1;
      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });
            if (callsTool && opts.toolCall) {
              controller.enqueue({
                type: 'tool-call', toolCallId: `call-${step}`,
                toolName: opts.toolCall.name, input: JSON.stringify(opts.toolCall.input),
              });
              controller.enqueue({ type: 'finish', finishReason: 'tool-calls', usage: USAGE });
              controller.close();
              return;
            }
            controller.enqueue({ type: 'text-start', id: '0' });
            controller.enqueue({ type: 'text-delta', id: '0', delta: answer });
            controller.enqueue({ type: 'text-end', id: '0' });
            controller.enqueue({ type: 'finish', finishReason: 'stop', usage: USAGE });
            controller.close();
          },
        }),
        response: { headers: {} },
      };
    },
  });
  return { model, state };
}
