// D85: a box reaches the golden and its siblings through its own namespace, found among the Worker's exports as the
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

function boxWith(exports: NamedExports, Box: new (...args: ConstructorParameters<typeof TestDevbox>) => TestDevbox = TestDevbox) {
  const state = boxState({ storage: fakeStorage().handle, id: TEST_BOX_ID, blockConcurrencyWhile: (closure) => closure(), exports });
  const container = new FakeSandbox(state);
  container.running.running = false;
  state.container = container.handle();
  seedGolden(container);
  const box = new Box(state, { DEVBOX_STORE: memoryBucket(new Map()) });
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

// The contracts fixture is deployed again for every run under one Worker, and a box of the version before still
// answered after a deploy (staging 8556f3506, 2026-10-23): its golden, under the one name every run shared, answered from
// a run whose bucket was gone. A class that names its own golden is asked of that one alone.
test('a box whose class names its own golden asks that one', async () => {
  const named: string[] = [];
  const asked: string[] = [];
  const own = testNamespace(recordingGolden(asked));

  const getByName = (name: string) => {
    named.push(name);

    return own.getByName('devbox-golden');
  };

  const { box, container } = boxWith({
    DevboxGateway: gateway,
    Other: testNamespace(READY_GOLDEN, () => false),
    Renamed: { ...own, getByName },
  }, class extends TestDevbox {
    protected override get goldenName(): string { return 'eval-devbox-run-1-golden'; }
  });

  expect({ ready: await box.resolveReadiness(), named, asked, starts: container.startOptions.length })
    .toEqual({ ready: { kind: 'restored' }, named: ['eval-devbox-run-1-golden'], asked: [TEST_BOX_ID], starts: 1 });
  await box.destroy();
});
