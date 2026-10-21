/**
 * A long turn crosses its workspace binding no more as it goes on. Each call on the binding is a subrequest, and an agent's
 * isolate may make 10,000 of them while it stays busy, its turns and their steps alike (platform catalog
 * `do.facet.subrequests`, FACET-SUBREQUEST-LIMIT-1017). A call on what the binding answered costs none.
 *
 * Two shapes ran out:
 * - Every step used to start the turn again, so compaction forgot the screenshots it had moved out. It stored each one
 *   again at every step, a stat and a whole read: staging's Minecraft turns of 104-154 steps ran out (rc16, 2026-10-17;
 *   one trial's turn made 9,224 workspace calls, 8,461 of them those stats and reads).
 * - Every file operation of the agent's own (a screenshot moved out, a spill) opened a session of its own, one
 *   subrequest each. The agent now holds its sessions while it works, as it holds its port.
 *
 * The suite counts calls on the binding alone; each step's model call is one more subrequest, so a step costs about one.
 */
import { expect, test } from 'bun:test';
import { screenshot } from '../../compaction/tests/helpers';
import { workspaceCrossings } from './helpers/agent-facets';
import { driveUntil, gatewayWorkspace, wakeForDelegatedTask } from './helpers/actor-harness';
import { chatCompletion, requestOf, stubAiBinding, toolCallCompletion, type RecordedGatewayRun } from './helpers/platform-gateway';
import { TEST_CREDENTIAL_ENCRYPTION_KEY } from './helpers/user-do';

const STEPS = 24;

const LOOK = `Look at the screen ${String(STEPS)} times, then tell me what changed.`;

const NOTES = `Write ${String(STEPS)} notes, one file each, then tell me you are done.`;

/** What the agent's model does at each step of the turn asked `task`: given how many calls it has made, a call, or its
 *  answer once it made {@link STEPS}. */
type Step = (run: RecordedGatewayRun, made: number) => Response;

/** A hired agent running the turn `task` asks, step by step as `step` answers; the binding calls it had made as each of
 *  the turn's requests left. A step's are those between its request and the next. */
async function longTurn(task: string, step: Step) {
  const counted: number[] = [];
  const released: string[] = [];
  let actor = '';
  let shown = 0;
  let answered = false;

  const gateway = stubAiBinding((run) => {
    const { messages, tools } = requestOf(run);

    if (tools.length === 0 || !JSON.stringify(messages).includes(task)) return chatCompletion(run, 'Noted.');
    counted.push(workspaceCrossings(actor));
    const made = messages.filter((message) => message.role === 'tool').length;

    answered = made >= STEPS;

    return step(run, made);
  });

  // Each look a screen of its own, as a game's moves change it.
  const box = {
    resolveReadiness: async () => ({ kind: 'restored' as const }),
    configureEgress: async () => {},
    restoreStatus: async () => ({ restoring: false, refused: undefined }),
    getExposedPorts: async () => [],
    portListeners: async () => [],
    desktop: async () => {
      shown += 1;

      return { kind: 'screen' as const, png: screenshot(shown), width: 1280, height: 800 };
    },
    releaseDesktop: async (driver: string) => { released.push(driver); },
  };

  const workspace = gatewayWorkspace(gateway, { container: true, box: () => box });
  workspace.agent.harnessDeclareEnv({ CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY });
  await workspace.agent.setSoul('# Purpose\n\nDo what you are asked.');
  const { name } = await workspace.agent.createSubagentAgent();
  const route = await workspace.agent.resolveHostedActorRoute(name);

  if ('reason' in route) throw new Error(route.error);
  actor = route.actorId;

  await wakeForDelegatedTask(workspace, actor, task);
  await driveUntil(workspace, 'the long turn never answered', () => answered);
  await workspace.agent.harnessAgentsIdle();

  return { steps: counted.slice(1).map((at, index) => at - (counted[index] ?? 0)), shown, released, actor };
}

const total = (steps: readonly number[]): number => steps.reduce((sum, step) => sum + step, 0);

test('a long computer-use turn opens its file plane once: the screenshots it moves out cross on the session it holds', async () => {
  const { steps, shown } = await longTurn(LOOK, (run, made) => (made < STEPS
    ? toolCallCompletion(run, { tool: 'eval', args: { code: 'return await computer.screenshot();' } }, `call_look_${String(made)}`)
    : chatCompletion(run, 'It changed at every look.')));

  expect({ looks: shown, steps: steps.length }).toEqual({ looks: STEPS, steps: STEPS });
  // Twenty of its screenshots move out, four at a time, a stat, a directory and a write each. A session opened for
  // each made 61 calls on the binding; the one held makes a single call, opening it as the first four move.
  expect(total(steps)).toBe(1);
});

test("a long file-editing turn's steps make no call on the workspace binding: its file tool runs in the workspace", async () => {
  const { steps } = await longTurn(NOTES, (run, made) => (made < STEPS
    ? toolCallCompletion(run, { tool: 'file', args: { op: 'write', path: `notes/note-${String(made)}.md`, content: `Note ${String(made)}.\n` } }, `call_note_${String(made)}`)
    : chatCompletion(run, 'Done.')));

  expect({ steps: steps.length, calls: total(steps) }).toEqual({ steps: STEPS, calls: 0 });
});
