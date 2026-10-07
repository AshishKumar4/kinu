/**
 * "Beta: swarms" on the CLI across real turns of one session: the account's catalog decides whether a turn's `agents`
 * tool offers `swarm` and whether a swarm call runs, and the next turn follows the setting when it moves either way.
 * A session with no catalog bootstraps one with the beta off (the cf twin is cf-backend/tests/unit-beta-swarms.test.ts).
 */
import { expect, test } from 'bun:test';
import type { LanguageModelV2FunctionTool } from '@ai-sdk/provider';
import * as v from 'valibot';
import { profileCatalogDigest } from '@kinu.run/core';
import { createLocalProfileAuthority, staticModelPlane } from '../src/profile-authority';
import { setup } from './helpers/local-session';
import { TestLanguageModelV2 } from './test-language-model';

const USAGE = { inputTokens: 5, outputTokens: 7, totalTokens: 12 };

const TURNS = ['compare three caching designs', 'compare them again', 'and once more'];

/** Each of the session's turns asks for one swarm and answers once it has its result; the swarm's own nodes answer. */
function swarmAsker(offered: string[][]): TestLanguageModelV2 {
  return new TestLanguageModelV2({
    provider: 'fake',
    modelId: 'fake-model',
    doStream: async (options) => {
      const agents = (options.tools ?? []).find((tool): tool is LanguageModelV2FunctionTool => tool.name === 'agents' && tool.type === 'function');
      const last = options.prompt.at(-1);
      const asks = agents !== undefined && last?.role === 'user' && last.content.some((part) => part.type === 'text' && TURNS.includes(part.text));

      if (asks) offered.push(v.parse(v.object({ properties: v.object({ action: v.object({ enum: v.array(v.string()) }) }) }), agents.inputSchema).properties.action.enum);

      return {
        stream: new ReadableStream({
          start(controller) {
            controller.enqueue({ type: 'stream-start', warnings: [] });

            if (asks) {
              controller.enqueue({ type: 'tool-call', toolCallId: crypto.randomUUID(), toolName: 'agents', input: JSON.stringify({ action: 'swarm', task: 'rank three caching designs' }) });
              controller.enqueue({ type: 'finish', finishReason: 'tool-calls', usage: USAGE });
            } else {
              controller.enqueue({ type: 'text-start', id: '0' });
              controller.enqueue({ type: 'text-delta', id: '0', delta: 'done' });
              controller.enqueue({ type: 'text-end', id: '0' });
              controller.enqueue({ type: 'finish', finishReason: 'stop', usage: USAGE });
            }

            controller.close();
          },
        }),
        response: { headers: {} },
      };
    },
  });
}

test('a turn offers and runs swarm only while the account has the beta on, and follows it as it moves', async () => {
  const offered: string[][] = [];
  let beta: boolean | null = null;

  const { rt, session } = setup('unused', swarmAsker(offered), {
    profileAuthority: async () => {
      if (beta === null) return null;
      const envelope = await createLocalProfileAuthority({ config: rt.actor.config, plane: staticModelPlane() }).envelope();
      const catalog = { ...envelope.catalog, betaSwarms: beta };

      return { authority: { kind: 'local' }, version: 0, digest: profileCatalogDigest(catalog), catalog };
    },
  });

  const swarmEnds = () => session.listRuns().items.flatMap((run) => session.getRunEvents(run.runId))
    .filter((event) => event.type === 'tool_call_end' && event.name === 'agents')
    .map((event) => v.parse(v.object({ timestamp: v.string(), outcome: v.object({ success: v.boolean(), reason: v.optional(v.string()) }), result: v.unknown() }), event))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  try {
    // No catalog yet: bootstrapped with the beta off.
    await session.send(TURNS[0] ?? '', { id: crypto.randomUUID() });
    beta = true;
    await session.send(TURNS[1] ?? '', { id: crypto.randomUUID() });
    await session.settleBackgroundWork();
    beta = false;
    await session.send(TURNS[2] ?? '', { id: crypto.randomUUID() });
  } finally {
    await session.end();
  }

  const ends = swarmEnds();

  expect(offered.map((actions) => actions.includes('swarm'))).toEqual([false, true, false]);
  expect(ends.map((end) => end.outcome.reason ?? 'ran')).toEqual(['denied', 'ran', 'denied']);
  // The swarm the beta let through ran as a job of its own, to its end.
  const job = v.parse(v.object({ jobId: v.string() }), ends[1]?.result).jobId;
  expect(rt.storage.sql<{ status: string }>`SELECT status FROM background_jobs WHERE id = ${job}`).toEqual([{ status: 'completed' }]);
});
