// MCP connection establishment is scheduled by the SETTLED TURN, not by the
// descriptor read.
//
// Why this exists. `userMcp_toolDescriptors` is on the turn's critical path and
// therefore starts no network work and waits for none (proven in
// unit-user-mcp-lifecycle.test.ts). Establishment moved off the turn. The HTTP
// first-hit warmup (`user/routes.ts`) covers only the first INTERACTIVE turn:
// its gate is a module-level Set, one entry per user per Worker ISOLATE, so an
// alarm-woken, email-woken or peer-woken workspace never trips it, and after a
// UserDO eviction the flag is already spent. Without a turn-side trigger those
// turns would report every configured server unavailable forever.
//
// Two halves, because the failure modes are different in kind:
//   1. the lane's BEHAVIOUR — it calls the one UserDO authority, once, with this
//      actor's own capability; a failure is contained and the next settle retries;
//   2. the SCHEDULING — every settled turn schedules it, whatever the turn was
//      and whether or not its improvement lanes opened. A settle that simply
//      omits the call is a well-formed program, so it is driven and observed.
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

/**
 * An actor whose owner-UserDO binding RECORDS, with its capability gate held as
 * a real durable row.
 *
 * Nothing is asserted into shape and nothing protected is reached from outside:
 * the hub is the `env.UserDO` binding production resolves, the token is a row in
 * the table `workspaceCapabilityToken` selects from, and the lane is driven
 * through the harness seam the improvement-lanes effect already has one of.
 */
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

    // The caller is the workspace capability the row holds, resolved by the
    // production `userCaller()` rather than handed in by the test.
    expect(userPlane.warmConnections).toEqual([{ workspaceToken: 'harness-token' }]);
  });

  test('a failed warm is contained — nothing reaches the settled turn', async () => {
    const { harness, userPlane } = warmingActor({
      fail: new Error('the MCP server refused the connection'),
    });

    // Synchronous scheduling cannot turn a correct settled response into a
    // failure; the returned join observes the contained lane outcome.
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

    // The retry is the next settled turn, unconditionally. Nothing was stored
    // about the failure, and nothing had to be: the live connection is the
    // state, and a warm that already succeeded is idempotent inside UserDO.
    userPlane.failWarm = null;
    await harness.agent.harnessWarmUserMcp();
    expect(userPlane.warmConnections).toHaveLength(2);
  });

  test('an actor with no owner asks nothing', async () => {
    const { harness, userPlane } = warmingActor();
    // Unclaimed, as the durable table says it: `owner_user_id` is NOT NULL, so
    // an unowned workspace is one with NO identity row rather than a row with a
    // null owner. Deleting it is the real state, not an override of the reader.
    harness.db.prepare("DELETE FROM workspace_identity WHERE id = 'harness-actor'").run();

    await harness.agent.harnessWarmUserMcp();

    expect(userPlane.warmConnections).toEqual([]);
  });

  test('a claimed owner with no capability token yet asks nothing, and reports nothing', async () => {
    // The ordinary pre-provisioning state. Reaching the hub here would throw
    // inside the lane and file a failure diagnostic for a workspace that is
    // simply not connected yet — noise on every settled turn until it is. No
    // token row is written, which IS that state.
    const { harness, userPlane } = warmingActor({ holdsCapability: false });

    await harness.agent.harnessWarmUserMcp();

    expect(userPlane.warmConnections).toEqual([]);
  });
});

describe('every settled turn schedules the lane, whatever the turn was', () => {
  // Establishment is not an improvement lane. A plan turn, an aborted turn and a
  // failed turn all leave connections to establish for the NEXT turn, and all
  // three return early at the improvement-lane verdict — so the warm has to be
  // scheduled before that verdict is read. Driven through the real terminal
  // effect rather than read off the source, so a lane that stops being scheduled
  // fails here instead of a comment moving.
  const turnFor = (id: string): CompletedTurn => ({
    userMessage: 'q', assistantResponse: 'a', toolCalls: [], durationMs: 1, steps: 1,
    hadError: false, feedback: null, turnId: id, sessionId: 'default', origin: 'user',
  });

  test('a completed build turn warms', async () => {
    const { harness, userPlane } = warmingActor();
    await harness.agent.harnessSettleSpine({ status: 'completed', turn: turnFor('t-ok') });
    await joinHarnessFibers();
    expect(userPlane.warmConnections).toHaveLength(1);
  });

  test('an aborted turn warms — the next turn still needs its connections', async () => {
    const { harness, userPlane } = warmingActor();
    await harness.agent.harnessSettleSpine({ status: 'aborted', turn: turnFor('t-cut') });
    await joinHarnessFibers();
    expect(userPlane.warmConnections).toHaveLength(1);
  });

  test('a PLAN turn warms, though it opens no improvement lane', async () => {
    const { harness, userPlane } = warmingActor();
    await harness.agent.harnessSettleSpine({
      status: 'completed', turn: turnFor('t-plan'), workMode: 'plan',
    });
    await joinHarnessFibers();
    expect(userPlane.warmConnections).toHaveLength(1);
  });

  test('the descriptor read is not where establishment lives', () => {
    // The regression this whole split exists to prevent: hydrating on the read
    // awaited an unbounded `_connectWithRetry` on the turn's critical path.
    const source = readFileSync(join(import.meta.dir, '..', 'src', 'actor-agent.ts'), 'utf8');
    const read = memberBody(source, 'private async buildUserMcpTools(nativeTools: ToolSet)', 'actor-agent.ts');
    expect(read).not.toContain('userMcp_warmConnections');
    expect(read).toContain('userMcp_toolDescriptors');
  });
});
