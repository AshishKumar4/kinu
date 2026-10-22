// FEAT-2 step 1 (docs/HARNESS-PROFILES.md): `harness.mode` is the workspace's, and every step of every actor records
// the surface it resolved, beside its usage. Review finding (2026-10-22): a hire's steps, in its own isolate, read its
// own config, which never holds the workspace's mode, so they recorded native.
import { expect, test } from 'bun:test';
import * as v from 'valibot';
import { agentSql, catalogTurn, gatewayWorkspace, mainDatabase, workspaceMainActor } from './helpers/actor-harness';
import { chatCompletion, requestOf, stubAiBinding, toolCallCompletion } from './helpers/platform-gateway';
import { joinHarnessFibers } from './helpers/agents-sdk';

const StepHarnessSchema = v.looseObject({ harness: v.optional(v.object({ mode: v.string(), surface: v.string() })) });

test("a hire's steps in its own isolate and the root's record the workspace's harness mode", async () => {
  const gateway = stubAiBinding((run) => {
    const request = requestOf(run);

    if (request.tools.includes('report')) return chatCompletion(run, 'The tokenizer and the symbol table.');

    return request.messages.some((message) => message.role === 'tool')
      ? chatCompletion(run, 'Handed off.')
      : toolCallCompletion(run, { tool: 'agents', args: { op: 'hire', role: 'researcher', name: 'profiler', message: 'Profile the parser.' } }, 'hire_0');
  });

  const workspace = gatewayWorkspace(gateway);

  workspaceMainActor(workspace.db).config.setHarnessMode('pi');
  await catalogTurn(workspace.agent, 'Have a researcher profile the parser.');
  await workspace.agent.terminalRetryPass();
  await joinHarnessFibers();
  const root = workspaceMainActor(workspace.db).actorId;
  const hire = workspace.db.query<{ actor_id: string }, []>("SELECT actor_id FROM workspace_actors WHERE origin = 'agent'").get();

  if (hire === null) throw new Error('the root hired no one');
  const harness = (payloads: readonly { payload: string }[]) => payloads.map((row) => v.parse(StepHarnessSchema, JSON.parse(row.payload)).harness);
  const pi = { mode: 'pi', surface: 'pi' };

  expect({
    root: harness(mainDatabase(workspace).query<{ payload: string }, [string]>(
      "SELECT payload FROM run_events WHERE type = 'step_finish' AND actor_id = ? ORDER BY ts, event_index",
    ).all(root)),
    hire: harness(agentSql(workspace, hire.actor_id)<{ payload: string }>`
      SELECT payload FROM run_events WHERE type = 'step_finish' AND actor_id = ${hire.actor_id} ORDER BY ts, event_index`),
  }).toEqual({ root: [pi, pi], hire: [pi] });
});
