// `sandbox.resize` as the model meets it (DEVBOX-DECISIONS D50): the declaration and the prompt line generated from
// the host's size table, and each answer the tool gives, through the real executor, router and prompt renderer.
import { describe, expect, test } from 'bun:test';
import { createSandboxExecutor, type SandboxHandle, type SandboxResize } from '../src/execution/sandbox';
import type { ExecutorProvider, SandboxSizes } from '../src/execution/types';
import { sandboxHandleLifecycle } from './helpers/sandbox-handle-lifecycle';

/** A table of the host's shape; its figures are the ones the model must read back. */
const SIZES: SandboxSizes = {
  sizes: [
    { size: 'small', label: 'Small', vcpu: 1, memoryMib: 4_096, diskMb: 20_000 },
    { size: 'medium', label: 'Medium', vcpu: 2, memoryMib: 8_192, diskMb: 20_000 },
    { size: 'large', label: 'Large', vcpu: 4, memoryMib: 12_288, diskMb: 20_000 },
  ],
  defaultSize: 'medium',
};

/** A container that answers resize as `answer` does and refuses everything else. */
function boxAnswering(answer: (size: string) => Promise<SandboxResize>): SandboxHandle & { readonly asked: string[] } {
  const asked: string[] = [];

  const unreachable = async (): Promise<never> => {
    throw new Error('a resize must not touch the container any other way');
  };

  return {
    exec: unreachable, readFile: unreachable, writeFile: unreachable,
    listFiles: unreachable, deleteFile: unreachable, exposePort: unreachable,
    unexposePort: unreachable, getExposedPorts: unreachable,
    ...sandboxHandleLifecycle,
    resize: async (size) => {
      asked.push(size);

      return await answer(size);
    },
    asked,
  };
}

/** `size` as the model's program passes it, which may name no size at all. */
async function resize(provider: ExecutorProvider, size: string): Promise<ReturnType<ExecutorProvider['tools'][string]['execute']>> {
  const tool = provider.tools['resize'];

  if (tool === undefined) throw new Error('the sandbox executor has no resize tool');

  return await tool.execute(size);
}

describe('what sandbox.resize answers', () => {
  const CASES: ReadonlyArray<{ name: string; answer: SandboxResize }> = [
    { name: 'a sandbox that is not running only records the size', answer: { kind: 'recorded', size: 'large' } },
    { name: 'a sandbox already at the size is left alone', answer: { kind: 'unchanged', size: 'large' } },
    { name: 'a running sandbox restarts, and the answer says what ended', answer: { kind: 'restarted', size: 'large', previous: 'medium', endedCommands: 1 } },
  ];

  for (const { name, answer } of CASES) {
    test(name, async () => {
      const box = boxAnswering(async () => answer);

      expect({ answered: await resize(createSandboxExecutor(box, { sizes: SIZES }), 'large'), asked: box.asked })
        .toEqual({ answered: expect.stringContaining('Large'), asked: ['large'] });
    });
  }

  test('a restart whose final checkpoint failed is refused, naming the size it kept', async () => {
    const box = boxAnswering(async () => ({ kind: 'failed', size: 'large', previous: 'medium', reason: 'the store refused the write' }));
    const refused = await resize(createSandboxExecutor(box, { sizes: SIZES }), 'large');
    expect(refused).toMatchObject({ reason: 'io', error: expect.stringContaining('the store refused the write') });
    expect(refused).toMatchObject({ error: expect.stringContaining('Medium') });
    expect(refused).toMatchObject({ error: expect.stringContaining('Large') });
  });

  test('a size the table does not name is refused before the container is asked', async () => {
    const box = boxAnswering(async (size) => ({ kind: 'recorded', size }));
    const refused = await resize(createSandboxExecutor(box, { sizes: SIZES }), 'huge');

    expect({ refused, asked: box.asked }).toMatchObject({
      refused: { reason: 'bad_input' },
      asked: [],
    });
  });

  test('without a container the refusal says so, and without a table there is no resize to call', async () => {
    const unbound = await resize(createSandboxExecutor(undefined, { sizes: SIZES }), 'large');
    const unsized = createSandboxExecutor(boxAnswering(async (size) => ({ kind: 'recorded', size })));

    expect({ unbound, unsized: Object.keys(unsized.tools).includes('resize') }).toMatchObject({ unbound: { reason: 'unavailable' }, unsized: false });
  });
});
