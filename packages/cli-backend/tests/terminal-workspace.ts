/** The workspace and model a terminal-transition test drives, shared with the child process it kills. */
import { Database } from 'bun:sqlite';
import type { LanguageModelV2CallOptions } from '@ai-sdk/provider';
import {
  captureAlternateTakes, initAgentConfigTable,
  initAlternateTakesTable, initScaffoldTables, initSearchTables,
  INITIAL_SCAFFOLD_SOURCE,
  type LLMProviderConfig,
} from '@kinu.run/core';
import { initWorkspaceSchema } from '@kinu.run/core';
import { TestLanguageModelV2 } from './test-language-model';
import { createCLIRuntime, type CLIRuntime , makeWorkspaceSchemaSql } from '../src/runtime';

const DUMMY_LLM: LLMProviderConfig = {
  name: 'fake', baseURL: 'http://localhost:0', headers: {}, model: 'fake-model',
};

const USAGE = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };

/** The workspace over the named database: `:memory:` for in-process restarts, a real path for process restarts. */
export function openTerminalWorkspace(dbPath: string) {
  const db = new Database(dbPath);
  initWorkspaceSchema(makeWorkspaceSchemaSql(db));
  const rt = createCLIRuntime(db, { dbPath, llm: DUMMY_LLM });
  initSearchTables(rt.storage.execRaw);
  initAlternateTakesTable(rt.storage.execRaw);
  initScaffoldTables(rt.storage.execRaw);
  initAgentConfigTable(rt.storage.execRaw);

  // What `kinu create` writes for an unnamed workspace. Written once: a reopen after a kill must find its title.
  if (rt.actor.config.getNameOrigin() === null) rt.actor.config.setDisplayNameOrigin('', 'auto');

  return { db, rt };
}

export async function armShadowTrials(rt: CLIRuntime): Promise<void> {
  await rt.identity.scaffold.write(INITIAL_SCAFFOLD_SOURCE);
  void rt.storage.sql`INSERT OR IGNORE INTO scaffold_versions (actor_id, version, written_at, rationale)
    VALUES (${rt.actor.actorId}, 0, ${Date.now()}, ${'initial bootstrap'})`;
  void rt.storage.sql`INSERT OR REPLACE INTO scaffold_versions (actor_id, version, written_at, rationale, status)
    VALUES (${rt.actor.actorId}, 1, ${Date.now()}, ${'candidate'}, ${'pending'})`;
  rt.actor.config.setShadowSampleRate(1);
}

export function captureTakes(rt: CLIRuntime, rootId: string, at: number): void {
  void rt.storage.sql`INSERT INTO search_nodes (actor_id, root_id, id, task, action, observation, value, visits, depth, status)
    VALUES (${rt.actor.actorId}, ${rootId}, ${rootId}, ${'pick a strategy'}, ${'A'}, ${'go with A'}, 0.9, 3, 1, 'open')`;
  void rt.storage.sql`INSERT INTO search_nodes (actor_id, root_id, id, task, action, observation, value, visits, depth, status)
    VALUES (${rt.actor.actorId}, ${rootId}, ${`${rootId}-alt`}, ${'pick a strategy'}, ${'B'}, ${'go with B'}, 0.85, 3, 1, 'open')`;
  captureAlternateTakes(rt.storage.sql, rt.actor, {
    rootId, task: 'pick a strategy', winnerId: rootId, epsilon: 0.1, now: at,
  });
}

/**
 * A streaming model plus the non-streaming naming-lane arm. `titleCalls` counts round trips (keyed effects are
 * silently idempotent); `onGenerate` runs inside that round trip to cut an effect body mid-way.
 */
export function scriptedModel(
  answer: string,
  opts: {
    readonly toolCall?: { name: string; input: unknown };
    readonly onGenerate?: () => void | Promise<void>;
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
