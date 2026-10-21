/**
 * Devbox D89: an agent holds the computer's desktop for its turns, however long it thinks between looks. The workspace
 * lets it go on the box once the agent's turn ends; a turn that never touched the desktop calls no box (D56).
 */
import { expect, test } from 'bun:test';
import { driveUntil, gatewayWorkspace, wakeForDelegatedTask } from './helpers/actor-harness';
import { chatCompletion, requestOf, stubAiBinding, toolCallCompletion, type RecordedGatewayRun } from './helpers/platform-gateway';
import { TEST_CREDENTIAL_ENCRYPTION_KEY } from './helpers/user-do';

const LOOK = 'Look at the screen and tell me what is on it.';

/** A PNG's signature: what the box answers a look with, as base64. */
const PNG = 'iVBORw0KGgo=';

/** The latest thing the agent was asked, without the runtime state blocks the turn adds. */
const latest = (run: RecordedGatewayRun): string => JSON.stringify(requestOf(run).messages
  .filter((message) => message.role === 'user' && !JSON.stringify(message.content).includes('<dynamic_context')).at(-1)?.content ?? '');

const answered = (run: RecordedGatewayRun): boolean => requestOf(run).messages.some((message) => message.role === 'tool');

/** A hired agent whose model looks at the screen with eval when asked to, over a box that records its desktop. */
async function hired() {
  const gateway = stubAiBinding((run) => {
    if (!latest(run).includes(LOOK)) return chatCompletion(run, 'Noted.');

    return answered(run)
      ? chatCompletion(run, 'The desktop is showing.')
      : toolCallCompletion(run, { tool: 'eval', args: { code: 'return await computer.screenshot();' } }, 'call_look');
  });

  const calls: string[] = [];

  const box = {
    resolveReadiness: async () => ({ kind: 'restored' as const }),
    configureEgress: async () => {},
    restoreStatus: async () => ({ restoring: false, refused: undefined }),
    getExposedPorts: async () => [],
    portListeners: async () => [],
    desktop: async (request: { readonly driver: string }) => {
      calls.push(`desktop ${request.driver}`);

      return { kind: 'screen' as const, png: PNG, width: 1280, height: 768 };
    },
    releaseDesktop: async (driver: string) => { calls.push(`release ${driver}`); },
  };

  const workspace = gatewayWorkspace(gateway, { container: true, box: () => box });
  // The owner's egress vault is read before the box is used.
  workspace.agent.harnessDeclareEnv({ CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY });
  await workspace.agent.setSoul('# Purpose\n\nWatch the desktop.');
  const { name } = await workspace.agent.createSubagentAgent();
  const route = await workspace.agent.resolveHostedActorRoute(name);

  if ('reason' in route) throw new Error(route.error);

  return { workspace, gateway, calls, actorId: route.actorId };
}

test("an agent's turn that never touched the desktop asks no box; one that looked lets the desktop go once it ends", async () => {
  const { workspace, gateway, calls, actorId } = await hired();

  await wakeForDelegatedTask(workspace, actorId, 'Say hello.');
  await driveUntil(workspace, "the hire's first turn never ran", () => gateway.runs.some((run) => latest(run).includes('Say hello.')));

  // Its next turn looks: what the box was asked is that turn's look and its release, and nothing of the first.
  await wakeForDelegatedTask(workspace, actorId, LOOK);
  await driveUntil(workspace, "the hire's look never let the desktop go", () => calls.includes(`release ${actorId}`));

  expect(calls).toEqual([`desktop ${actorId}`, `release ${actorId}`]);
});
