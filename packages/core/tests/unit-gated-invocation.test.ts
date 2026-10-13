/**
 * An answer authorizes exactly the invocation that runs: each real executor member reads a call once, the gate asks and
 * keys that reading, and the member runs it. What the owner was shown is what reached the machine, and the same words
 * anywhere else (another directory, shell, machine) are another ask.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect } from 'effect';
import { createTestActors, present } from '@kinu.run/test-utils';
import {
  createNimbusWorkspaceExecutor, createShellSession, DeferredApprovalQueue, DeferredApprovalStore, initDeferredApprovalsTable,
  nimbusSessionFiles, nimbusSessionShell, withApprovalGatedShell, WORKSPACE_ROOT,
  type ShellApprovalOutcome, type ShellApprovalPolicy, type ShellApprovalRequest,
} from '../src/index';
import { sessionFilesOver, type SessionBox } from '@kinu.run/test-utils/vfs';
import { createBashShell } from '../src/execution/shell-session';
import { createSandboxExecutor, type SandboxHandle } from '../src/execution/sandbox';
import { sandboxHandleLifecycle } from './helpers/sandbox-handle-lifecycle';
import { scratchMachine } from './helpers/scratch-machine';
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

/** A sandbox whose container runs each command through `exec`; supervised starts are recorded in `started`. */
function sandboxOver(exec: (command: string) => Promise<{ stdout: string; stderr: string; exitCode: number }>, started: string[] = []): SandboxHandle {
  return {
    exec: (command) => exec(command),
    readFile: async () => ({}),
    writeFile: async () => {},
    listFiles: async () => ({ files: [] }),
    deleteFile: async () => {},
    exposePort: async (port) => ({ url: `https://preview.example.com/${String(port)}`, port, route: { reached: true } }),
    unexposePort: async () => {},
    getExposedPorts: async () => [],
    ...sandboxHandleLifecycle,
    startSupervisedProcess: async (command) => {
      started.push(command);

      return { processId: 'proc-1' };
    },
  };
}

describe('the workspace\'s own processes over the user\'s Drive', () => {
  /** The hosted workspace as cf-backend composes it, over a box that records what it was asked to start. */
  function workspace(policy: ShellApprovalPolicy) {
    const started: Array<{ readonly command: string; readonly cwd: string | undefined }> = [];

    const box: SessionBox = {
      ready: async () => {},
      exec: async (command: string) => ({ command, success: true, stdout: '', stderr: '', exitCode: 0, duration: 0, timestamp: 0 }),
      startProcess: async (command, options) => {
        started.push({ command, cwd: options?.cwd });

        return {
          command, pid: 7, ports: [], startedAt: 1,
          process: { pid: 7, command, argv: [command], cwd: options?.cwd ?? WORKSPACE_ROOT, state: 'running', exitCode: null, startTime: 1, endTime: null, longRunning: true, attachedTty: false },
        };
      },
      files: sessionFilesOver(),
    };

    const { rt } = createTestRuntime();
    const router = new DefaultExecutionRouter(policy);

    router.register(createNimbusWorkspaceExecutor({
      box,
      shellSession: createShellSession({ home: WORKSPACE_ROOT, userRoots: () => ['/shared'] }),
      inline: { vfs: nimbusSessionFiles(box.files, { home: WORKSPACE_ROOT }), shell: nimbusSessionShell(box, { home: WORKSPACE_ROOT }), memory: rt.memory, craftStore: rt.craftStore },
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
    expect(asking.shown[0]?.context).toEqual({ member: 'startProcess', cwd: '/shared/project' });

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
    const status = (): DeviceStatus => ({ devices: [STUDIO, RIG] });

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

describe('the member is part of the ask', () => {
  test('the same words and options to exec and to startProcess are two asks: a foreground run is not a supervised process', async () => {
    const ran: string[] = [];
    const { policy, queue } = owner('deny');
    const live = prompts(2);

    const handle = sandboxOver(async (command) => {
      ran.push(`exec ${command}`);

      return { stdout: '', stderr: '', exitCode: 0 };
    }, ran);

    const router = new DefaultExecutionRouter({ ...policy, requestApproval: live.ask });
    router.register(createSandboxExecutor(handle));
    const { tools } = present(router.getProvider('sandbox'), 'the sandbox');
    const foreground = tools.exec.execute(GATED, { cwd: '/workspace' });
    const supervised = present(tools.startProcess, 'startProcess').execute(GATED, { cwd: '/workspace' });

    await live.shown;
    expect(new Set(live.asked.map((prompt) => prompt.request.approvalId)).size).toBe(2);
    expect(queue.list()).toHaveLength(2);

    for (const prompt of live.asked) prompt.answer(prompt.request.context.member === 'exec' ? 'allow' : 'deny');
    await Promise.all([foreground, supervised]);
    // The foreground run, in the directory it was asked for; no supervised process was started.
    expect(ran).toEqual([`exec cd -- '/workspace' || exit\n${GATED}`]);
  });

  test('a run stamped as a background job is another ask than the same run in the foreground', async () => {
    const { policy, queue } = owner('deny');
    const router = new DefaultExecutionRouter({ ...policy, requestApproval: null });
    router.register(createSandboxExecutor(sandboxOver(async () => ({ stdout: '', stderr: '', exitCode: 0 }))));
    const { exec } = present(router.getProvider('sandbox'), 'the sandbox').tools;

    await exec.execute(GATED);
    await exec.execute(GATED, { job: 'job-1', detached: new AbortController().signal });

    expect(queue.list().map((row) => row.context.background)).toEqual([undefined, true]);
  });

  test('two Nimbus programs alike but for their work limit are two asks', async () => {
    const ran: Array<number | undefined> = [];
    const { policy, queue } = owner('deny');
    const live = prompts(2);

    const box: SessionBox = {
      ready: async () => {},
      exec: async (command) => ({ command, success: true, stdout: '', stderr: '', exitCode: 0, duration: 0, timestamp: 0 }),
      runCode: async (code, options) => {
        ran.push(options?.timeoutMs);

        return { command: code, success: true, stdout: '', stderr: '', exitCode: 0, duration: 0, timestamp: 0 };
      },
      files: sessionFilesOver(),
    };

    const { rt } = createTestRuntime();
    const router = new DefaultExecutionRouter({ ...policy, requestApproval: live.ask });

    router.register(createNimbusWorkspaceExecutor({
      box,
      shellSession: createShellSession({ home: WORKSPACE_ROOT, userRoots: () => [] }),
      inline: { vfs: nimbusSessionFiles(box.files, { home: WORKSPACE_ROOT }), shell: nimbusSessionShell(box, { home: WORKSPACE_ROOT }), memory: rt.memory, craftStore: rt.craftStore },
    }));

    const runCode = present(present(router.getProvider('workspace'), 'the workspace').tools.runCode, 'runCode');
    const long = runCode.execute(GATED, { language: 'shell', timeoutMs: 60_000 });
    const short = runCode.execute(GATED, { language: 'shell', timeoutMs: 1 });

    await live.shown;
    expect(queue.list()).toHaveLength(2);

    for (const prompt of live.asked) prompt.answer(prompt.request.context.timeoutMs === 1 ? 'allow' : 'deny');
    await Promise.all([long, short]);
    expect(ran).toEqual([1]);
  });
});

describe('an approval answers the row it shows, and returns when nothing ran', () => {
  test('a run cancelled while its prompt was answered is not dispatched, and the approval runs the next ask', async () => {
    const ran: string[] = [];
    const { policy } = owner('deny');
    const cancel = new AbortController();
    let asked = 0;

    const router = new DefaultExecutionRouter({
      ...policy,
      requestApproval: async () => {
        asked += 1;
        // The caller gives up while the owner is answering.
        cancel.abort();

        return 'allow';
      },
    });

    router.register(createSandboxExecutor(sandboxOver(async (command) => {
      ran.push(command);

      return { stdout: '', stderr: '', exitCode: 0 };
    })));

    const { exec } = present(router.getProvider('sandbox'), 'the sandbox').tools;

    expect(JSON.stringify(await exec.execute(GATED, { signal: cancel.signal }))).toContain('NOT RUN');
    expect(ran).toEqual([]);

    await exec.execute(GATED);
    expect({ ran, asked }).toEqual({ ran: [GATED], asked: 1 });
  });

  test('a live prompt shows the rules its row holds, so always-allow grants only what was shown', async () => {
    const ran: string[] = [];
    const { policy, queue } = owner('deny');
    const granted = new Set<string>();
    const shown: ShellApprovalRequest[] = [];
    const twoRules = `sudo true; ${GATED}`;

    const asking: ShellApprovalPolicy = {
      ...policy,
      granted: (grant) => granted.has(grant.rule),
      requestApproval: null,
    };

    const shell = withApprovalGatedShell({
      exec: async (command) => {
        ran.push(command);

        return { stdout: '', stderr: '', exitCode: 0 };
      },
    }, { filesOwner: 'user' }, asking);

    // Parked with both rules; one is granted standing before the owner gets to the row.
    await shell.exec(twoRules);
    granted.add('sudo');
    asking.requestApproval = async (request) => {
      shown.push(request);

      return 'deny';
    };

    await shell.exec(twoRules);
    expect(queue.list()).toEqual([]);
    expect(shown.map((request) => request.review.hits.map((hit) => hit.rule).sort())).toEqual([['git-force-push', 'sudo']]);
    expect(ran).toEqual([]);
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

describe('a named shell is part of the ask as it was when asked', () => {
  const homes: string[] = [];

  afterEach(() => {
    for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
  });

  /** A scratch machine home holding `doomed` both at its top and under `sub`. */
  function scratchHome(): string {
    const home = mkdtempSync(join(tmpdir(), 'kinu-gated-shell-'));
    homes.push(home);

    for (const dir of ['doomed', 'sub/doomed', 'a', 'b']) mkdirSync(join(home, dir), { recursive: true });

    return home;
  }

  const SHELLS = { scope: 'agent:alpha', stateDirectory: '~/.kinu/shells' };

  /** Asked wherever it runs (a force push), and leaves its mark where it ran: `doomed` gone from its directory. */
  const DOOMING = `${GATED}; rm -r`;

  /** Nobody in front of the owner: every ask parks, and the agent asks again once it is approved. */
  function unattended() {
    const { policy, queue } = owner('deny');

    return { policy: { ...policy, requestApproval: null }, queue };
  }

  /** Parks the ask, lets `meanwhile` run in the same named shell, approves the row, and asks again. */
  async function approveAcrossAMove<R>(
    queue: DeferredApprovalQueue, ask: () => Promise<R>, meanwhile: () => Promise<void>,
  ): Promise<{ readonly asked: R; readonly again: R }> {
    const asked = await ask();
    const parked = queue.list();

    expect(parked).toHaveLength(1);
    await meanwhile();
    await queue.decide(parked.map((row) => row.id), 'approved');

    return { asked, again: await ask() };
  }

  test('the host shell: a variable the shell exports changed after the ask, so the approval does not run', async () => {
    const home = scratchHome();
    const { policy, queue } = unattended();
    const bash = createBashShell(scratchMachine(home), { home, ...SHELLS });
    const session = createShellSession({ home, userRoots: () => [], stored: async (name) => await bash.cwd?.(name) ?? null });
    const shell = withApprovalGatedShell(bash, { filesOwner: 'agent', shellSession: session }, policy);

    await shell.exec('export DOOMED=a', { name: 'dev' });

    const { again } = await approveAcrossAMove(
      queue, () => shell.exec(`${DOOMING} "$DOOMED"`, { name: 'dev' }), async () => { await shell.exec('export DOOMED=b', { name: 'dev' }); },
    );

    expect(existsSync(join(home, 'b'))).toBe(true);
    expect(existsSync(join(home, 'a'))).toBe(true);
    expect(again.exitCode).not.toBe(0);
  });

  test('the sandbox: its shell moved after the ask, so the approval does not run where it now is', async () => {
    const home = scratchHome();
    const { policy, queue } = unattended();
    const machine = scratchMachine(home);

    const router = new DefaultExecutionRouter(policy);
    router.register(createSandboxExecutor(sandboxOver((command) => machine.exec(command)), { shells: SHELLS }));
    const exec = present(router.getProvider('sandbox'), 'the sandbox').tools.exec;

    await exec.execute('cd sub', { name: 'dev' });

    await approveAcrossAMove(
      queue, () => exec.execute(`${DOOMING} doomed`, { name: 'dev' }), async () => { await exec.execute('cd ..', { name: 'dev' }); },
    );

    expect(existsSync(join(home, 'doomed'))).toBe(true);
    expect(existsSync(join(home, 'sub/doomed'))).toBe(true);
  });

  test('the sandbox: a run cancelled while it waited on its shell was not dispatched, and its approval runs the next ask', async () => {
    const home = scratchHome();
    const { policy, queue } = unattended();
    const machine = scratchMachine(home);
    const cancel = new AbortController();
    const reads = { count: 0, cancelAt: Number.POSITIVE_INFINITY };

    const router = new DefaultExecutionRouter(policy);

    router.register(createSandboxExecutor(sandboxOver(async (command) => {
      // A state read names the file as its first argument; a named call's wrapper names it as its second.
      if (command.includes('/$1.bash') && (reads.count += 1) === reads.cancelAt) cancel.abort();

      return await machine.exec(command);
    }), { shells: SHELLS }));

    const exec = present(router.getProvider('sandbox'), 'the sandbox').tools.exec;

    await exec.execute(`${DOOMING} doomed`, { name: 'dev' });
    await queue.decide(queue.list().map((row) => row.id), 'approved');

    // The re-issue's own read pins the approved state; the caller gives up during the next, inside the shell's hold.
    reads.cancelAt = reads.count + 2;
    await expect(exec.execute(`${DOOMING} doomed`, { name: 'dev', signal: cancel.signal })).rejects.toMatchObject({ name: 'AbortError' });
    expect(existsSync(join(home, 'doomed'))).toBe(true);

    await exec.execute(`${DOOMING} doomed`, { name: 'dev' });
    expect({ doomed: existsSync(join(home, 'doomed')), parked: queue.list() }).toEqual({ doomed: false, parked: [] });
  });

  /** How the read of a hosted session's directory goes wrong just before a call is sent: [how, what happens]. */
  const DIRECTORY_READ_MISHAPS = [
    ['meets the caller\'s cancel', (cancel: AbortController) => { cancel.abort(); }],
    ['fails', () => { throw new Error('the session directory read failed'); }],
  ] as const;

  test.each(DIRECTORY_READ_MISHAPS)('the hosted session: a run whose directory read %s was not sent, and its approval runs the next ask', async (_how, mishap) => {
    const { policy, queue } = unattended();
    const cancel = new AbortController();
    const dispatched: string[] = [];
    const watch = { states: 0, mishapAfter: Number.NaN };

    const box: SessionBox = {
      ready: async () => {},
      exec: async (command) => {
        // A state read is digested in the session; anything else is a command sent to it.
        if (command.includes('sha256sum')) watch.states += 1;
        else dispatched.push(command);

        return { command, success: true, stdout: command.includes('sha256sum') ? `${'0'.repeat(64)}  -\n` : '', stderr: '', exitCode: 0, duration: 0, timestamp: 0 };
      },
      shellCwd: async () => {
        if (watch.states === watch.mishapAfter) {
          watch.mishapAfter = Number.NaN;
          mishap(cancel);
        }

        return WORKSPACE_ROOT;
      },
      files: sessionFilesOver(),
    };

    const sessionShell = nimbusSessionShell(box, { home: WORKSPACE_ROOT });
    const session = createShellSession({ home: WORKSPACE_ROOT, userRoots: () => [], stored: async (name) => await sessionShell.cwd?.(name) ?? null });
    const shell = withApprovalGatedShell(sessionShell, { filesOwner: 'agent', shellSession: session }, policy);

    await shell.exec(GATED, { name: 'dev' });
    await queue.decide(queue.list().map((row) => row.id), 'approved');

    // The re-issue's read pins the state and the read just before the run confirms it; the directory read that
    // follows, before the command is sent, is where it goes wrong.
    watch.mishapAfter = watch.states + 2;
    await Promise.allSettled([shell.exec(GATED, { name: 'dev', signal: cancel.signal })]);
    expect(dispatched).toEqual([]);

    await shell.exec(GATED, { name: 'dev' });
    expect({ dispatched, parked: queue.list() }).toEqual({ dispatched: [GATED], parked: [] });
  });

  /**
   * One device whose machine is a scratch home, counting how often a named shell's state is read on it; reads past
   * `failAfter` fail as a dropped tunnel would.
   */
  function device(home: string, policy: ShellApprovalPolicy) {
    const machine = scratchMachine(home);
    const STUDIO: DeviceFleetEntry = { id: 'dev-studio', name: 'studio', os: 'linux', hostname: 'studio', connected: true };
    const status = (): DeviceStatus => ({ devices: [STUDIO] });
    const reads = { count: 0, failAfter: Number.POSITIVE_INFINITY };

    const transport: DeviceTransport = {
      status,
      refreshStatus: async () => status(),
      rpc: async (method, params): Promise<JsonValue> => {
        if (method !== 'exec') return null;
        const command = typeof params[0] === 'string' ? params[0] : '';

        // A state read names the file as its first argument; a named call's wrapper names it as its second.
        if (command.includes('/$1.bash')) {
          reads.count += 1;

          if (reads.count > reads.failAfter) throw new Error('the tunnel dropped');
        }

        const { stdout, stderr, exitCode } = await machine.exec(command);

        return { stdout, stderr, exitCode };
      },
    };

    const router = new DefaultExecutionRouter(policy);
    router.register(createDeviceTunnelExecutor(transport, undefined, SHELLS));

    return { exec: present(router.getProvider('device'), 'the device').tools.exec, reads };
  }

  test('a device: its shell moved after the ask, so the approval does not run where it now is', async () => {
    const home = scratchHome();
    const { policy, queue } = unattended();
    const { exec } = device(home, policy);

    await exec.execute('cd sub', { name: 'dev' });

    await approveAcrossAMove(
      queue, () => exec.execute(`${DOOMING} doomed`, { name: 'dev' }), async () => { await exec.execute('cd ..', { name: 'dev' }); },
    );

    expect(existsSync(join(home, 'doomed'))).toBe(true);
    expect(existsSync(join(home, 'sub/doomed'))).toBe(true);
  });

  test('a state read that fails just before the run is NOT RUN, and the approval comes back for the next ask', async () => {
    const home = scratchHome();
    const { policy, queue } = unattended();
    const { exec, reads } = device(home, policy);
    const asking = () => exec.execute(`${DOOMING} doomed`, { name: 'dev' });

    await exec.execute('cd sub', { name: 'dev' });
    await asking();
    await queue.decide(queue.list().map((row) => row.id), 'approved');

    // The re-issue's own read pins the approved state; the next one, just before the run, fails.
    reads.failAfter = reads.count + 1;
    await asking();

    reads.failAfter = Number.POSITIVE_INFINITY;
    expect(existsSync(join(home, 'sub/doomed'))).toBe(true);

    // Refunded: the same ask runs on the same approval, and nothing new waits.
    await asking();
    expect(existsSync(join(home, 'sub/doomed'))).toBe(false);
    expect(queue.list()).toEqual([]);
  });

  test('a call no answer is asked for reads no shell state', async () => {
    const home = scratchHome();
    const { policy } = unattended();
    const { exec, reads } = device(home, { ...policy, mode: () => 'allow_all' });

    await exec.execute('cd sub', { name: 'dev' });
    await exec.execute(`${DOOMING} doomed`, { name: 'dev' });

    expect(existsSync(join(home, 'sub/doomed'))).toBe(false);
    expect(reads.count).toBe(0);
  });
});
