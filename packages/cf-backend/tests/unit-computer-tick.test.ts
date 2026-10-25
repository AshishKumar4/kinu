/**
 * A running computer's minutes, as its heartbeat counts them to its owner's month, with the box object evicted between
 * beats as the platform evicts it. Production, 2026-10-25: quiet-cove-f8c76035's box beat once a minute from 20:45 to
 * 22:30Z, and each beat started a new activation of the workspace (105 by 22:30Z): the beat's running tick went to the
 * owner through the workspace, and each fresh box object, adopting its running container, asked the workspace for its
 * title again.
 */
import { afterEach, expect, setSystemTime, test } from 'bun:test';
import type { Devbox } from '@kinu.run/devbox';
import { harness, type Harness, type TestEnv } from '../../devbox/tests/support/devbox-harness';
import { KinuDevbox } from '../src/kinu-devbox';
import { TEST_CREDENTIAL_ENCRYPTION_KEY } from './helpers/user-do';

const WORKSPACE = 'quiet-cove-f8c76035';

const OWNER = '0123456789abcdef0123456789abcdef';

afterEach(() => { setSystemTime(); });

/** What the platform hands a box object: its state. */
type BoxState = ConstructorParameters<typeof Devbox>[0];

/** What a recorded call is answered: the workspace's two answers a box reads, else nothing. */
type Answer = { readonly size: string } | string | undefined;

/** A namespace whose every stub records each method asked of it, by object name, with its arguments, and answers
 *  `answer(method)`. */
function recordingNamespace(asked: string[], answer: (method: string, args: readonly string[]) => Answer) {
  return {
    idFromName: (name: string) => name,
    get: (name: string) => new Proxy({}, {
      get: (_target, method) => (method === 'then' ? undefined : async (...args: readonly string[]) => {
        asked.push(`${name}.${String(method)}`);

        return answer(String(method), args);
      }),
    }),
  };
}

/** The workspace's answers a box reads: the size its start runs at, and its title. */
function workspaceAnswer(method: string): Answer {
  if (method === 'computerStartAdmitted') return { size: 'medium' };

  return method === 'workspaceTitle' ? 'Quiet cove' : undefined;
}

/** The platform's alarm, `minutes` times, each to a fresh object over the same storage and container. */
async function beatEvicted(made: Harness<KinuDevbox>, Box: new (state: BoxState, env: TestEnv) => KinuDevbox, minutes: number): Promise<number> {
  let beats = 0;

  while (beats < minutes && made.container.alarmAt !== null) {
    made.container.owner = new Box(made.state, made.env);
    setSystemTime(new Date(Math.max(made.container.alarmAt, Date.now())));
    await made.container.alarm();
    beats += 1;
  }

  return beats;
}

test('a computer running ten idle minutes counts each to its owner and wakes its workspace not once', async () => {
  const workspace: string[] = [];
  const owner: string[] = [];
  const ticked: (readonly string[])[] = [];

  const env = {
    CREDENTIAL_ENCRYPTION_KEY: TEST_CREDENTIAL_ENCRYPTION_KEY,
    OrchestratorAgent: recordingNamespace(workspace, workspaceAnswer),
    UserDO: recordingNamespace(owner, (method, args) => {
      if (method === 'limits_computerTick') ticked.push(args.slice(1));

      return method === 'limits_admitComputerStart' ? args[2] : undefined;
    }),
  };

  class MeteredBox extends KinuDevbox {
    constructor(state: BoxState, harnessEnv: TestEnv) {
      const fetcher = () => ({ fetch: async () => new Response(null, { status: 204 }), connect: () => { throw new Error('no TCP here'); } });

      super(Object.assign(Object.create(state), { exports: Object.assign(Object.create(null), state.exports, { KinuEgress: fetcher, KinuEvents: fetcher }) }),
        Object.assign(Object.create(null), env, { BACKUP_BUCKET: harnessEnv.DEVBOX_STORE }));
    }

    // Only the heartbeat's own beats here: an idle box's checkpoint tick is another clock, which no beat moves.
    protected override get ambientCheckpoints(): boolean { return false; }
  }

  const made = harness(MeteredBox);

  // The runtime configures the box as the workspace first uses it, and the use starts it.
  await made.box.configureEgress({ workspaceName: WORKSPACE, ownerUserId: OWNER });
  await made.box.devboxStartup();
  workspace.length = 0;

  const beats = await beatEvicted(made, MeteredBox, 10);

  expect({ beats, workspace, ticks: ticked.length, of: ticked.at(-1) }).toEqual({ beats: 10, workspace: [], ticks: 10, of: [WORKSPACE, 'medium'] });
});
