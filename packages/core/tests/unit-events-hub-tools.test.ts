// Tool surface composition — pure function of (head_trust, phase, role).
import { describe, test, expect } from 'bun:test';
import {
  composeToolSurface, sandboxProfileFor, REACTOR_CONTROL_TOOLS, WORKER_TOOLS,
} from '../src/events/hub/index.ts';

describe('composeToolSurface — reactor', () => {
  test('reactor sees the fixed control set regardless of trust', () => {
    const owner = composeToolSurface({ head_trust: 'owner', phase: 'reactor', role: 'reactor' });
    const ext = composeToolSurface({ head_trust: 'external', phase: 'reactor', role: 'reactor' });
    expect(owner).toEqual(REACTOR_CONTROL_TOOLS);
    expect(ext).toEqual(REACTOR_CONTROL_TOOLS);
  });
});

describe('composeToolSurface — workers', () => {
  test('owner + linear gets the full set', () => {
    const tools = composeToolSurface({ head_trust: 'owner', phase: 'linear', role: 'worker' });
    expect(tools).toContain(WORKER_TOOLS.SCHEDULE_AT);
    expect(tools).toContain(WORKER_TOOLS.SEND_TO_AGENT);
    expect(tools).toContain(WORKER_TOOLS.SCAFFOLD_REWRITE);
  });

  test('owner + heads strips mutation tools (scaffold, fork, craft)', () => {
    const tools = composeToolSurface({ head_trust: 'owner', phase: 'heads', role: 'worker' });
    expect(tools).not.toContain(WORKER_TOOLS.SCAFFOLD_REWRITE);
    expect(tools).not.toContain(WORKER_TOOLS.FORK_AGENT);
    expect(tools).not.toContain(WORKER_TOOLS.CRAFT_TOOL);
    expect(tools).toContain(WORKER_TOOLS.SCHEDULE_AT);   // still allowed
  });

  test('owner + merging is read-only + reply', () => {
    const tools = composeToolSurface({ head_trust: 'owner', phase: 'merging', role: 'worker' });
    expect(tools).toContain(WORKER_TOOLS.REPLY);
    expect(tools).toContain(WORKER_TOOLS.RECENT_EVENTS);
    expect(tools).not.toContain(WORKER_TOOLS.SCHEDULE_AT);
    expect(tools).not.toContain(WORKER_TOOLS.SANDBOX_EXEC);
  });

  test('authenticated cannot scaffold_rewrite / fork / cross-owner / durable webhook', () => {
    const tools = composeToolSurface({ head_trust: 'authenticated', phase: 'linear', role: 'worker' });
    expect(tools).not.toContain(WORKER_TOOLS.SCAFFOLD_REWRITE);
    expect(tools).not.toContain(WORKER_TOOLS.FORK_AGENT);
    expect(tools).not.toContain(WORKER_TOOLS.SEND_TO_AGENT);
    expect(tools).not.toContain(WORKER_TOOLS.REGISTER_DURABLE_WEBHOOK);
    expect(tools).toContain(WORKER_TOOLS.SCHEDULE_AT);
    expect(tools).toContain(WORKER_TOOLS.SANDBOX_EXEC);
  });

  test('external is severely narrowed — no schedule, no register, no cross-owner, no scaffold', () => {
    const tools = composeToolSurface({ head_trust: 'external', phase: 'linear', role: 'worker' });
    expect(tools).toContain(WORKER_TOOLS.REPLY);
    expect(tools).toContain(WORKER_TOOLS.SANDBOX_EXEC);          // but network-off
    expect(tools).not.toContain(WORKER_TOOLS.SCHEDULE_AT);
    expect(tools).not.toContain(WORKER_TOOLS.SCHEDULE_CRON);
    expect(tools).not.toContain(WORKER_TOOLS.REGISTER_EPHEMERAL_WEBHOOK);
    expect(tools).not.toContain(WORKER_TOOLS.SEND_TO_AGENT);
    expect(tools).not.toContain(WORKER_TOOLS.MCP_INVOKE);
    expect(tools).not.toContain(WORKER_TOOLS.SCAFFOLD_REWRITE);
  });
});

describe('sandboxProfileFor', () => {
  test('owner gets full network + persistent fs', () => {
    expect(sandboxProfileFor('owner')).toEqual({
      network: 'on', fs: 'persistent', allow_arbitrary_cmd: true,
    });
  });
  test('external gets network off + ephemeral fs', () => {
    expect(sandboxProfileFor('external')).toEqual({
      network: 'off', fs: 'ephemeral', allow_arbitrary_cmd: true,
    });
  });
});
