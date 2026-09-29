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
