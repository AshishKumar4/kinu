// Defends: alarm/email/peer-woken turns reporting every MCP server unavailable. The HTTP first-hit
// warmup gate is per Worker isolate, so every settled turn must schedule establishment. Driven through
// real settled turns; observed at the UserDO binding the object calls.
import { describe, expect, test } from 'bun:test';
import {
  chatSessionTurns, improvementLanesRan, orchestratorHarness, tapDiagnostics, until,
  type ActorHarness, type HarnessOrchestratorAgent, type RecordedUserPlaneCalls,
} from './helpers/actor-harness';
import type { ScriptedAnswer } from './helpers/turn-harness';
import { createRecordingLogger, type RecordedLog } from '@kinu.run/core/obs';

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

/** One turn settled through the chat loop, its warm opportunity passed, and the fibers it began joined. */
async function settleTurn(
  harness: ActorHarness<HarnessOrchestratorAgent>,
  answer: ScriptedAnswer = { messageId: 'a-warm', text: 'done' },
): Promise<void> {
  const { messageId } = await chatSessionTurns(harness.agent).settle(answer);
  await until(() => improvementLanesRan(harness.db, messageId), `the improvement lanes of ${messageId} ran`);
  // A rejected warm reports from its catch, a macrotask after the fiber body settles.
  await Bun.sleep(0);
}

/** Records diagnostics across `body`; `endsOn` names an event whose arrival ends the recording. */
async function recordDiagnostics(body: () => Promise<void>, endsOn?: string): Promise<readonly RecordedLog[]> {
  const logger = createRecordingLogger();
  const restore = tapDiagnostics(logger);

  try {
    await body();

    if (endsOn !== undefined) {
      await until(() => logger.emitted.some((line) => line.event === endsOn), `${endsOn} was reported`);
    }

    return logger.emitted;
  } finally {
    restore();
  }
}

describe('the settled turn warms the next turn’s MCP connections', () => {
  test('one settle asks the one UserDO authority exactly once, with this actor’s caller', async () => {
    const { harness, userPlane } = warmingActor();

    await settleTurn(harness);

    // Resolved by the production `userCaller()`, not handed in.
    expect(userPlane.warmConnections).toEqual([{ workspaceToken: 'harness-token' }]);
  });

  test('a failed warm is contained — the turn still settles', async () => {
    const { harness, userPlane } = warmingActor({
      fail: new Error('the MCP server refused the connection'),
    });

    const logs = await recordDiagnostics(async () => { await settleTurn(harness); }, 'mcp.settle_warmup_failed');

    expect(logs.map((line) => line.event)).toContain('mcp.settle_warmup_failed');
    expect(userPlane.warmConnections).toHaveLength(1);
    expect((await harness.agent.listRuns()).items).toHaveLength(1);
  });

  test('the next settle retries — a failure needs no record to be retryable', async () => {
    const { harness, userPlane } = warmingActor({ fail: new Error('connection refused') });

    const logs = await recordDiagnostics(async () => { await settleTurn(harness); }, 'mcp.settle_warmup_failed');

    expect(logs.map((line) => line.event)).toContain('mcp.settle_warmup_failed');
    expect(userPlane.warmConnections).toHaveLength(1);

    // Nothing is stored about the failure: the live connection is the state, and warm is idempotent.
    userPlane.failWarm = null;
    await settleTurn(harness, { messageId: 'a-warm-again', text: 'done again' });
    expect(userPlane.warmConnections).toHaveLength(2);
  });

  test('a claimed owner with no capability token yet asks nothing, and reports nothing', async () => {
    // Reaching the hub here would file a failure diagnostic on every turn until provisioned.
    const { harness, userPlane } = warmingActor({ holdsCapability: false });

    const logs = await recordDiagnostics(async () => { await settleTurn(harness); });

    expect(userPlane.warmConnections).toEqual([]);
    expect(logs.map((line) => line.event)).not.toContain('mcp.settle_warmup_failed');

    // The same settle, once provisioned, does ask: the silence above was the missing token.
    harness.agent.harnessHoldsCapability('harness-token');
    await settleTurn(harness, { messageId: 'a-provisioned', text: 'done' });
    expect(userPlane.warmConnections).toEqual([{ workspaceToken: 'harness-token' }]);
  });
});

describe('every settled turn schedules the lane, whatever the turn was', () => {
  // Plan, aborted and failed turns return early at the improvement-lane verdict, so the warm is
  // scheduled before it.
  test('a completed build turn warms', async () => {
    const { harness, userPlane } = warmingActor();
    await settleTurn(harness, { messageId: 't-ok', text: 'done' });
    expect(userPlane.warmConnections).toHaveLength(1);
  });

  test('an aborted turn warms — the next turn still needs its connections', async () => {
    const { harness, userPlane } = warmingActor();
    await settleTurn(harness, { messageId: 't-cut', status: 'aborted' });
    expect(userPlane.warmConnections).toHaveLength(1);
  });

  test('a PLAN turn warms, though it opens no improvement lane', async () => {
    const { harness, userPlane } = warmingActor();
    harness.agent.harnessDrivingUserMessage('Plan it first.', { kinuMode: 'plan' });
    await settleTurn(harness, { messageId: 't-plan', text: 'the plan' });
    expect(userPlane.warmConnections).toHaveLength(1);
  });

  test('the descriptor read is not where establishment lives', async () => {
    // Hydrating on the read awaited an unbounded `_connectWithRetry` on the critical path.
    const { harness, userPlane } = warmingActor();

    await chatSessionTurns(harness.agent).prepare({ messages: [{ role: 'user', content: 'use my tools' }] });

    expect(userPlane.descriptorReads ?? 0).toBeGreaterThan(0);
    expect(userPlane.warmConnections).toEqual([]);
  });
});
