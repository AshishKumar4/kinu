/**
 * `kinu` inspecting a cloud workspace, end to end: the real CLI reads the real orchestrator's answers over the route
 * the CLI calls, and prints rows. Defends: an enveloped read left unformatted, and an event row carrying the fields
 * that stay inside the workspace.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import * as v from 'valibot';
import { runToExit, scratchDir } from '@kinu.run/test-utils';
import { eventsOver, orchestratorHarness, type HarnessOrchestratorAgent } from './helpers/actor-harness';

const CLI = resolve(import.meta.dir, '../../cli/bin/cli.ts');

const RpcSchema = v.object({ method: v.string(), args: v.array(v.unknown()) });

const LimitSchema = v.optional(v.number());

const FilterSchema = v.optional(v.object({ limit: v.optional(v.number()), variant: v.optional(v.string()), since: v.optional(v.number()) }));

const EventRowSchema = v.looseObject({ id: v.string(), variant: v.string(), ingress: v.string() });

/** The reads the inspect commands make, answered by the orchestrator itself. */
function answer(agent: HarnessOrchestratorAgent, method: string, args: readonly unknown[]): Promise<readonly object[]> {
  switch (method) {
    case 'listRecentEvents': return agent.listRecentEvents(v.parse(FilterSchema, args[0]));
    case 'getRunTimeline': return agent.getRunTimeline(v.parse(FilterSchema, args[0]));
    case 'getHeadRuns': return agent.getHeadRuns(v.parse(LimitSchema, args[0]));
    case 'getGepaRuns': return agent.getGepaRuns(v.parse(LimitSchema, args[0]));
    case 'getExecutors': return agent.getExecutors();
    default: return Promise.reject(new Error(`the fixture route serves no ${method}`));
  }
}

let server: ReturnType<typeof Bun.serve> | undefined;

const home = scratchDir('inspect-cli-home');

beforeAll(() => {
  const { agent, db } = orchestratorHarness();

  eventsOver(db).publish({ descriptor: {
    ingress: 'chat_ws', variant: 'chat', payload: { text: 'a row to render' },
    operator_user_id: 'harness-owner', session_id: 'harness-session',
  }, now: 1_700_000_000_000 });

  server = Bun.serve({
    port: 0,
    fetch: async (request) => {
      const { method, args } = v.parse(RpcSchema, await request.json());

      return Response.json({ result: await answer(agent, method, args) });
    },
  });
});

afterAll(async () => { await server?.stop(true); });

function kinu(...args: string[]) {
  return runToExit([process.execPath, CLI, ...args], {
    cwd: scratchDir('inspect-cli-project'),
    env: { ...process.env, KINU_HOME: home, KINU_TOKEN: 'ptc_test', KINU_ORIGIN: `http://localhost:${String(server?.port)}` },
  });
}

describe('kinu inspecting a populated cloud workspace', () => {
  test('every list command prints the rows the orchestrator answers', async () => {
    for (const command of ['events', 'timeline', 'heads', 'gepa', 'executors']) {
      const run = await kinu(command, 'cloudtest');

      expect([command, run.exitCode, run.stderr]).toEqual([command, 0, '']);
    }

    expect((await kinu('events', 'cloudtest')).stdout).toContain('chat chat_ws');
  });

  test('an event row reaches the CLI without the fields that stay inside the workspace', async () => {
    const run = await kinu('events', 'cloudtest', '--json');
    const rows = v.parse(v.array(EventRowSchema), JSON.parse(run.stdout));

    expect(rows.map((row) => [row.variant, row.ingress])).toEqual([['chat', 'chat_ws']]);
    expect(rows.filter((row) => 'dedupe_key' in row || 'reply_channel' in row)).toEqual([]);
  });
});
