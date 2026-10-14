/**
 * A program's `computer.screenshot()` is the screen in front of the model (D89): the eval tool's own result path puts
 * the returned image beside its text, as it does a web screenshot's, with no file and no copy between planes.
 */
import { expect, test } from 'bun:test';
import * as v from 'valibot';
import {
  WORKSPACE_ROOT, createSandboxExecutor, executorNamespace, gateProviderExec, narrowToolSurface, withClampedToolResult,
  type SandboxHandle,
} from '@kinu.run/core';
import { createTestRuntime, toolExecute } from '@kinu.run/test-utils';
import { createNodeCodemodeToolFactory } from '../src/codemode-tool-factory';

const PNG = 'iVBORw0KGgo=';

const unreachable = async (): Promise<never> => {
  throw new Error('a screenshot must not touch the computer any other way');
};

/** A computer whose box answers every look with the same screen. */
const box: SandboxHandle = {
  ensureReady: unreachable, exec: unreachable, readFile: unreachable, writeFile: unreachable, writeFileIfDigest: unreachable,
  listFiles: unreachable, statFile: unreachable, deleteFile: unreachable, exposePort: unreachable, unexposePort: unreachable,
  getExposedPorts: unreachable, startSupervisedProcess: unreachable, stopSupervisedProcess: unreachable,
  listSupervisedProcesses: unreachable, portToken: unreachable, probePort: unreachable, portListeners: unreachable,
  resize: unreachable, answerRest: unreachable, releaseDesktop: unreachable,
  desktop: async () => ({ kind: 'screen', png: PNG, width: 1280, height: 768 }),
};

test('a program that returns the screenshot hands the model the screen as an image part', async () => {
  const { rt } = createTestRuntime();
  const computer = executorNamespace(gateProviderExec(createSandboxExecutor(box, { desktop: { driver: 'main', screen: { width: 1280, height: 768, sheet: { percent: 50, columns: [1, 2, 2, 2, 4, 4, 4, 4] } } } }), { mode: () => 'strict' }));

  // As an actor's eval is built: the program runner, its result clamped with images (delegation/actor-tools.ts).
  const evalTool = withClampedToolResult(createNodeCodemodeToolFactory({ reach: narrowToolSurface(undefined), namespaces: [computer] })({
    cwd: WORKSPACE_ROOT, native: {}, external: () => ({}), craftedTools: () => [],
  }), { files: rt.storage, producer: 'eval', images: true });

  const output = await toolExecute<{ code: string }, unknown>(evalTool)({ code: 'return await computer.screenshot();' });

  expect(v.parse(v.object({ output: v.object({ result: v.unknown() }) }), output).output.result).toBe('[image 1]');
  expect(await evalTool.toModelOutput?.({ toolCallId: 'c1', input: { code: '' }, output })).toEqual({
    type: 'content',
    value: [
      { type: 'text', text: expect.stringContaining('[image 1]') },
      { type: 'file', data: { type: 'data', data: PNG }, mediaType: 'image/png' },
    ],
  });
});
