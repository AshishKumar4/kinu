/**
 * Devbox D89: each eval program's desktop calls carry that program's own stop and its own move to the background,
 * however programs overlap. The actor keeps one codemode factory for all its programs, and a program moved to the
 * background keeps calling while the next one runs; its calls arrive over RPC, outside its async context. The
 * programs here are launched by a stand-in that holds each one open and makes its calls as RPC would.
 */
import { freshServedStores } from '@kinu.run/test-utils';
import { expect, test } from 'bun:test';
import type { ToolExecutionOptions } from 'ai';
import {
  createSandboxExecutor, DEVICE_REQUEST_OPTION, DeviceRequestOwnership, executorNamespace, narrowToolSurface, type CodemodeSurface,
  projectJsonValue, type JsonValue, type SandboxHandle,
} from '@kinu.run/core';
import type { DesktopAction, DesktopAnswer, DesktopScreen } from '../../core/src/execution/desktop';
import { sandboxHandleLifecycle } from '../../core/tests/helpers/sandbox-handle-lifecycle';
import { createCodemodeToolFactory, type CodemodeScope } from '../src/codemode-tool';
import type { ProgramLaunch } from '../src/codemode-sandbox';

const PNG = 'iVBORw0KGgo=';

const SCREEN: DesktopScreen = { width: 1280, height: 768, sheet: { percent: 50, columns: [1, 2, 2, 2, 4, 4, 4, 4] } };

/** A call of a program's `computer.<member>`, as its RPC reaches it: its value, or the refusal it branches on. */
type Call = (member: string, ...args: JsonValue[]) => Promise<JsonValue>;

/** Launches each program and holds it open: the test makes its calls, then lets it end. */
function heldPrograms() {
  const programs: Array<{ readonly call: Call; readonly end: () => void }> = [];
  const waiting: Array<{ readonly count: number; readonly resolve: () => void }> = [];

  const launch: ProgramLaunch = {
    run: async (_source, providers) => await new Promise((resolve) => {
      const computer = providers.find((provider) => provider.name === 'computer');

      if (computer === undefined) throw new Error('the program reaches no computer');

      const call: Call = async (member, ...args) => {
        const fn = computer.fns[member];

        if (fn === undefined) throw new Error(`computer has no ${member}`);

        return projectJsonValue({ value: await fn(...args) });
      };

      programs.push({ call, end: () => { resolve({ result: null }); } });

      for (const waiter of waiting.filter((entry) => programs.length >= entry.count)) {
        waiting.splice(waiting.indexOf(waiter), 1);
        waiter.resolve();
      }
    }),
  };

  /** The `count`th program, once it runs. */
  const running = async (count: number) => {
    if (programs.length < count) await new Promise<void>((resolve) => { waiting.push({ count, resolve }); });
    const program = programs[count - 1];

    if (program === undefined) throw new Error(`program ${String(count)} never ran`);

    return program;
  };

  return { launch, running };
}

/** A box whose looks hold the screen until let go, and end when their call is stopped; it records each action. */
function desktopBox() {
  const sent: DesktopAction[] = [];
  const looks: Array<() => void> = [];
  const looking = Promise.withResolvers<void>();

  const unreachable = async (): Promise<never> => {
    throw new Error('a desktop call must not touch the computer any other way');
  };

  const box: SandboxHandle = {
    exec: unreachable, readFile: unreachable, writeFile: unreachable, listFiles: unreachable, deleteFile: unreachable,
    exposePort: unreachable, unexposePort: unreachable, getExposedPorts: unreachable,
    ...sandboxHandleLifecycle,
    desktop: async ({ action }, opts) => {
      sent.push(action);

      if (action.kind !== 'screenshot') return { kind: 'done' };

      return await new Promise<DesktopAnswer>((resolve, reject) => {
        looks.push(() => { resolve({ kind: 'screen', png: PNG, width: SCREEN.width, height: SCREEN.height }); });
        opts?.signal?.addEventListener('abort', () => { reject(new DOMException('its container process tree was ended', 'AbortError')); }, { once: true });
        looking.resolve();
      });
    },
  };

  return { box, sent, looking: looking.promise, letGo: () => { looks.shift()?.(); } };
}

test("an older program's late desktop calls carry its own stop and background state, not the newer program's", async () => {
  const { launch, running } = heldPrograms();
  const desk = desktopBox();
  const factory = createCodemodeToolFactory({ launch: () => launch, workspace: 'main' });
  const surface: CodemodeSurface = { native: {}, craftedTools: () => [], external: () => ({}), cwd: '/home/user', stores: freshServedStores() };
  const computer = createSandboxExecutor(desk.box, { desktop: { driver: 'main', screen: SCREEN } });
  const scope: CodemodeScope = { namespaces: (executor) => [executorNamespace(executor(computer))], reach: narrowToolSurface(undefined) };
  const { execute } = factory.toolFor(surface, scope);

  if (execute === undefined) throw new Error('eval is not callable');

  /** An eval, its stop and its device-request owner given as the background wrapper gives them. */
  const evaluate = async (stop: AbortController, owner: DeviceRequestOwnership): Promise<void> => {
    const options: ToolExecutionOptions<unknown> & { readonly [DEVICE_REQUEST_OPTION]: DeviceRequestOwnership } = {
      toolCallId: `call-${owner.jobId}`, messages: [], context: undefined, abortSignal: stop.signal, [DEVICE_REQUEST_OPTION]: owner,
    };

    await execute({ code: 'return null;' }, options);
  };

  const older = { stop: new AbortController(), owner: new DeviceRequestOwnership('job-older') };
  const newer = { stop: new AbortController(), owner: new DeviceRequestOwnership('job-newer') };
  const olderRun = evaluate(older.stop, older.owner);
  const first = await running(1);

  // The older program outlives its window and moves to the background; the turn runs the next one.
  older.owner.drain(older.owner.jobId);
  const newerRun = evaluate(newer.stop, newer.owner);

  await running(2);

  const click = await first.call('click', [1, 2]);
  const look = first.call('screenshot');

  await desk.looking;
  // Stopping the newer program leaves the older one's look on the screen; it answers once the box lets it go.
  newer.stop.abort();
  desk.letGo();

  expect({ click, look: await look, sent: desk.sent }).toEqual({
    click: expect.objectContaining({ success: false, reason: 'denied' }),
    look: `data:image/png;base64,${PNG}`,
    sent: [{ kind: 'screenshot' }],
  });

  for (const program of [first, await running(2)]) program.end();
  await Promise.allSettled([olderRun, newerRun]);
});
