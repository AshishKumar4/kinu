// D83: a box reaches the golden and its siblings through its own namespace, found among the Worker's exports as the
// one namespace that accepts the box's id, whatever the export is named. Nothing else in `ctx` names it.
import { expect, test } from 'bun:test';
import { TestDevbox } from './support/test-devbox';
import {
  FakeSandbox, READY_GOLDEN, TEST_BOX_ID, boxState, fakeStorage, memoryBucket, seedGolden, testNamespace, type TestSiblings,
} from './support/devbox-harness';
import { devboxFailure } from '../src/errors';

/** An entrypoint's loopback stub: its tag is the platform's, and any other member it is asked for is an RPC. */
const entrypointStub = new Proxy<object>({}, {
  get: (_target, key) => {
    if (key === Symbol.toStringTag) return 'LoopbackServiceStub';

    throw new Error(`an entrypoint was asked for ${String(key)}`);
  },
});

const gateway = () => ({ fetch: async () => new Response(null, { status: 502 }), connect: () => { throw new Error('no TCP'); } });

/** A golden that records which box asked. */
function recordingGolden(asked: string[]): TestSiblings {
  return {
    ...READY_GOLDEN,
    goldenFor: async (box, lost) => {
      asked.push(box);

      return await READY_GOLDEN.goldenFor(box, lost);
    },
  };
}

/** The Worker's exports these tests name: the gateway, an entrypoint, a foreign namespace, and the box's own. */
interface NamedExports {
  readonly DevboxGateway: typeof gateway;
  readonly Api?: typeof entrypointStub;
  readonly Other: ReturnType<typeof testNamespace>;
  readonly Renamed?: ReturnType<typeof testNamespace>;
}

function boxWith(exports: NamedExports) {
  const state = boxState({ storage: fakeStorage().handle, id: TEST_BOX_ID, blockConcurrencyWhile: (closure) => closure(), exports });
  const container = new FakeSandbox(state);
  container.running.running = false;
  state.container = container.handle();
  seedGolden(container);
  const box = new TestDevbox(state, { DEVBOX_STORE: memoryBucket(new Map()) });
  container.owner = box;

  return { box, container };
}

test('a box finds its namespace under any export name, past an entrypoint and a namespace that refuses its id', async () => {
  const asked: string[] = [];
  const refusing: string[] = [];

  const { box, container } = boxWith({
    DevboxGateway: gateway,
    Api: entrypointStub,
    Other: testNamespace(recordingGolden(refusing), () => false),
    Renamed: testNamespace(recordingGolden(asked)),
  });

  expect({ ready: await box.resolveReadiness(), asked, refusing, starts: container.startOptions.length })
    .toEqual({ ready: { kind: 'restored' }, asked: [TEST_BOX_ID], refusing: [], starts: 1 });
  await box.destroy();
});

test('a box whose namespace no export accepts is refused once, naming the export to add', async () => {
  const { box, container } = boxWith({ DevboxGateway: gateway, Other: testNamespace(READY_GOLDEN, () => false) });
  const [refused] = await Promise.allSettled([box.resolveReadiness()]);
  const failure = refused.status === 'rejected' ? devboxFailure({ cause: refused.reason }) : undefined;

  expect({ code: failure?.code, reported: (await box.boxSize()).startRefused, starts: container.startOptions.length }).toEqual({
    code: 'refused',
    reported: expect.stringContaining('no Durable Object namespace among the Worker\'s exports accepts this box\'s id'),
    starts: 0,
  });
  await box.destroy();
});
