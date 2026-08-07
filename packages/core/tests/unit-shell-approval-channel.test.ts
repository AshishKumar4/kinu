// The `run` tool's 'gate' decision used to be a dead end: under 'strict' it
// always returned an explanatory message because no approval channel existed.
// These tests pin the wired channel — who gets asked, what the answer does,
// and that the old message still stands when nobody is listening.
import { describe, test, expect } from 'bun:test';
import { buildBuiltinTools } from '../src/tools/builtins.js';
import { createTestRuntime } from './helpers.js';
import type { AgentRuntime } from '../src/types/agent-runtime.js';
import type { ShellApprovalRequest, ShellApprovalOutcome } from '../src/index.js';

type RunTool = { execute: (args: { command: string; runtime?: string }) => Promise<string> };

/** `sudo` is a 'gate' rule; plain `ls` is 'allow'. */
const GATED = 'sudo systemctl restart nginx';

function harness(opts: {
  mode?: 'strict' | 'allow_all' | 'deny_all';
  approve?: (req: ShellApprovalRequest) => Promise<ShellApprovalOutcome | null>;
}) {
  const { rt } = createTestRuntime();
  const executed: string[] = [];
  const shell = {
    exec: async (command: string) => {
      executed.push(command);
      return { stdout: 'ran', stderr: '', exitCode: 0 };
    },
  };
  const asked: ShellApprovalRequest[] = [];
  const tools = buildBuiltinTools({
    rt: { ...rt, shell } as AgentRuntime,
    ...(opts.mode ? { shellApprovalMode: opts.mode } : {}),
    ...(opts.approve
      ? {
          requestShellApproval: async (req: ShellApprovalRequest) => {
            asked.push(req);
            return opts.approve!(req);
          },
        }
      : {}),
  });
  return { run: tools.run as unknown as RunTool, executed, asked };
}

describe('run tool — interactive shell approval channel', () => {
  test('a gated command is put to the channel, and "allow" runs it', async () => {
    const { run, executed, asked } = harness({ approve: async () => 'allow' });

    const out = await run.execute({ command: GATED });

    expect(out).toBe('ran');
    expect(executed).toEqual([GATED]);
    // The channel sees the command and the review that explains the gate.
    expect(asked.length).toBe(1);
    expect(asked[0]!.command).toBe(GATED);
    expect(asked[0]!.review.decision).toBe('gate');
    expect(asked[0]!.review.hits.length).toBeGreaterThan(0);
  });

  test('"deny" reports the refusal to the model and never runs the command', async () => {
    const { run, executed } = harness({ approve: async () => 'deny' });

    const out = await run.execute({ command: GATED });

    expect(out).toContain('Denied by the user');
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

    const out = await run.execute({ command: GATED });

    expect(out).toContain('Requires user approval (mode=strict)');
    expect(executed).toEqual([]);
  });

  test('with no channel wired, strict keeps its explanatory refusal', async () => {
    const { run, executed } = harness({});

    const out = await run.execute({ command: GATED });

    expect(out).toContain('Requires user approval (mode=strict)');
    expect(executed).toEqual([]);
  });

  test('deny_all refuses without consulting the channel', async () => {
    const { run, executed, asked } = harness({ mode: 'deny_all', approve: async () => 'allow' });

    const out = await run.execute({ command: GATED });

    expect(out).toContain('Requires user approval (mode=deny_all)');
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
    // The channel is consulted for 'gate' only; this pins that boundary so a
    // reclassified rule cannot silently start or stop prompting the user.
    const { run, executed, asked } = harness({ approve: async () => 'deny' });

    const out = await run.execute({ command: 'printenv' });

    expect(asked).toEqual([]);
    expect(executed).toEqual(['printenv']);
    expect(out).toBe('ran');
  });
});
