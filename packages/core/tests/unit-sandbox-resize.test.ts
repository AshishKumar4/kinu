// `sandbox.resize` as the model meets it (DEVBOX-DECISIONS D50): the declaration and the prompt line generated from
// the host's size table, and each answer the tool gives, through the real executor, router and prompt renderer.
import { describe, expect, test } from 'bun:test';
import { createSandboxExecutor, type SandboxHandle, type SandboxResize } from '../src/execution/sandbox';
import { DefaultExecutionRouter } from '../src/execution/router';
import type { ExecutorProvider, SandboxSizes } from '../src/execution/types';
import { buildSystemPromptSync } from '../src/index';
import { createTestRuntime } from '@kinu.run/test-utils';
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

describe('the declaration the model reads', () => {
  test('names each size from the table, and none of the retired figures', () => {
    const { types } = createSandboxExecutor(boxAnswering(async (size) => ({ kind: 'recorded', size })), { sizes: SIZES });

    expect(types).toContain('/** small: 1 vCPU, 4 GiB; medium: 2 vCPU, 8 GiB; large: 4 vCPU, 12 GiB. A running sandbox restarts at the new size');
    expect(types).toContain("function resize(size: 'small' | 'medium' | 'large'): Promise<string | Refusal>;");
    expect(types).not.toContain('6 GB');
    expect(types).not.toContain('10 instances');
  });

  test('declares no resize where the host names no sizes', () => {
    expect(createSandboxExecutor(boxAnswering(async (size) => ({ kind: 'recorded', size }))).types).not.toContain('resize');
  });

  test('the prompt line names the default and every choice, and only where a sandbox is sized', () => {
    const router = new DefaultExecutionRouter();
    router.register(createSandboxExecutor(boxAnswering(async (size) => ({ kind: 'recorded', size })), { sizes: SIZES }));
    const { rt } = createTestRuntime();
    const sized = buildSystemPromptSync(rt, { backend: 'cf', executors: router.listExecutors() });

    expect(sized).toContain('It starts at Medium unless the user chose another size; `sandbox.resize(size)` switches between '
      + 'Small (1 vCPU, 4 GiB), Medium (2 vCPU, 8 GiB) and Large (4 vCPU, 12 GiB), restarting a running container.');

    const unsized = new DefaultExecutionRouter();
    unsized.register(createSandboxExecutor(boxAnswering(async (size) => ({ kind: 'recorded', size }))));

    expect(buildSystemPromptSync(rt, { backend: 'cf', executors: unsized.listExecutors() })).not.toContain('sandbox.resize');
  });
});

describe('what sandbox.resize answers', () => {
  const CASES: ReadonlyArray<{ name: string; answer: SandboxResize; says: string }> = [
    { name: 'a sandbox that is not running only records the size', answer: { kind: 'recorded', size: 'large' },
      says: 'The sandbox is not running; it starts at Large (4 vCPU, 12 GiB).' },
    { name: 'a sandbox already at the size is left alone', answer: { kind: 'unchanged', size: 'large' },
      says: 'The sandbox already runs at Large (4 vCPU, 12 GiB).' },
    { name: 'a running sandbox restarts, and the answer says what ended', answer: { kind: 'restarted', size: 'large', previous: 'medium', endedCommands: 1 },
      says: 'The sandbox restarted at Large (4 vCPU, 12 GiB), from Medium (2 vCPU, 8 GiB). '
        + 'Files are kept, and supervised servers and exposed ports came back; 1 running command ended.' },
  ];

  for (const { name, answer, says } of CASES) {
    test(name, async () => {
      const box = boxAnswering(async () => answer);

      expect({ answered: await resize(createSandboxExecutor(box, { sizes: SIZES }), 'large'), asked: box.asked })
        .toEqual({ answered: says, asked: ['large'] });
    });
  }

  test('a restart whose final checkpoint failed is refused, naming the size it kept', async () => {
    const box = boxAnswering(async () => ({ kind: 'failed', size: 'large', previous: 'medium', reason: 'the store refused the write' }));
    expect(await resize(createSandboxExecutor(box, { sizes: SIZES }), 'large')).toMatchObject({
      reason: 'io',
      error: expect.stringContaining('The sandbox still runs at Medium (2 vCPU, 8 GiB): its final checkpoint failed (the store refused the write). '
        + 'It starts at Large (4 vCPU, 12 GiB) next time.'),
    });
  });

  test('a size the table does not name is refused before the container is asked', async () => {
    const box = boxAnswering(async (size) => ({ kind: 'recorded', size }));
    const refused = await resize(createSandboxExecutor(box, { sizes: SIZES }), 'huge');

    expect({ refused, asked: box.asked }).toMatchObject({
      refused: { reason: 'bad_input', error: expect.stringContaining('sandbox resize: size must be one of small, medium, large') },
      asked: [],
    });
  });

  test('without a container the refusal says so, and without a table there is no resize to call', async () => {
    const unbound = await resize(createSandboxExecutor(undefined, { sizes: SIZES }), 'large');
    const unsized = createSandboxExecutor(boxAnswering(async (size) => ({ kind: 'recorded', size })));

    expect({ unbound, unsized: Object.keys(unsized.tools).includes('resize') }).toMatchObject({ unbound: { reason: 'unavailable' }, unsized: false });
  });
});
