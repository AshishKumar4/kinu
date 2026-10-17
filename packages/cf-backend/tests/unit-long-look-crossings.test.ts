/**
 * A long computer-use turn crosses into its workspace no more often at its last steps than at its first: each crossing
 * is an RPC, which the agent's isolate counts against its invocation's subrequests. Every step used to start the turn
 * again, so compaction forgot the screenshots it had moved out and stored each again at every step, a session opened
 * for a stat and another for a whole read: staging's Minecraft turns of 104-154 steps ran out of subrequests (rc16,
 * 2026-10-17, 9,224 workspace calls in one trial's turn, 8,461 of them those stats and reads).
 */
import { expect, test } from 'bun:test';
import { screenshot } from '../../compaction/tests/helpers';
import { workspaceCrossings } from './helpers/agent-facets';
import { driveUntil, gatewayWorkspace, wakeForDelegatedTask } from './helpers/actor-harness';
import { chatCompletion, requestOf, stubAiBinding, toolCallCompletion } from './helpers/platform-gateway';
import { TEST_CREDENTIAL_ENCRYPTION_KEY } from './helpers/user-do';

const LOOKS = 24;

const LOOK = `Look at the screen ${String(LOOKS)} times, then tell me what changed.`;

test("a long computer-use turn's steps cross into the workspace no more often as its screenshots pile up", async () => {
  // The agent's crossings as each request of its turn left: a step's are those between its request and the next.
  const counted: number[] = [];
  const released: string[] = [];
  let actor = '';
  let shown = 0;

  const gateway = stubAiBinding((run) => {
    const { messages, tools } = requestOf(run);

    if (tools.length === 0 || !JSON.stringify(messages).includes(LOOK)) return chatCompletion(run, 'Noted.');
    counted.push(workspaceCrossings(actor));
    const looked = messages.filter((message) => message.role === 'tool').length;

    return looked < LOOKS
      ? toolCallCompletion(run, { tool: 'eval', args: { code: 'return await computer.screenshot();' } }, `call_look_${String(looked)}`)
      : chatCompletion(run, 'It changed at every look.');
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
  await workspace.agent.setSoul('# Purpose\n\nWatch the desktop.');
  const { name } = await workspace.agent.createSubordinateAgent();
  const route = await workspace.agent.resolveHostedActorRoute(name);

  if ('reason' in route) throw new Error(route.error);
  actor = route.actorId;

  await wakeForDelegatedTask(workspace, actor, LOOK);
  await driveUntil(workspace, 'the long look never let the desktop go', () => released.includes(actor));

  const steps = counted.slice(1).map((at, step) => at - (counted[step] ?? 0));

  expect({ looks: shown, steps: steps.length }).toEqual({ looks: LOOKS, steps: LOOKS });
  // Each fourth step moves four older screenshots out, so each window holds such a step: the later's busiest is no
  // busier than the earlier's, however many screenshots the turn has moved by then.
  expect(Math.max(...steps.slice(LOOKS - 8))).toBeLessThanOrEqual(Math.max(...steps.slice(1, 12)));
});
