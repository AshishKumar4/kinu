/**
 * An added agent names itself on its own models, in its own isolate, so a refusal only the owner can fix (402: the
 * account has no funds) parks there as it does for every actor (AGENTS.md, 2026-09-30, T1-T3). It waits with no
 * wake: the workspace's lap and a reset of the agent's isolate ask nothing again. The owner's change to the model
 * settings releases it, and so does the agent's next settled turn.
 */
import { afterEach, expect, setSystemTime, test } from 'bun:test';
import * as v from 'valibot';
import { AgentWakes, RECOVERY_BACKOFF_CEILING_MS, WORKSPACE_TITLE_SYSTEM_PROMPT } from '@kinu.run/core';
import { sqlOver } from '@kinu.run/test-utils';
import { actorOver, gatewayWorkspace, runDelegatedTask, until, type StartedHarness } from './helpers/actor-harness';
import { agentDatabase } from './helpers/agent-facets';
import { chatCompletion, requestOf, stubAiBinding } from './helpers/platform-gateway';

afterEach(() => { setSystemTime(); });

const NO_FUNDS = { error: { message: 'Upstream request failed: Insufficient account funds', type: 'server_error' } };

interface ParkedTitle {
  readonly workspace: StartedHarness;
  readonly actorId: string;
  /** The title calls the gateway was asked, and whether the account can pay for them. */
  readonly titling: { asked: number; funded: boolean };
  readonly title: () => string[];
  readonly name: () => string | null;
}

/** An added agent's first task settles, and the title it then asks for is refused for funds. */
async function parkedTitle(): Promise<ParkedTitle> {
  const titling = { asked: 0, funded: false };

  const workspace = gatewayWorkspace(stubAiBinding((run) => {
    if (!JSON.stringify(requestOf(run).messages).includes(WORKSPACE_TITLE_SYSTEM_PROMPT)) return chatCompletion(run, 'Hello.');
    titling.asked += 1;

    return titling.funded ? chatCompletion(run, JSON.stringify({ title: 'Greeter' })) : Response.json(NO_FUNDS, { status: 402 });
  }));

  await workspace.agent.setSoul('# Purpose\n\nGreet whoever asks.');
  const { subordinate } = await workspace.agent.createSubordinateAgent();
  const actorId = v.parse(v.string(), subordinate.actorId);
  const ledger = agentDatabase(workspace.agent.agentOf(actorId).storageKey);

  const title = () => ledger.query<{ status: string }, []>(`SELECT status FROM terminal_effects WHERE effect_name = 'auto_title'`)
    .all().map((row) => row.status);

  await runDelegatedTask(workspace, actorId, 'Say hello.');
  await until(() => title().includes('parked'), "the agent's title parked");

  return { workspace, actorId, titling, title, name: () => actorOver(workspace.db, actorId).config.getDisplayName() };
}

/** The workspace's lap at `at`: it sends each agent whose wake is due the wake its isolate cannot set. */
async function lapAt(workspace: StartedHarness, at: number): Promise<void> {
  setSystemTime(new Date(Math.max(Date.now(), at) + 1));
  await workspace.agent.terminalRetryPass();
  await workspace.agent.harnessSettleDetached();
}

/** A wake sent the agent though it owes nothing: a lap, as a clock would send it. */
async function wakeAgent({ workspace, actorId }: ParkedTitle): Promise<void> {
  new AgentWakes(sqlOver(workspace.db)).arm(actorId, Date.now());
  await lapAt(workspace, Date.now() + RECOVERY_BACKOFF_CEILING_MS);
}

/** The lap the agent's own wake falls due on, once something armed it. */
async function lapAtArmedWake({ workspace, actorId }: ParkedTitle): Promise<void> {
  const armed = workspace.db.query<{ at: number }, [string]>('SELECT wake_at AS at FROM agent_wakes WHERE actor_id = ?').get(actorId);

  if (armed === null) throw new Error("nothing armed the agent's wake");
  await lapAt(workspace, armed.at);
}

test("an agent's refused title survives its lap wake and a reset isolate, and the owner's settings change releases it", async () => {
  const parked = await parkedTitle();
  const { workspace, actorId, titling, title, name } = parked;
  const asked = titling.asked;

  await wakeAgent(parked);
  workspace.agent.harnessResetAgentIsolate(workspace.agent.agentOf(actorId).storageKey);
  await wakeAgent(parked);
  expect({ asked: titling.asked, title: title() }).toEqual({ asked, title: ['parked'] });

  titling.funded = true;
  await workspace.agent.onModelSettingsChanged();
  await lapAtArmedWake(parked);
  await until(() => name() === 'Greeter', 'the released title landed');
  expect(title()).toEqual([]);
});

test("an agent's refused title is released by its next settled turn", async () => {
  const parked = await parkedTitle();
  const { workspace, actorId, titling, title, name } = parked;

  titling.funded = true;
  await runDelegatedTask(workspace, actorId, 'Say hello again.');
  await lapAtArmedWake(parked);
  await until(() => name() === 'Greeter', 'the released title landed');
  expect(title()).toEqual([]);
});
