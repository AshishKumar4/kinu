/**
 * Regression coverage for the executor-seam approval gate — the fix for the
 * bypass where `run { command: "rm -rf /x" }` was gated but the identical
 * command reached through codemode (`nimbus.exec(...)`, `sandbox.exec(...)`,
 * `laptop.exec(...)`) was not, because the gate lived inside the `run` TOOL's
 * own executor instead of at the boundary every path actually shares.
 *
 * These tests exercise `gateProviderExec` and `DefaultExecutionRouter`
 * directly — the ACTUAL new seam — independent of any tool/backend wiring,
 * so they fail immediately if `ExecutionRouter.register()` stops gating (the
 * bypass reopens) regardless of how `run`/`execute_tools` are built on top.
 *
 * Revert-proof: temporarily reverting `register()` to
 * `this.providers.set(provider.name, provider)` (dropping the
 * `gateProviderExec` call) turns every "closes the bypass" test below red —
 * verified by hand while writing this file.
 */
import { describe, test, expect } from 'bun:test';
import { DefaultExecutionRouter } from '../src/execution/router.js';
import { gateProviderExec } from '../src/execution/approval.js';
import type { ExecutorProvider } from '../src/execution/types.js';
import type { ShellApprovalPolicy, ShellApprovalRequest, ShellApprovalOutcome } from '../src/safety/approval-gate.js';

const DENY = 'rm -rf /';
const GATE = 'sudo rm -rf /var/lib/important';
const ALLOW = 'echo hi';

/** A minimal ExecutorProvider shaped like nimbus/sandbox/laptop — a real
 *  shell reachable through codemode's `<name>.exec()` namespace. */
function fakeShellProvider(name: string, kind: ExecutorProvider['kind'] = 'nimbus'): {
  provider: ExecutorProvider;
  executed: string[];
} {
  const executed: string[] = [];
  const provider: ExecutorProvider = {
    name,
    kind,
    capabilities: new Set(['shell']),
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
    const result = await gated.tools.exec!.execute(DENY);
    expect(String(result)).toContain('Denied by approval gate');
    expect(executed).toEqual([]);
  });

  test('a gate-tier command with no approver wired is refused, not silently allowed', async () => {
    const { provider, executed } = fakeShellProvider('sandbox', 'sandbox');
    const gated = gateProviderExec(provider, strictNoChannelPolicy());
    const result = await gated.tools.exec!.execute(GATE);
    expect(String(result)).toContain('Requires user approval');
    expect(executed).toEqual([]);
  });

  test('allow_all lets a gate-tier command through', async () => {
    const { provider, executed } = fakeShellProvider('laptop', 'laptop');
    const gated = gateProviderExec(provider, { mode: () => 'allow_all' });
    const result = await gated.tools.exec!.execute(GATE);
    expect(String(result)).toBe(`ran: ${GATE}`);
    expect(executed).toEqual([GATE]);
  });

  test('an allow-tier command runs normally, ungated', async () => {
    const { provider, executed } = fakeShellProvider('nimbus');
    const gated = gateProviderExec(provider, strictNoChannelPolicy());
    const result = await gated.tools.exec!.execute(ALLOW);
    expect(String(result)).toBe(`ran: ${ALLOW}`);
    expect(executed).toEqual([ALLOW]);
  });

  test("nimbus's backgrounded startProcess is gated the same as exec — not a second, forgotten door", async () => {
    const { provider, executed } = fakeShellProvider('nimbus');
    const gated = gateProviderExec(provider, strictNoChannelPolicy());
    const result = await gated.tools.startProcess!.execute(DENY);
    expect(String(result)).toContain('Denied by approval gate');
    expect(executed).toEqual([]);
  });

  test('a VFS-shaped tool (readFile) is left completely untouched — not every tool is a shell command', async () => {
    const { provider } = fakeShellProvider('nimbus');
    const gated = gateProviderExec(provider, strictNoChannelPolicy());
    expect(gated.tools.readFile!.execute).toBe(provider.tools.readFile!.execute);
  });

  test('the workspace provider is left unwrapped — its Shell is gated at the source instead (withApprovalGatedShell), so wrapping here would review the command twice', async () => {
    const { provider } = fakeShellProvider('workspace', 'workspace');
    const gated = gateProviderExec(provider, strictNoChannelPolicy());
    expect(gated).toBe(provider);
    expect(gated.tools.exec!.execute).toBe(provider.tools.exec!.execute);
  });

  test('re-gating an already-gated provider is a no-op — idempotent against the same object crossing two routers', async () => {
    const { provider, executed } = fakeShellProvider('laptop', 'laptop');
    const askedFirst: ShellApprovalRequest[] = [];
    const firstPolicy: ShellApprovalPolicy = {
      mode: () => 'strict',
      requestApproval: async (req) => { askedFirst.push(req); return 'allow'; },
    };
    const gatedOnce = gateProviderExec(provider, firstPolicy);

    // Simulate a second router (e.g. a CLI head reusing the parent's laptop
    // provider verbatim — see cli-backend/runtime.ts buildCLIHeadRuntime)
    // gating the ALREADY-gated provider again with a DIFFERENT policy.
    const askedSecond: ShellApprovalRequest[] = [];
    const secondPolicy: ShellApprovalPolicy = {
      mode: () => 'strict',
      requestApproval: async (req) => { askedSecond.push(req); return 'deny'; },
    };
    const gatedTwice = gateProviderExec(gatedOnce, secondPolicy);

    expect(gatedTwice.tools.exec!.execute).toBe(gatedOnce.tools.exec!.execute);

    const result = await gatedTwice.tools.exec!.execute(GATE);
    // The FIRST policy answered (allow) — the second router's policy was
    // never consulted, and the command ran exactly once.
    expect(String(result)).toBe(`ran: ${GATE}`);
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

    // This is EXACTLY the call codemode's `nimbus.exec("rm -rf /x")` makes —
    // the router hands the LLM sandbox this same tools.exec.execute.
    const result = await router.getProvider('nimbus')!.tools.exec!.execute(DENY);
    expect(String(result)).toContain('Denied by approval gate');
    expect(executed).toEqual([]);
  });

  test('BUG REPRO: getProviders() — what execute_tools is actually built from on both backends — returns the gated tool too', async () => {
    const router = new DefaultExecutionRouter(strictNoChannelPolicy());
    const { provider, executed } = fakeShellProvider('sandbox', 'sandbox');
    router.register(provider);

    const fromGetProviders = router.getProviders().find((p) => p.name === 'sandbox');
    expect(fromGetProviders).toBeDefined();
    const result = await fromGetProviders!.tools.exec!.execute(DENY);
    expect(String(result)).toContain('Denied by approval gate');
    expect(executed).toEqual([]);
  });

  test('an allowed command still runs, through either accessor', async () => {
    const router = new DefaultExecutionRouter(strictNoChannelPolicy());
    const { provider, executed } = fakeShellProvider('laptop', 'laptop');
    router.register(provider);

    await router.getProvider('laptop')!.tools.exec!.execute(ALLOW);
    await router.getProviders()[0]!.tools.exec!.execute(ALLOW);
    expect(executed).toEqual([ALLOW, ALLOW]);
  });

  test('no policy supplied still gates — the default is strict/no-channel, never "ungated"', async () => {
    const router = new DefaultExecutionRouter(); // no policy argument at all
    const { provider, executed } = fakeShellProvider('nimbus');
    router.register(provider);

    const result = await router.getProvider('nimbus')!.tools.exec!.execute(DENY);
    expect(String(result)).toContain('Denied by approval gate');
    expect(executed).toEqual([]);
  });

  test('the workspace provider passes through the router untouched (gated upstream via withApprovalGatedShell instead)', async () => {
    const router = new DefaultExecutionRouter(strictNoChannelPolicy());
    const { provider } = fakeShellProvider('workspace', 'workspace');
    router.register(provider);
    expect(router.getProvider('workspace')!.tools.exec!.execute).toBe(provider.tools.exec!.execute);
  });

  test('a live mode change takes effect on the very next call — no re-registration needed', async () => {
    let mode: 'strict' | 'allow_all' | 'deny_all' = 'strict';
    const router = new DefaultExecutionRouter({ mode: () => mode });
    const { provider, executed } = fakeShellProvider('nimbus');
    router.register(provider);

    const denied = await router.getProvider('nimbus')!.tools.exec!.execute(GATE);
    expect(String(denied)).toContain('Requires user approval');
    expect(executed).toEqual([]);

    mode = 'allow_all';
    const allowed = await router.getProvider('nimbus')!.tools.exec!.execute(GATE);
    expect(String(allowed)).toBe(`ran: ${GATE}`);
    expect(executed).toEqual([GATE]);
  });
});
