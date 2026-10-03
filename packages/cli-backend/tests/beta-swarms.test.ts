/**
 * "Beta: swarms" on the CLI: the account's catalog decides whether a turn's `agents` tool offers `swarm` (the cf twin
 * is cf-backend/tests/unit-beta-swarms.test.ts). A session with no catalog bootstraps one with the beta off.
 */
import { describe, expect, test } from 'bun:test';
import type { LanguageModelV2FunctionTool } from '@ai-sdk/provider';
import * as v from 'valibot';
import { setup, toolSequenceModel } from './helpers/local-session';

/** Asks for a swarm, recording the `agents` actions each step offered. */
function swarmAsker(offered: string[][]) {
  return toolSequenceModel([{ name: 'agents', input: { action: 'swarm', task: 'rank three caching designs' } }], (options) => {
    const agents = (options.tools ?? []).find((tool): tool is LanguageModelV2FunctionTool => tool.name === 'agents' && tool.type === 'function');

    // A swarm's own nodes are asked too, with no agents tool.
    if (agents === undefined) return;

    const schema = v.parse(v.object({ properties: v.object({ action: v.object({ enum: v.array(v.string()) }) }) }), agents.inputSchema);

    offered.push(schema.properties.action.enum);
  });
}

describe('a turn offers swarm only when the account turned the beta on', () => {
  test('off: no swarm in the tool, and a swarm call is refused naming the setting', async () => {
    const offered: string[][] = [];
    const { session } = setup('unused', swarmAsker(offered), { profileAuthority: () => null });

    await session.send('compare three caching designs', { id: crypto.randomUUID() });

    const ended = session.listRuns().items.flatMap((run) => session.getRunEvents(run.runId))
      .find((event) => event.type === 'tool_call_end' && event.name === 'agents');

    expect(offered[0]).not.toContain('swarm');
    expect(JSON.stringify(ended)).toContain('Beta: swarms');
    await session.end();
  });

  test('on: the tool offers swarm', async () => {
    const offered: string[][] = [];
    const { session } = setup('unused', swarmAsker(offered));

    await session.send('compare three caching designs', { id: crypto.randomUUID() });

    expect(offered[0]).toContain('swarm');
    await session.end();
  });
});
