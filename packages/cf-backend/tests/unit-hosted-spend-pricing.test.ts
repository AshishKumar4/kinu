/**
 * A hire runs on its role's tier, and its spend is priced at that model's rate. Every model call is the platform
 * gateway's, each one token in and one token out.
 */
import { expect, test } from 'bun:test';
import * as v from 'valibot';
import { agentSql, catalogTurn, gatewayWorkspace, workspaceMainActor } from './helpers/actor-harness';
import {
  GATEWAY_MODEL, chatCompletion, requestOf, stubAiBinding, toolCallCompletion, type RecordedGatewayRun,
} from './helpers/platform-gateway';
import { joinHarnessFibers } from './helpers/agents-sdk';

const FAST_MODEL = 'ai-gateway/workers-ai/@cf/harness/fast';

const MISSION = 'List the parser\'s hot paths.';

/** A token costs $10 on the root's model and $1 on the fast tier's. */
const CATALOG = {
  [GATEWAY_MODEL]: { cost: { input: 10_000_000, output: 10_000_000 } },
  [FAST_MODEL]: { cost: { input: 1_000_000, output: 1_000_000 } },
};

const QueryModelSchema = v.looseObject({ model: v.string() });

const StepSpendSchema = v.looseObject({ usd: v.optional(v.number()) });

function onTheFastTier(run: RecordedGatewayRun): boolean {
  return FAST_MODEL.endsWith(v.parse(QueryModelSchema, run.query).model);
}

test('a researcher hire\'s steps are priced at its fast tier\'s rate, not the root\'s', async () => {
  const gateway = stubAiBinding((run) => {
    if (onTheFastTier(run)) return chatCompletion(run, 'The tokenizer and the symbol table.');
    const step = requestOf(run).messages.filter((message) => message.role === 'tool').length;

    return step === 0
      ? toolCallCompletion(run, { tool: 'agents', args: { action: 'hire', role: 'researcher', agent: 'profiler', mission: MISSION } }, 'hire_0')
      : chatCompletion(run, 'Handed off.');
  });

  const workspace = gatewayWorkspace(gateway);

  workspace.agent.harnessInstallCatalog({
    tiers: { default: { model: GATEWAY_MODEL }, deep: { model: GATEWAY_MODEL }, fast: { model: FAST_MODEL } },
    availableModels: [GATEWAY_MODEL, FAST_MODEL],
  });

  workspace.agent.harnessCatalogModels(CATALOG);
  await catalogTurn(workspace.agent, 'Have a researcher profile the parser.');
  await workspace.agent.terminalRetryPass();
  await joinHarnessFibers();

  const root = workspaceMainActor(workspace.db);

  const hire = workspace.db.query<{ actor_id: string }, []>("SELECT actor_id FROM workspace_actors WHERE origin = 'agent'").get();

  if (hire === null) throw new Error('the root hired no one');

  // The root's steps are in the workspace's ledger; the hire's in its own database.
  const priced = (mine: boolean) => (mine
    ? workspace.db.query<{ payload: string }, [string]>(
      "SELECT payload FROM run_events WHERE type = 'step_finish' AND actor_id = ? ORDER BY ts, event_index",
    ).all(root.actorId)
    : agentSql(hire.actor_id)<{ payload: string }>`
      SELECT payload FROM run_events WHERE type = 'step_finish' AND actor_id = ${hire.actor_id} ORDER BY ts, event_index`)
    .map((row) => v.parse(StepSpendSchema, JSON.parse(row.payload)).usd);

  expect(gateway.runs.some(onTheFastTier)).toBe(true);
  // The hire's one step: a token each way at $1.
  expect(priced(false)).toEqual([2]);
  // The root's two steps, at its own model's $10.
  expect(priced(true)).toEqual([20, 20]);
});

for (const kind of ['hire', 'swarm'] as const) {
  test("the agents panel reads a scripted " + kind + "'s cost and cache from its own facet", async () => {
    const gateway = stubAiBinding((run) => {
      const request = requestOf(run);
      const child = request.tools.includes('report');
      const step = request.messages.filter((message) => message.role === 'tool').length;

      if (!child) return step === 0
        ? toolCallCompletion(run, { tool: 'agents', args: kind === 'hire'
          ? { action: 'hire', role: 'researcher', agent: 'counter', mission: 'Count the parser paths.' }
          : { action: 'swarm', preset: 'ideate', task: 'Count the parser paths.', branches: 1, depth: 1 } }, 'start')
        : chatCompletion(run, 'Handed off.');

      const usage = step === 0
        ? { prompt_tokens: 1000, completion_tokens: 200, total_tokens: 1200, prompt_tokens_details: { cached_tokens: 0 } }
        : { prompt_tokens: 2000, completion_tokens: 100, total_tokens: 2100, prompt_tokens_details: { cached_tokens: 1800 } };

      const delta = step === 0
        ? { tool_calls: [{ index: 0, id: 'inspect', type: 'function', function: { name: 'tasks', arguments: '{"action":"list"}' } }] }
        : { content: 'Counted.' };

      const frames = [
        { id: 'counted', model: 'harness', choices: [{ index: 0, delta, finish_reason: null }] },
        { id: 'counted', model: 'harness', choices: [{ index: 0, delta: {}, finish_reason: step === 0 ? 'tool_calls' : 'stop' }], usage },
      ];

      return new Response(frames.map((frame) => 'data: ' + JSON.stringify(frame) + '\n\n').join('') + 'data: [DONE]\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      });
    });

    const workspace = gatewayWorkspace(gateway);
    workspace.agent.harnessCatalogModels({ [GATEWAY_MODEL]: { cost: { input: 2, output: 3, cacheRead: 0.5 } } });
    await workspace.agent.setSoul('# Purpose\n\nCount the parser paths.');
    await catalogTurn(workspace.agent, 'Delegate counting the parser paths.');
    await workspace.agent.terminalRetryPass();
    await joinHarnessFibers();

    const listed = await workspace.agent.listWorkspaceAgents();
    const worker = listed.find((agent) => agent.category === (kind === 'hire' ? 'hired' : 'swarm'));

    expect(worker?.figures.tokens).toBe(3300);
    expect(worker?.figures.usd).toBeCloseTo(0.0042, 10);
    expect(worker?.figures.cacheEma).toBeCloseTo(0.18, 10);
  });
}
