// Defends: alarm/email/peer-woken turns reporting every MCP server unavailable. The HTTP first-hit
// warmup gate is per Worker isolate, so every settled turn must schedule establishment.
import { describe, expect, test } from 'bun:test';
import { memberBody } from '@kinu.run/test-utils';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { joinHarnessFibers } from './helpers/agents-sdk';
import { orchestratorHarness, type RecordedUserPlaneCalls } from './helpers/actor-harness';
import type { CompletedTurn } from '@kinu.run/core';
import {
  createRecordingLogger, setDiagnosticsSink, type RecordedLog,
} from '@kinu.run/core/obs';
import {} from '../src/fiber-recovery';

/** The real `env.UserDO` binding and capability-token row, driven through the harness seam. */
function warmingActor(behaviour: { holdsCapability?: boolean; fail?: Error } = {}) {
  const userPlane: RecordedUserPlaneCalls = {
    warmConnections: [],
    failWarm: behaviour.fail ?? null,
    titles: [],
  };

  const harness = orchestratorHarness(userPlane);

  if (behaviour.holdsCapability === false) harness.agent.harnessHoldsNoCapability();
  else harness.agent.harnessHoldsCapability('harness-token');

  return { harness, userPlane };
}

async function recordDiagnostics(body: () => Promise<void>): Promise<readonly RecordedLog[]> {
  const logger = createRecordingLogger();
  const restore = setDiagnosticsSink(logger);

  try {
    await body();

    return logger.emitted;
  } finally {
    restore();
  }
}

describe('the settled turn warms the next turn’s MCP connections', () => {
  test('one settle asks the one UserDO authority exactly once, with this actor’s caller', async () => {
    const { harness, userPlane } = warmingActor();

    await harness.agent.harnessWarmUserMcp();

    // Resolved by the production `userCaller()`, not handed in.
    expect(userPlane.warmConnections).toEqual([{ workspaceToken: 'harness-token' }]);
  });

  test('a failed warm is contained — nothing reaches the settled turn', async () => {
    const { harness, userPlane } = warmingActor({
      fail: new Error('the MCP server refused the connection'),
    });

    const logs = await recordDiagnostics(
      async () => await harness.agent.harnessWarmUserMcp(),
    );

    expect(logs.map((line) => line.event)).toContain('mcp.settle_warmup_failed');
    expect(userPlane.warmConnections).toHaveLength(1);
  });

  test('the next settle retries — a failure needs no record to be retryable', async () => {
    const { harness, userPlane } = warmingActor({ fail: new Error('connection refused') });

    const logs = await recordDiagnostics(
      async () => await harness.agent.harnessWarmUserMcp(),
    );

    expect(logs.map((line) => line.event)).toContain('mcp.settle_warmup_failed');
    expect(userPlane.warmConnections).toHaveLength(1);

    // Nothing is stored about the failure: the live connection is the state, and warm is idempotent.
    userPlane.failWarm = null;
    await harness.agent.harnessWarmUserMcp();
    expect(userPlane.warmConnections).toHaveLength(2);
  });

  test('an actor with no owner asks nothing', async () => {
    const { harness, userPlane } = warmingActor();
    // `owner_user_id` is NOT NULL, so unowned means no identity row; a cold activation drops the memo.
    harness.db.prepare("DELETE FROM workspace_identity WHERE id = 'harness-actor'").run();
    harness.agent.forgetActivationLatches();

    await harness.agent.harnessWarmUserMcp();

    expect(userPlane.warmConnections).toEqual([]);
  });

  test('a claimed owner with no capability token yet asks nothing, and reports nothing', async () => {
    // Reaching the hub here would file a failure diagnostic on every turn until provisioned.
    const { harness, userPlane } = warmingActor({ holdsCapability: false });

    await harness.agent.harnessWarmUserMcp();

    expect(userPlane.warmConnections).toEqual([]);
  });
});

describe('every settled turn schedules the lane, whatever the turn was', () => {
  // Plan, aborted and failed turns return early at the improvement-lane verdict, so the warm is
  // scheduled before it. Driven through the real terminal effect.
  const turnFor = (id: string): CompletedTurn => ({
    userMessage: 'q', assistantResponse: 'a', toolCalls: [], durationMs: 1, steps: 1,
    hadError: false, feedback: null, turnId: id, sessionId: 'default', origin: 'user',
  });

  const settles = [
    { name: 'a completed build turn warms', status: 'completed', turnId: 't-ok', workMode: undefined },
    {
      name: 'an aborted turn warms — the next turn still needs its connections',
      status: 'aborted', turnId: 't-cut', workMode: undefined,
    },
    {
      name: 'a PLAN turn warms, though it opens no improvement lane',
      status: 'completed', turnId: 't-plan', workMode: 'plan',
    },
  ] as const;

  for (const { name, status, turnId, workMode } of settles) {
    test(name, async () => {
      const { harness, userPlane } = warmingActor();
      await harness.agent.harnessSettleSpine({ status, turn: turnFor(turnId), workMode });
      await joinHarnessFibers();
      expect(userPlane.warmConnections).toHaveLength(1);
    });
  }

  test('the descriptor read is not where establishment lives', () => {
    // Hydrating on the read awaited an unbounded `_connectWithRetry` on the critical path.
    const source = readFileSync(join(import.meta.dir, '..', 'src', 'actor-agent.ts'), 'utf8');
    const read = memberBody(source, 'private async buildUserMcpTools(nativeTools: ToolSet)', 'actor-agent.ts');
    expect(read).not.toContain('userMcp_warmConnections');
    expect(read).toContain('userMcp_toolDescriptors');
  });
});
