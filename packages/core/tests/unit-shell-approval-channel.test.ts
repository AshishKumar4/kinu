// `shell`'s 'gate' decision over a real approval channel; with none wired, 'strict' still refuses.
// The gate lives at the execution seam (execution/approval.ts), so the harness wraps `rt.shell`.
import { describe, test, expect } from 'bun:test';
import { toolExecute } from '@kinu.run/test-utils';
import { buildBuiltinTools } from '../src/tools/builtins';
import { createTestRuntime, storesFor } from './helpers';
import type { AgentRuntime } from '../src/types/agent-runtime';
import {
  withApprovalGatedShell,
  type ShellApprovalRequest, type ShellApprovalOutcome, type ShellApprovalPolicy,
} from '../src/index';

type RunTool = { execute: (args: { command: string; runtime?: string }) => Promise<string> };

/** Gated even on the agent's own workspace: a force-push lands on a remote. */
const GATED = 'git push --force origin main';

function harness(opts: {
  mode?: 'strict' | 'allow_all' | 'deny_all';
  approve?: (req: ShellApprovalRequest) => Promise<ShellApprovalOutcome | null>;
}) {
  const { rt } = createTestRuntime();
  const executed: string[] = [];

  const rawShell = {
    exec: async (command: string) => {
      executed.push(command);

      return { stdout: 'ran', stderr: '', exitCode: 0 };
    },
  };

  const asked: ShellApprovalRequest[] = [];

  const policy: ShellApprovalPolicy = {
    mode: () => opts.mode ?? 'strict',
  };

  if (opts.approve) {
    const approve = opts.approve;
    policy.requestApproval = async (req: ShellApprovalRequest) => {
        asked.push(req);

        return approve(req);
      };
  }

  const shell = withApprovalGatedShell(rawShell, { filesOwner: 'agent' }, policy);
  const runtime: AgentRuntime = { ...rt, shell };
  const tools = buildBuiltinTools({ rt: runtime, history: storesFor(runtime).history });

  const run: RunTool = {
    execute: toolExecute<{ command: string; runtime?: string }, string>(tools.shell),
  };

  return { run, executed, asked };
}

describe('run tool — interactive shell approval channel', () => {
  test('a gated command is put to the channel, and "allow" runs it', async () => {
    const { run, executed, asked } = harness({ approve: async () => 'allow' });

    const out = await run.execute({ command: GATED });

    expect(out).toBe('ran');
    expect(executed).toEqual([GATED]);
    expect(asked.length).toBe(1);
    expect(asked[0].command).toBe(GATED);
    expect(asked[0].review.decision).toBe('gate');
    expect(asked[0].review.hits.length).toBeGreaterThan(0);
  });

  test('"deny" reports the refusal to the model and never runs the command', async () => {
    const { run, executed } = harness({ approve: async () => 'deny' });

    await expect(run.execute({ command: GATED })).rejects.toMatchObject({ code: 'denied', message: expect.stringContaining('Denied by the owner') });
    expect(executed).toEqual([]);
  });

  test('an ungated command never reaches the channel', async () => {
    const { run, executed, asked } = harness({ approve: async () => 'deny' });

    const out = await run.execute({ command: 'ls -la' });

    expect(out).toBe('ran');
    expect(executed).toEqual(['ls -la']);
    expect(asked).toEqual([]);
  });

  test('a channel that declines to decide leaves the standing mode in force', async () => {
    const { run, executed } = harness({ approve: async () => null });

    await expect(run.execute({ command: GATED })).rejects.toMatchObject({ code: 'unavailable', message: expect.stringContaining('needs owner approval, nobody to ask') });
    expect(executed).toEqual([]);
  });

  test('with no channel wired, strict keeps its explanatory refusal', async () => {
    const { run, executed } = harness({});

    await expect(run.execute({ command: GATED })).rejects.toMatchObject({ code: 'unavailable', message: expect.stringContaining('needs owner approval, nobody to ask') });
    expect(executed).toEqual([]);
  });

  test('deny_all refuses without consulting the channel', async () => {
    const { run, executed, asked } = harness({ mode: 'deny_all', approve: async () => 'allow' });

    await expect(run.execute({ command: GATED })).rejects.toMatchObject({ code: 'denied', message: expect.stringContaining('refused by standing policy (deny_all)') });
    expect(executed).toEqual([]);
    expect(asked).toEqual([]);
  });

  test('allow_all runs a gated command without consulting the channel', async () => {
    const { run, executed, asked } = harness({ mode: 'allow_all', approve: async () => 'deny' });

    const out = await run.execute({ command: GATED });

    expect(out).toBe('ran');
    expect(executed).toEqual([GATED]);
    expect(asked).toEqual([]);
  });

  test('a merely "warn" command runs without consulting the channel', async () => {
    // Only 'gate' consults the channel.
    const { run, executed, asked } = harness({ approve: async () => 'deny' });

    const out = await run.execute({ command: 'printenv' });

    expect(asked).toEqual([]);
    expect(executed).toEqual(['printenv']);
    expect(out).toBe('ran');
  });
});
