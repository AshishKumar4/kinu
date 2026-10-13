/**
 * A turn's answer and its close: main's isolate commits the answer with the roster it owes, then hands the settled turn
 * to the workspace (the prompt's warm asked beside it). An isolate that dies before the handoff is taken must leave the
 * turn answered for the next one: not run again, and settled through the roster its answer committed.
 */
import { expect, test } from 'bun:test';
import { driveUntil, gatewayWorkspace, mainDatabase, storedChat, workspaceMainActor } from './helpers/actor-harness';
import { delayNextHandoff } from './helpers/agent-facets';
import { chatCompletion, openingOf, stubAiBinding } from './helpers/platform-gateway';

const ASK = 'Summarize the release.';

test("an isolate that dies after the answer committed does not run the turn again, and settles it", async () => {
  let asked = 0;

  const workspace = gatewayWorkspace(stubAiBinding((run) => {
    if (openingOf(run).includes(ASK)) asked += 1;

    return chatCompletion(run, 'The release fixes the parser.');
  }));

  const main = workspaceMainActor(workspace.db).actorId;
  const { storageKey } = workspace.agent.agentOf(main);
  // The handoff main's isolate makes once its answer is committed.
  const handoff = delayNextHandoff(storageKey);
  // Sent, as the composer sends it: its turn runs in main's isolate.
  await workspace.agent.send(ASK, crypto.randomUUID(), []);

  await handoff.reached;
  const db = mainDatabase(workspace);
  const open = () => db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM actor_turn_claims WHERE outcome IS NULL').get()?.n ?? 0;
  const owed = () => db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM terminal_effects').get()?.n ?? 0;

  // The answer is committed, with the roster it owes.
  expect((await storedChat(workspace)).filter((message) => message.role === 'assistant')).toHaveLength(1);
  expect(owed()).toBeGreaterThan(0);

  // Main's isolate dies there, its held call never answered; the workspace's recovery wakes the next one.
  workspace.agent.harnessResetAgentIsolate(storageKey);
  await workspace.agent.recoverStrandedTurn();

  await driveUntil(workspace, "the answered turn's claim or roster stayed owed", () => open() === 0 && owed() === 0);
  await workspace.agent.harnessAgentsIdle();

  const answers = (await storedChat(workspace)).filter((message) => message.role === 'assistant');

  // Asked once, answered once, closed by its answer's own commit (no recovery settled it), and nothing of it left owed.
  expect(asked).toBe(1);
  expect(answers).toHaveLength(1);
  expect(db.query<{ outcome: string | null }, []>('SELECT outcome FROM actor_turn_claims').all().map((claim) => claim.outcome)).toEqual(['completed']);
  expect({ open: open(), owed: owed() }).toEqual({ open: 0, owed: 0 });
});
