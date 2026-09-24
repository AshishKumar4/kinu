/**
 * The executor-seam approval gate: a command gated via `shell` must also be gated via codemode
 * (`nimbus.exec`, `sandbox.exec`, `device.exec`). Fails if `ExecutionRouter.register()` stops gating.
 */
import { describe, test, expect } from 'bun:test';
import { DefaultExecutionRouter } from '../src/execution/router';
import { gateProviderExec } from '../src/execution/approval';
import type { ExecutorProvider } from '../src/execution/types';
import type { ShellApprovalPolicy, ShellApprovalRequest } from '../src/safety/approval-gate';
import { present } from '@kinu.run/test-utils';

const DENY = 'rm -rf /';

const GATE = 'sudo rm -rf /var/lib/important';

const ALLOW = 'echo hi';

/** A minimal ExecutorProvider shaped like nimbus/sandbox/device. */
function fakeShellProvider(name: string, kind: ExecutorProvider['kind'] = 'nimbus') {
  const executed: string[] = [];

  const provider: ExecutorProvider = {
    name,
    kind,
    capabilities: new Set(['shell']),
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
    const { provider, executed } = fakeShellProvider('sandbox', 'sandbox');
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

/** `gateProviderExec` passes `provider.name` into `gateExec`; these differ only in which machine the provider is. */
describe('the executor reaches the gate', () => {
  const HOUSEKEEPING = 'rm -rf node_modules';

  test("a recursive delete on the agent's own sandbox runs, unasked", async () => {
    const asked: ShellApprovalRequest[] = [];

    const router = new DefaultExecutionRouter({
      mode: () => 'strict',
      requestApproval: async (req) => {
        asked.push(req);

        return 'deny';
      },
    });

    const { provider, executed } = fakeShellProvider('sandbox', 'sandbox');
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
