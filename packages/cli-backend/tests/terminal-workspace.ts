/** The workspace and model a terminal-transition test drives, shared with the child process it kills. */
import type { LanguageModelV2CallOptions } from '@ai-sdk/provider';
import {
  initAgentConfigTable,
  initAlternateTakesTable, initScaffoldTables, initSearchTables,
  type LLMProviderConfig,
} from '@kinu.run/core';
import { initWorkspaceSchema } from '@kinu.run/core';
import { writeText } from '@nimbus-sh/core/vfs/vfs.js';
import type { AgentRuntime } from '@kinu.run/core';
import { TestLanguageModelV2 } from './test-language-model';
import { createCLIRuntime, makeWorkspaceSchemaSql } from '../src/runtime';
import { scratchDir, workspaceDatabase } from '@kinu.run/test-utils';

const DUMMY_LLM: LLMProviderConfig = {
  name: 'fake', baseURL: 'http://localhost:0', headers: {}, model: 'fake-model',
};

const USAGE = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };

/** The workspace over the named database file, in a fresh folder; a child process reopens the same file. */
export function openTerminalWorkspace(dbPath: string) {
  const db = workspaceDatabase(dbPath);
  initWorkspaceSchema(makeWorkspaceSchemaSql(db));
  const rt = createCLIRuntime(db, { cwd: scratchDir('workspace-folder'), llm: DUMMY_LLM });
  initSearchTables(rt.storage.execRaw);
  initAlternateTakesTable(rt.storage.execRaw);
  initScaffoldTables(rt.storage.execRaw);
  initAgentConfigTable(rt.storage.execRaw);

  // What `kinu create` writes for an unnamed workspace. Written once: a reopen after a kill must find its title.
  if (rt.actor.config.getNameOrigin() === null) rt.actor.config.setDisplayNameOrigin('', 'auto');

  return { db, rt };
}

/** A promoted program that hands every turn to the default loop: the turn runs as a recorded program version. */
export const DELEGATING_PROGRAM = 'async function run({ task }) { await host.defaultInference(); }';

/** Writes the program's version file, where promotion and a recovery's verification read it, and makes it current. */
export async function installProgram(rt: AgentRuntime, version: number, code: string): Promise<void> {
  await writeText(rt.agentStateVfs ?? rt.storage.vfs, `${rt.identity.scaffold.path}.v${version}`, code);
  await rt.identity.scaffold.write(code);
  void rt.storage.sql`
    INSERT OR REPLACE INTO scaffold_versions (actor_id, version, written_at, rationale, status)
    VALUES (${rt.actor.actorId}, ${version}, ${Date.now()}, ${`v${version}`}, ${'current'})`;
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
