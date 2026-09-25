/**
 * The executor-seam approval gate: a command gated via `shell` must also be gated via codemode
 * (`nimbus.exec`, `sandbox.exec`, `device.exec`). Fails if `ExecutionRouter.register()` stops gating.
 */
import { describe, test, expect } from 'bun:test';
import { Database } from 'bun:sqlite';
import { DefaultExecutionRouter } from '../src/execution/router';
import { gateProviderExec, withApprovalGatedShell } from '../src/execution/approval';
import { createSandboxExecutor } from '../src/execution/sandbox';
import type { ExecutorProvider } from '../src/execution/types';
import type { FilesOwner, ShellApprovalPolicy, ShellApprovalRequest } from '../src/safety/approval-gate';
import type { VFS } from '../src/types/primitives';
import { withMountTable } from '../src/vfs/mounts';
import { skillsMount } from '../src/skills/view';
import { WORKSPACE_ROOT } from '../src/vfs/workspace-path';
import { present } from '@kinu.run/test-utils';
import { createWorkspaceBundle } from './helpers';

const DENY = 'rm -rf /';

const GATE = 'sudo rm -rf /var/lib/important';

const ALLOW = 'echo hi';

/** A minimal ExecutorProvider shaped like nimbus/sandbox/device. */
function fakeShellProvider(name: string, kind: ExecutorProvider['kind'] = 'nimbus', filesOwner: FilesOwner = 'user') {
  const executed: string[] = [];

  const provider: ExecutorProvider = {
    name,
    kind,
    capabilities: new Set(['shell']),
    filesOwner,
    homeDir: async () => '/home/main',
    isAvailable: () => true,
    connect: async () => {},
    disconnect: async () => {},
    tools: {
      exec: {
        description: 'Run a shell command',
        execute: async (...args: unknown[]) => {
          const command = String(args[0]);
          executed.push(command);

          return `ran: ${command}`;
        },
      },
      startProcess: {
        description: 'Start a long-running process',
        execute: async (...args: unknown[]) => {
          const command = String(args[0]);
          executed.push(command);

          return `started: ${command}`;
        },
      },
      readFile: {
        description: 'Read a file — not a shell command, never gated',
        execute: async (...args: unknown[]) => `contents of ${String(args[0])}`,
      },
    },
  };

  return { provider, executed };
}

function strictNoChannelPolicy(): ShellApprovalPolicy {
  return { mode: () => 'strict' };
}

describe('gateProviderExec — the executor-seam gate', () => {
  test('a deny-tier command never reaches the underlying executor', async () => {
    const { provider, executed } = fakeShellProvider('nimbus');
    const gated = gateProviderExec(provider, strictNoChannelPolicy());
    const result = await gated.tools.exec.execute(DENY);
    expect(result).toMatchObject({ error: expect.stringContaining('rm-rf-root') });
    expect(executed).toEqual([]);
  });

  test('a gate-tier command with no approver wired is refused, not silently allowed', async () => {
    // On `device`; on the agent's own sandbox this string is housekeeping.
    const { provider, executed } = fakeShellProvider('device', 'device');
    const gated = gateProviderExec(provider, strictNoChannelPolicy());
    const result = await gated.tools.exec.execute(GATE);
    expect(result).toMatchObject({ error: expect.stringContaining('needs owner approval') });
    expect(executed).toEqual([]);
  });

  test('allow_all lets a gate-tier command through', async () => {
    const { provider, executed } = fakeShellProvider('device', 'device');
    const gated = gateProviderExec(provider, { mode: () => 'allow_all' });
    const result = await gated.tools.exec.execute(GATE);
    expect(result).toBe(`ran: ${GATE}`);
    expect(executed).toEqual([GATE]);
  });

  test('an allow-tier command runs normally, ungated', async () => {
    const { provider, executed } = fakeShellProvider('nimbus');
    const gated = gateProviderExec(provider, strictNoChannelPolicy());
    const result = await gated.tools.exec.execute(ALLOW);
    expect(result).toBe(`ran: ${ALLOW}`);
    expect(executed).toEqual([ALLOW]);
  });

  test("nimbus's backgrounded startProcess is gated the same as exec — not a second, forgotten door", async () => {
    const { provider, executed } = fakeShellProvider('nimbus');
    const gated = gateProviderExec(provider, strictNoChannelPolicy());
    const result = await gated.tools.startProcess.execute(DENY);
    expect(result).toMatchObject({ error: expect.stringContaining('rm-rf-root') });
    expect(executed).toEqual([]);
  });

  test('a VFS-shaped tool (readFile) is left completely untouched — not every tool is a shell command', async () => {
    const { provider } = fakeShellProvider('nimbus');
    const gated = gateProviderExec(provider, strictNoChannelPolicy());
    expect(gated.tools.readFile.execute).toBe(provider.tools.readFile.execute);
  });

  test('workspace exec is left unwrapped because its Shell is gated at the source', async () => {
    const { provider } = fakeShellProvider('workspace', 'workspace');
    const gated = gateProviderExec(provider, strictNoChannelPolicy());
    expect(gated.tools.exec.execute).toBe(provider.tools.exec.execute);
  });

  test("the hosted workspace's background process door is gated even though exec is already gated at its Shell", async () => {
    const { provider, executed } = fakeShellProvider('workspace', 'workspace');
    const gated = gateProviderExec(provider, strictNoChannelPolicy());
    expect(gated.tools.exec.execute).toBe(provider.tools.exec.execute);
    const result = await gated.tools.startProcess.execute(DENY);
    expect(result).toMatchObject({ error: expect.stringContaining('rm-rf-root') });
    expect(executed).toEqual([]);
  });

  test('re-gating an already-gated provider is a no-op — idempotent against the same object crossing two routers', async () => {
    const { provider, executed } = fakeShellProvider('device', 'device');
    const askedFirst: ShellApprovalRequest[] = [];

    const firstPolicy: ShellApprovalPolicy = {
      mode: () => 'strict',
      requestApproval: async (req) => {
        askedFirst.push(req);

        return 'allow';
      },
    };

    const gatedOnce = gateProviderExec(provider, firstPolicy);

    // A second router (e.g. cli-backend/runtime.ts buildCLIHeadRuntime) re-gating the gated provider with another policy.
    const askedSecond: ShellApprovalRequest[] = [];

    const secondPolicy: ShellApprovalPolicy = {
      mode: () => 'strict',
      requestApproval: async (req) => {
        askedSecond.push(req);

        return 'deny';
      },
    };

    const gatedTwice = gateProviderExec(gatedOnce, secondPolicy);

    expect(gatedTwice.tools.exec.execute).toBe(gatedOnce.tools.exec.execute);

    const result = await gatedTwice.tools.exec.execute(GATE);
    // The first policy answered; the second was never consulted and the command ran once.
    expect(result).toBe(`ran: ${GATE}`);
    expect(askedFirst.length).toBe(1);
    expect(askedSecond).toEqual([]);
    expect(executed).toEqual([GATE]);
  });
});

describe('DefaultExecutionRouter — closes the codemode bypass', () => {
  test('BUG REPRO: a command run.getProvider gates is ALSO gated when reached the way codemode reaches it — getProvider(name).tools.exec.execute', async () => {
    const router = new DefaultExecutionRouter(strictNoChannelPolicy());
    const { provider, executed } = fakeShellProvider('nimbus');
    router.register(provider);

    // The call codemode's `nimbus.exec("rm -rf /x")` makes.
    const result = await present(router.getProvider('nimbus'), 'the registered nimbus provider').tools.exec.execute(DENY);
    expect(result).toMatchObject({ error: expect.stringContaining('rm-rf-root') });
    expect(executed).toEqual([]);
  });

  test('BUG REPRO: getProviders() — what eval is actually built from on both backends — returns the gated tool too', async () => {
    const router = new DefaultExecutionRouter(strictNoChannelPolicy());
    const { provider, executed } = fakeShellProvider('sandbox', 'sandbox', 'agent');
    router.register(provider);

    const fromGetProviders = present(router.getProviders().find((p) => p.name === 'sandbox'), 'the sandbox provider from getProviders()');
    const result = await fromGetProviders.tools.exec.execute(DENY);
    expect(result).toMatchObject({ error: expect.stringContaining('rm-rf-root') });
    expect(executed).toEqual([]);
  });

  test('an allowed command still runs, through either accessor', async () => {
    const router = new DefaultExecutionRouter(strictNoChannelPolicy());
    const { provider, executed } = fakeShellProvider('device', 'device');
    router.register(provider);

    await present(router.getProvider('device'), 'the registered device provider').tools.exec.execute(ALLOW);
    await router.getProviders()[0].tools.exec.execute(ALLOW);
    expect(executed).toEqual([ALLOW, ALLOW]);
  });

  test('no policy supplied still gates — the default is strict/no-channel, never "ungated"', async () => {
    const router = new DefaultExecutionRouter();
    const { provider, executed } = fakeShellProvider('nimbus');
    router.register(provider);

    const result = await present(router.getProvider('nimbus'), 'the registered nimbus provider').tools.exec.execute(DENY);
    expect(result).toMatchObject({ error: expect.stringContaining('rm-rf-root') });
    expect(executed).toEqual([]);
  });

  test('the router preserves the workspace exec gate from its Shell', async () => {
    const router = new DefaultExecutionRouter(strictNoChannelPolicy());
    const { provider } = fakeShellProvider('workspace', 'workspace');
    router.register(provider);
    expect(present(router.getProvider('workspace'), 'the registered workspace provider').tools.exec.execute).toBe(provider.tools.exec.execute);
  });

  test('a live mode change takes effect on the very next call — no re-registration needed', async () => {
    let mode: 'strict' | 'allow_all' | 'deny_all' = 'strict';
    const router = new DefaultExecutionRouter({ mode: () => mode });
    const { provider, executed } = fakeShellProvider('nimbus');
    router.register(provider);

    const nimbus = present(router.getProvider('nimbus'), 'the registered nimbus provider');
    const denied = await nimbus.tools.exec.execute(GATE);
    expect(denied).toMatchObject({ error: expect.stringContaining('needs owner approval') });

    mode = 'allow_all';
    const allowed = await nimbus.tools.exec.execute(GATE);

    expect(allowed).toBe(`ran: ${GATE}`);
    expect(executed).toEqual([GATE]);
  });
});

/** A strict policy that records every request put to the user and refuses it. */
function askingRouter() {
  const asked: ShellApprovalRequest[] = [];

  const router = new DefaultExecutionRouter({
    mode: () => 'strict',
    requestApproval: async (req) => {
      asked.push(req);

      return 'deny';
    },
  });

  return { router, asked };
}

/** `gateProviderExec` hands the provider to `gateExec`; these differ only in whose files the provider declares. */
describe('the executor reaches the gate', () => {
  const HOUSEKEEPING = 'rm -rf node_modules';

  test("cf's sandbox holds the agent's own files: commands that could wreck a user's machine are not put to them", async () => {
    const { router, asked } = askingRouter();
    router.register(createSandboxExecutor());
    const exec = present(router.getProvider('sandbox'), 'the registered sandbox').tools.exec;

    for (const command of ['sudo -n true', 'rm -rf ~/x', 'git reset --hard', 'chmod u+s tool']) {
      expect(await exec.execute(command)).not.toMatchObject({ error: expect.stringContaining('Denied by the owner') });
    }

    expect(asked).toEqual([]);
  });

  test("an executor holding the user's files is asked, whatever it is named", async () => {
    const { router, asked } = askingRouter();
    const { provider, executed } = fakeShellProvider('sandbox', 'sandbox', 'user');
    router.register(provider);

    const result = await present(router.getProvider('sandbox'), 'the registered provider').tools.exec.execute(HOUSEKEEPING);

    expect(result).toMatchObject({ error: expect.stringContaining('Denied by the owner') });
    expect(executed).toEqual([]);
    expect(asked.map((r) => r.command)).toEqual([HOUSEKEEPING]);
  });

  test("a recursive delete on the agent's own sandbox runs, unasked", async () => {
    const asked: ShellApprovalRequest[] = [];

    const router = new DefaultExecutionRouter({
      mode: () => 'strict',
      requestApproval: async (req) => {
        asked.push(req);

        return 'deny';
      },
    });

    const { provider, executed } = fakeShellProvider('sandbox', 'sandbox', 'agent');
    router.register(provider);

    const result = await present(router.getProvider('sandbox'), 'the registered sandbox provider').tools.exec.execute(HOUSEKEEPING);

    expect(result).toBe(`ran: ${HOUSEKEEPING}`);
    expect(executed).toEqual([HOUSEKEEPING]);
    expect(asked).toEqual([]);
  });

  test("the identical command against the owner's device is put to them", async () => {
    const asked: ShellApprovalRequest[] = [];

    const router = new DefaultExecutionRouter({
      mode: () => 'strict',
      requestApproval: async (req) => {
        asked.push(req);

        return 'deny';
      },
    });

    const { provider, executed } = fakeShellProvider('device', 'device');
    router.register(provider);

    const result = await present(router.getProvider('device'), 'the registered device provider').tools.exec.execute(HOUSEKEEPING);

    expect(result).toMatchObject({ error: expect.stringContaining('Denied by the owner') });
    expect(executed).toEqual([]);
    expect(asked.map((r) => r.executor)).toEqual(['device']);
  });

  test('a standing grant for that rule on that machine stops the asking', async () => {
    const asked: ShellApprovalRequest[] = [];

    const router = new DefaultExecutionRouter({
      mode: () => 'strict',
      granted: (g) => g.rule === 'rm-recursive' && g.executor === 'device',
      requestApproval: async (req) => {
        asked.push(req);

        return 'deny';
      },
    });

    const { provider, executed } = fakeShellProvider('device', 'device');
    router.register(provider);

    const device = present(router.getProvider('device'), 'the registered device provider');

    expect(await device.tools.exec.execute(HOUSEKEEPING)).toBe(`ran: ${HOUSEKEEPING}`);
    expect(executed).toEqual([HOUSEKEEPING]);
    expect(asked).toEqual([]);

    expect(await device.tools.exec.execute('sudo reboot')).toMatchObject({ error: expect.stringContaining('Denied by the owner') });
    expect(asked.map((r) => r.command)).toEqual(['sudo reboot']);
  });
});

/** A machine's project at /pc/proj, recording every file the shell removes from it. */
function deviceProject() {
  const files = new Map([['/proj/a.txt', 'A'], ['/proj/b.txt', 'B']]);
  const removed: string[] = [];
  const isDir = (path: string) => path === '/' || path === '' || path === '/proj';

  const stat = (path: string) => {
    if (isDir(path)) return { isDir: true, size: 0, mtimeMs: 0 };

    return files.has(path) ? { isDir: false, size: 1, mtimeMs: 0 } : null;
  };

  const device: VFS = {
    readFile: async (path) => new TextEncoder().encode(files.get(path) ?? ''),
    writeFile: async () => undefined,
    readdir: async (path) => (path === '/proj' ? [...files.keys()].map((file) => file.slice('/proj/'.length)) : ['proj']),
    stat: async (path) => stat(path),
    unlink: async (path) => {
      removed.push(path);
      files.delete(path);
    },
    mkdir: async () => undefined,
    exists: async (path) => isDir(path) || files.has(path),
  };

  return { device, removed };
}

/** The agent's own workspace shell serving a table with the user's machine at /pc, and a user who says no. */
function workspaceOverDevice() {
  const db = new Database(':memory:');
  const workspace = createWorkspaceBundle(db);
  const { device, removed } = deviceProject();
  const mounted = withMountTable(workspace.vfs, [{ name: 'pc', files: () => device, absentReason: () => 'no device', filesOwner: 'user' }]);
  workspace.mountTable(mounted);
  const asked: string[] = [];

  const shell = withApprovalGatedShell(workspace.shell, { filesOwner: 'agent', userRoots: () => mounted.userRoots(), home: WORKSPACE_ROOT, keepsCwd: true }, {
    mode: () => 'strict',
    requestApproval: async (request) => {
      asked.push(request.command);

      return 'deny';
    },
  });

  return { db, shell, asked, removed };
}

describe('a workspace shell over the user\'s mounts', () => {
  test('a command naming /pc is put to the user, while the same delete in the agent\'s home is not', async () => {
    const { db, shell, asked, removed } = workspaceOverDevice();

    try {
      expect((await shell.exec('rm -rf /pc/proj')).exitCode).not.toBe(0);
      expect((await shell.exec('mkdir -p scratch/x && rm -rf scratch')).exitCode).toBe(0);

      expect(asked).toEqual(['rm -rf /pc/proj']);
      expect(removed).toEqual([]);
    } finally {
      db.close();
    }
  });

  test('a session that went into /pc asks before deleting there, and stops asking once it is back home', async () => {
    const { db, shell, asked, removed } = workspaceOverDevice();

    try {
      expect((await shell.exec('cd /pc/proj')).exitCode).toBe(0);
      expect((await shell.exec('rm -rf .')).exitCode).not.toBe(0);
      expect((await shell.exec('cd ~')).exitCode).toBe(0);
      expect((await shell.exec('mkdir -p scratch/x && rm -rf scratch')).exitCode).toBe(0);

      expect(asked).toEqual(['rm -rf .']);
      expect(removed).toEqual([]);
    } finally {
      db.close();
    }
  });
});

/** The agent's own workspace executor over a table holding the user's machine and Drive, recording what it runs. */
function mountedWorkspaceProvider() {
  const ran: string[] = [];

  const record = (label: string) => async (...args: unknown[]) => {
    ran.push(`${label} ${String(args[0])}`);

    return 'ok';
  };

  const provider: ExecutorProvider = {
    name: 'workspace',
    kind: 'workspace',
    capabilities: new Set(['shell']),
    filesOwner: 'agent',
    userRoots: () => ['/pc', '/shared'],
    homeDir: async () => WORKSPACE_ROOT,
    isAvailable: () => true,
    connect: async () => {},
    disconnect: async () => {},
    tools: {
      startProcess: { description: 'Start a background process', execute: record('start') },
      runCode: { description: 'Run a program', execute: record('code') },
    },
  };

  return { provider, ran };
}

describe('codemode calls on a workspace over the user\'s mounts', () => {
  const DENIED = { error: expect.stringContaining('Denied by the owner') };

  test('a program reading the read-only skills view asks nobody, while one writing the user\'s machine asks', async () => {
    const { router, asked } = askingRouter();
    const db = new Database(':memory:');
    const workspace = createWorkspaceBundle(db);
    const { device } = deviceProject();

    const mounted = withMountTable(workspace.vfs, [
      skillsMount(() => workspace.vfs),
      { name: 'pc', files: () => device, absentReason: () => 'no device', filesOwner: 'user' },
    ]);

    router.register({ ...mountedWorkspaceProvider().provider, userRoots: () => mounted.userRoots() });
    const run = present(router.getProvider('workspace'), 'the workspace executor').tools.runCode;
    const write = "open('/pc/laptop/notes.txt', 'w').write('x')";

    try {
      expect(await run.execute("print(open('/skills/deploy/SKILL.md').read())", { language: 'python' })).toBe('ok');
      expect(await run.execute(write, { language: 'python' })).toMatchObject(DENIED);
      expect(asked.map((request) => request.command)).toEqual([write]);
    } finally {
      db.close();
    }
  });

  test('a background process started on the user\'s machine is put to them first', async () => {
    const { router, asked } = askingRouter();
    const { provider, ran } = mountedWorkspaceProvider();
    router.register(provider);
    const start = present(router.getProvider('workspace'), 'the workspace executor').tools.startProcess;

    expect(await start.execute('rm -rf build', { cwd: '/pc/laptop/proj' })).toMatchObject(DENIED);
    expect(await start.execute('rm -rf build')).toBe('ok');

    expect(asked.map((request) => request.command)).toEqual(['rm -rf build']);
    expect(ran).toEqual(['start rm -rf build']);
  });

  test('a shell program is reviewed as a shell command, and one in another language that names the user\'s files asks', async () => {
    const { router, asked } = askingRouter();
    const { provider, ran } = mountedWorkspaceProvider();
    router.register(provider);
    const run = present(router.getProvider('workspace'), 'the workspace executor').tools.runCode;
    const python = "import shutil; shutil.rmtree('/shared/notes')";

    expect(await run.execute('rm -rf /pc/laptop/proj', { language: 'shell' })).toMatchObject(DENIED);
    expect(await run.execute(python, { language: 'python' })).toMatchObject(DENIED);
    expect(await run.execute('rm -rf build', { language: 'shell' })).toBe('ok');
    expect(await run.execute("print('hi')", { language: 'python' })).toBe('ok');

    expect(asked.map((request) => request.command)).toEqual(['rm -rf /pc/laptop/proj', python]);
    expect(ran).toEqual(['code rm -rf build', "code print('hi')"]);
  });

  test('a move, copy or redirect onto the user\'s device or Drive asks, while the same write in the agent\'s home runs', async () => {
    const { router, asked } = askingRouter();
    const { provider, ran } = mountedWorkspaceProvider();
    router.register(provider);
    const start = present(router.getProvider('workspace'), 'the workspace executor').tools.startProcess;
    const onto = ['mv notes.md /shared/notes.md', 'cp -r build /pc/laptop/proj', 'echo done > /shared/status.txt', 'cp -t /pc/laptop a.txt b.txt'];

    for (const command of onto) expect(await start.execute(command)).toMatchObject(DENIED);

    for (const command of ['mv notes.md done.md', 'echo done >> /shared/log.txt', 'cp /shared/notes.md .']) expect(await start.execute(command)).toBe('ok');

    expect(asked.map((request) => request.command)).toEqual(onto);
    expect(ran).toEqual(['start mv notes.md done.md', 'start echo done >> /shared/log.txt', 'start cp /shared/notes.md .']);
  });

  test('a hosted node\'s shell, whose box starts every call at its home, reads each command from there', async () => {
    const asked: string[] = [];
    const ran: string[] = [];

    const shell = withApprovalGatedShell({
      exec: async (command) => {
        ran.push(command);

        return { stdout: '', stderr: '', exitCode: 0 };
      },
    }, { filesOwner: 'agent', userRoots: () => ['/pc'], home: '/home/agents/n1', keepsCwd: false }, {
      mode: () => 'strict',
      requestApproval: async (request) => {
        asked.push(request.command);

        return 'deny';
      },
    });

    for (const command of ['cd /pc/proj && ls', 'rm -rf build', 'cd sub && ls', 'rm -rf ../../../pc/x']) await shell.exec(command);

    expect(asked).toEqual(['rm -rf ../../../pc/x']);
    expect(ran).toEqual(['cd /pc/proj && ls', 'rm -rf build', 'cd sub && ls']);
  });
});
