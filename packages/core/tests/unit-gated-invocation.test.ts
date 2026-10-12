/**
 * An answer authorizes exactly the invocation that runs: each real executor member reads a call once, the gate asks and
 * keys that reading, and the member runs it. What the owner was shown is what reached the machine, and the same words
 * anywhere else (another directory, shell, machine) are another ask.
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { Effect } from 'effect';
import { createTestActors, present } from '@kinu.run/test-utils';
import {
  createNimbusWorkspaceExecutor, createShellSession, DeferredApprovalQueue, DeferredApprovalStore, initDeferredApprovalsTable,
  nimbusSessionFiles, nimbusSessionShell, withApprovalGatedShell, WORKSPACE_ROOT,
  type NimbusSandboxHandle, type ShellApprovalOutcome, type ShellApprovalPolicy, type ShellApprovalRequest,
} from '../src/index';
import { createDeviceTunnelExecutor, type DeviceTransport } from '../src/execution/device-tunnel-executor';
import type { DeviceFleetEntry, DeviceStatus } from '../src/execution/device-status';
import { DefaultExecutionRouter } from '../src/execution/router';
import type { JsonValue } from '../src/utils/json';
import { createTestRuntime, makeExecRaw, makeSql } from './helpers';

/** Asked on every executor: it rewrites a remote's history. */
const GATED = ['git', 'push --force origin main'].join(' ');

/** The owner's queue, and a live prompt answering every ask with `answer`, recording what each showed. */
function owner(answer: ShellApprovalOutcome) {
  const db = new Database(':memory:');
  const sql = makeSql(db);
  const execRaw = makeExecRaw(db);
  initDeferredApprovalsTable(execRaw);
  let seq = 0;

  const queue = new DeferredApprovalQueue({
    writes: null,
    store: new DeferredApprovalStore(sql, createTestActors(sql, execRaw).main),
    wake: () => Effect.void,
    remember: () => {},
    newId: () => `ask-${String(seq += 1)}`,
  });

  const shown: ShellApprovalRequest[] = [];

  const policy: ShellApprovalPolicy = {
    mode: () => 'strict',
    deferrals: queue.channel,
    requestApproval: async (request) => {
      shown.push(request);

      return answer;
    },
  };

  return { policy, shown, queue };
}

/** Live prompts the test answers: resolves `shown` once `count` asks are in front of the owner. */
function prompts(count: number) {
  const asked: Array<{ readonly request: ShellApprovalRequest; answer(outcome: ShellApprovalOutcome): void }> = [];
  const shown = Promise.withResolvers<void>();

  const ask = (request: ShellApprovalRequest) => new Promise<ShellApprovalOutcome | null>((resolve) => {
    asked.push({ request, answer: resolve });

    if (asked.length === count) shown.resolve();
  });

  return { asked, ask, shown: shown.promise };
}

describe('the workspace\'s own processes over the user\'s Drive', () => {
  /** The hosted workspace as cf-backend composes it, over a box that records what it was asked to start. */
  function workspace(policy: ShellApprovalPolicy) {
    const started: Array<{ readonly command: string; readonly cwd: string | undefined }> = [];

    const box: NimbusSandboxHandle = {
      ready: async () => {},
      exec: async (command: string) => ({ command, success: true, stdout: '', stderr: '', exitCode: 0 }),
      startProcess: async (command, options) => {
        started.push({ command, cwd: options?.cwd });

        return { command, pid: 7, process: { pid: 7, command, state: 'running', exitCode: null, longRunning: true }, ports: [], startedAt: 1 };
      },
      files: { read: async () => null, write: async () => {}, list: async () => [], stat: async () => null, exists: async () => false, delete: async () => {} },
    };

    const { rt } = createTestRuntime();
    const router = new DefaultExecutionRouter(policy);

    router.register(createNimbusWorkspaceExecutor({
      box,
      shellSession: createShellSession({ home: WORKSPACE_ROOT, userRoots: () => ['/shared'] }),
      inline: { vfs: nimbusSessionFiles(box, { home: WORKSPACE_ROOT }), shell: nimbusSessionShell(box, { home: WORKSPACE_ROOT }), memory: rt.memory, craftStore: rt.craftStore },
    }));

    return { start: present(router.getProvider('workspace'), 'the workspace').tools.startProcess, started };
  }

  test('an option the member ignores does not move where the command is reviewed: it is asked where it runs', async () => {
    const asking = owner('deny');
    const denied = workspace(asking.policy);

    // `install` is not a startProcess option: the member drops it and still starts in the Drive, so it is asked there.
    await denied.start.execute('rm -rf build', { cwd: '/shared/project', install: true });
    expect(denied.started).toEqual([]);
    expect(asking.shown).toHaveLength(1);
    expect(asking.shown[0]?.context).toEqual({ cwd: '/shared/project' });

    const allowing = owner('allow');
    const approved = workspace(allowing.policy);

    await approved.start.execute('rm -rf build', { cwd: '/shared/project', install: true });
    expect(approved.started).toEqual([{ command: 'rm -rf build', cwd: allowing.shown[0]?.context.cwd }]);
  });
});

describe('a machine is part of the ask', () => {
  const STUDIO: DeviceFleetEntry = { id: 'dev-studio', name: 'studio', os: 'darwin', hostname: 'studio', connected: true };

  const RIG: DeviceFleetEntry = { id: 'dev-rig', name: 'rig', os: 'linux', hostname: 'rig', connected: true };

  function fleet(): DeviceTransport & { readonly ranOn: Array<string | undefined> } {
    const ranOn: Array<string | undefined> = [];
    const status = (): DeviceStatus => ({ connected: true, registered: true, toolchain: null, devices: [STUDIO, RIG] });

    return {
      ranOn,
      status,
      refreshStatus: async () => status(),
      rpc: async (method, _params, opts): Promise<JsonValue> => {
        if (method === 'exec') ranOn.push(opts?.deviceId);

        return { stdout: '', stderr: '', exitCode: 0 };
      },
    };
  }

  test('the same command on two machines is two asks, and approving one runs it there alone', async () => {
    const transport = fleet();
    const { policy, queue } = owner('deny');
    const live = prompts(2);
    const router = new DefaultExecutionRouter({ ...policy, requestApproval: live.ask });

    router.register(createDeviceTunnelExecutor(transport));
    const exec = present(router.getProvider('device'), 'the device').tools.exec;
    const onStudio = exec.execute(GATED, 'studio');
    const onRig = exec.execute(GATED, { device: 'rig' });

    await live.shown;
    // Each machine's ask is its own row: one answer cannot release the other.
    expect(new Set(live.asked.map((prompt) => prompt.request.approvalId)).size).toBe(2);
    expect(queue.list()).toHaveLength(2);

    for (const prompt of live.asked) prompt.answer(prompt.request.context.machine?.name === 'studio' ? 'allow' : 'deny');
    await Promise.all([onStudio, onRig]);
    expect(transport.ranOn).toEqual(['dev-studio']);
  });
});

describe('a context is compared as structure, never as its words', () => {
  test('a directory or shell name that reads like another field is not that field: each ask is its own, run where asked', async () => {
    const ran: Array<{ readonly cwd: string | undefined; readonly name: string | undefined }> = [];
    const { policy, queue } = owner('deny');
    const live = prompts(3);

    const shell = withApprovalGatedShell({
      exec: async (_command, options) => {
        ran.push({ cwd: typeof options === 'object' ? options.cwd : undefined, name: typeof options === 'object' ? options.name : undefined });

        return { stdout: '', stderr: '', exitCode: 0 };
      },
    }, { filesOwner: 'user', shellSession: createShellSession({ home: '/home/main', userRoots: () => ['/'] }) }, { ...policy, requestApproval: live.ask });

    // Spelled as one string, the first two both read `in /repo · shell release`; the third's name carries the separator.
    const calls = [
      { cwd: '/repo · shell release' },
      { cwd: '/repo', name: 'release' },
      { cwd: '/repo', name: 'release · in /repo' },
    ];

    const runs = calls.map((options) => shell.exec(GATED, options));

    await live.shown;
    expect(new Set(live.asked.map((prompt) => prompt.request.approvalId)).size).toBe(3);
    expect(queue.list()).toHaveLength(3);

    for (const prompt of live.asked) prompt.answer(prompt.request.context.shell === undefined ? 'allow' : 'deny');
    const results = await Promise.all(runs);

    expect(results.map((result) => result.exitCode === 0)).toEqual([true, false, false]);
    expect(ran).toEqual([{ cwd: '/repo · shell release', name: undefined }]);
  });
});
