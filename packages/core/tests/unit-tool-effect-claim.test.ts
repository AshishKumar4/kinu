/**
 * The once-only boundary in front of a tool whose effects leave the process.
 *
 * KINU-019: a turn's durable record of a tool call is written AFTER the call —
 * the `tool_call_end` event and the assistant message both land once it is
 * over — so a reset in between left no trace that the call was attempted, and
 * recovery replayed the provider response that asked for it. The effect
 * happened twice and nothing in the workspace could tell.
 *
 * Driven through the real wrapper over real SQL, because the claim IS the row:
 * a fixture store would prove things about the fixture.
 */
import { describe, expect, test } from 'bun:test';
import { createTestSql, toolExecute } from '@kinu.run/test-utils';
import { jsonSchema, tool } from 'ai';
import {
  claimToolEffect, initToolEffectClaimTable, releaseTurnEffectClaims, settleToolEffect,
  withEffectClaims, replayPolicyFor, parseRefusal, type EffectClaimDeps, type JsonValue,
} from '../src/index';

/** A workspace's claim table over a real SQLite, plus the deps the wrapper
 *  reads. `turnId` is mutable so a test can move to the next turn. */
function claimPlane(turnId = 'turn-1') {
  const { sql, execRaw } = createTestSql();
  initToolEffectClaimTable(execRaw);
  const scope = { turnId };
  const deps: EffectClaimDeps = { sql, turnId: () => scope.turnId };
  return { sql, deps, scope };
}

/** The effectful tool's input, in the same `jsonSchema<T>` form every tool in
 *  this runtime is declared with (tools/builtins.ts, cf-backend's MCP adapters,
 *  unit-tools.test.ts). It is what makes `tool()` infer INPUT: a schema handed in
 *  through the StandardSchema branch of `FlexibleSchema` has no inference site
 *  outside the conditional that gates `execute`, so every overload fails and the
 *  compiler reports the last one against `FlexibleSchema<never>`.
 *
 *  Shared by the two tools below because they are the SAME call — one counts its
 *  effects and one dies mid-effect — and a claim is keyed on the digest of these
 *  arguments, so two spellings of the input would be two experiments. */
const RECIPIENT_SCHEMA = jsonSchema<{ to: string }>({
  type: 'object', properties: { to: { type: 'string' } }, required: ['to'],
});

/** What a settled send answers. `attempt` is the counter, so a REPLAY returning
 *  the stored answer is distinguishable from a second run. */
interface SendResult {
  readonly sent: string;
  readonly attempt: number;
}

/** One tool that counts how many times its effect ran and returns a distinct
 *  answer each time, so a replayed result is distinguishable from a re-run. */
function countingTool() {
  const calls: string[] = [];
  const entry = tool({
    description: 'send the invoice',
    inputSchema: RECIPIENT_SCHEMA,
    execute: async (input: { to: string }): Promise<SendResult> => {
      calls.push(input.to);
      return { sent: input.to, attempt: calls.length };
    },
  });
  return { calls, tools: { run: entry } };
}

const OPTIONS = { toolCallId: 'call-a1', messages: [] };

describe('tool effect claims', () => {
  test('a claimed tool runs once and its replay returns the stored result', async () => {
    const { deps } = claimPlane();
    const { calls, tools } = countingTool();
    const execute = toolExecute<{ to: string }, JsonValue>(withEffectClaims(tools, deps).run);

    const first = await execute({ to: 'ops@example.test' }, OPTIONS);
    // The SAME call replayed: same turn, same provider call id, same arguments.
    const replayed = await execute({ to: 'ops@example.test' }, OPTIONS);

    expect(calls).toEqual(['ops@example.test']);
    expect(replayed).toEqual(first);
  });

  test('a claim whose outcome was never recorded refuses instead of repeating', async () => {
    const { deps } = claimPlane();
    const tools = {
      run: tool({
        description: 'send the invoice',
        inputSchema: RECIPIENT_SCHEMA,
        // The SAME declared result as `countingTool`'s, spelled because an
        // `execute` that only ever throws infers OUTPUT `never`, and a tool with
        // output `never` is typed as a tool with NO execute. The declaration is
        // the honest one: this send would have answered like the other, and dies
        // mid-flight instead.
        execute: async (): Promise<SendResult> => {
          throw new Error('the connection dropped mid-send');
        },
      }),
    };
    const execute = toolExecute<{ to: string }, JsonValue>(withEffectClaims(tools, deps).run);

    // The first attempt claimed the effect and then died without settling: from
    // here on, whether it landed is genuinely unknown.
    await expect(execute({ to: 'ops@example.test' }, OPTIONS)).rejects.toThrow('connection dropped');

    const replayed = await execute({ to: 'ops@example.test' }, OPTIONS);

    const refusal = parseRefusal(String(replayed));
    expect(refusal?.reason).toBe('denied');
    expect(refusal?.error).toContain('never recorded');
  });

  test('a different call in the same turn is not a replay', async () => {
    const { deps } = claimPlane();
    const { calls, tools } = countingTool();
    const execute = toolExecute<{ to: string }, JsonValue>(withEffectClaims(tools, deps).run);

    await execute({ to: 'a@example.test' }, OPTIONS);
    // Same turn, same call id, DIFFERENT arguments — a distinct effect, and the
    // digest is what says so.
    await execute({ to: 'b@example.test' }, OPTIONS);
    // Same arguments, different provider call id — also distinct.
    await execute({ to: 'a@example.test' }, { ...OPTIONS, toolCallId: 'call-a2' });

    expect(calls).toEqual(['a@example.test', 'b@example.test', 'a@example.test']);
  });

  test('the row is keyed on the identity the caller supplied, never an invented one', async () => {
    // The two identity columns ARE the caller's: the durable turn id from the
    // deps, and the provider's own id for the call out of the `options` the AI
    // SDK hands every tool (`ai/dist/index.mjs` builds
    // `{toolCallId, messages, abortSignal, experimental_context}` at the tool
    // runner and `toolCallId` comes off the provider's tool call).
    //
    // Asserted because the wrapper reads `options.toolCallId` unguarded, and the
    // tempting repair for a caller that passes no options is a default id. That
    // would key two different calls the same way and replay one as the other,
    // which is the exact effect-duplication the claim exists to prevent — so the
    // identity is pinned here rather than left to the read paths above, which
    // pass whatever they are given and cannot tell a real id from a filled-in one.
    const { sql, deps } = claimPlane('turn-7');
    const { tools } = countingTool();
    const execute = toolExecute<{ to: string }, JsonValue>(withEffectClaims(tools, deps).run);

    await execute({ to: 'ops@example.test' }, { toolCallId: 'call-from-provider', messages: [] });

    expect(sql`SELECT turn_id, normalized_call_id FROM tool_effect_claims`)
      .toEqual([{ turn_id: 'turn-7', normalized_call_id: 'call-from-provider' }]);
  });

  test('a released turn no longer replays, because its answer is durable', async () => {
    const { sql, deps, scope } = claimPlane();
    const { calls, tools } = countingTool();
    const execute = toolExecute<{ to: string }, JsonValue>(withEffectClaims(tools, deps).run);

    await execute({ to: 'ops@example.test' }, OPTIONS);
    releaseTurnEffectClaims(sql, scope.turnId);
    // A LATER turn asking for the same thing is new work, not a replay.
    scope.turnId = 'turn-2';
    await execute({ to: 'ops@example.test' }, OPTIONS);

    expect(calls).toHaveLength(2);
  });

  test('a safe tool is untouched: no wrapper, no row', async () => {
    const { sql, deps } = claimPlane();
    const entry = tool({
      description: 'search the web',
      inputSchema: jsonSchema<{ q: string }>({
        type: 'object', properties: { q: { type: 'string' } }, required: ['q'],
      }),
      execute: async () => ({ hits: 0 }),
    });
    const wrapped = withEffectClaims({ web: entry }, deps);

    expect(replayPolicyFor('web')).toBe('safe');
    expect(wrapped.web).toBe(entry);

    await toolExecute<{ q: string }, { hits: number }>(wrapped.web)({ q: 'anything' }, OPTIONS);
    expect(sql`SELECT turn_id FROM tool_effect_claims`).toEqual([]);
  });

  // ── The interleaving, which the tests above cannot reach ──────────────────
  //
  // Every test above observes the FINAL state: the row exists after the call
  // returned, the counter says one, the replay answered. None of them can tell
  // claim-before-effect from effect-before-claim, because both orders leave the
  // same final state. Moving `claimToolEffect` below `await execute(...)` in
  // `effect-claim.ts` keeps all of them green, and that reordering IS KINU-019.
  //
  // So this one stops the world at the transition. The effect is held open with
  // a deferred promise, which is the window a reset actually lands in, and the
  // claim plane is read from OUTSIDE the held continuation. What it proves is
  // the order, not the outcome.
  //
  // HARNESS BOUNDARY. One isolate, one real SQLite, the real wrapper. A genuine
  // Durable Object reset is not reproduced here: re-entry stands in for it,
  // which is sound because the wrapper reads nothing but the claim table and the
  // table is what survives a reset. What this cannot see is a reset that loses
  // the write itself, which is a platform durability premise and not this
  // wrapper's contract.
  test('the claim is durable before the effect begins, and a re-entry mid-effect refuses', async () => {
    const { sql, deps } = claimPlane();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const calls: string[] = [];
    const tools = {
      run: tool({
        description: 'send the invoice',
        inputSchema: RECIPIENT_SCHEMA,
        execute: async (input: { to: string }): Promise<SendResult> => {
          // The external effect has begun and has not finished. This is the
          // whole window: a reset here leaves the provider response replayable.
          calls.push(input.to);
          started.resolve();
          await release.promise;
          return { sent: input.to, attempt: calls.length };
        },
      }),
    };
    const execute = toolExecute<{ to: string }, JsonValue>(withEffectClaims(tools, deps).run);

    const inFlight = execute({ to: 'ops@example.test' }, OPTIONS);
    await started.promise;

    // ASSERTION 1, claim-before-effect. Read while the effect is still open, so
    // a row here cannot have been written by the settle.
    expect(sql`SELECT result_json FROM tool_effect_claims`)
      .toEqual([{ result_json: null }]);

    // ASSERTION 2, the recovery. A replay of the same provider response arrives
    // while the first effect is still open. It must refuse, because whether the
    // effect landed is unknown, and it must not run the tool a second time.
    const reentered = await execute({ to: 'ops@example.test' }, OPTIONS);
    expect(parseRefusal(String(reentered))?.reason).toBe('denied');
    expect(calls).toEqual(['ops@example.test']);

    // ASSERTION 3. Releasing the original continuation settles the one effect,
    // and the answer belongs to the attempt that ran.
    release.resolve();
    expect(await inFlight).toEqual({ sent: 'ops@example.test', attempt: 1 });
    expect(calls).toEqual(['ops@example.test']);
    expect(sql`SELECT result_json FROM tool_effect_claims`)
      .toEqual([{ result_json: JSON.stringify({ sent: 'ops@example.test', attempt: 1 }) }]);
  });

  test('a settle cannot overwrite an outcome another attempt already recorded', async () => {
    // The other half of the same window. Two continuations both hold a settle,
    // the second arriving after the first recorded. Asserted here rather than
    // through the wrapper because the wrapper's own re-entry refuses before it
    // reaches a settle, so the guard on `result_json IS NULL` would otherwise be
    // unreachable and therefore unasserted.
    const { sql, deps } = claimPlane();
    const key = { turnId: deps.turnId(), callId: 'call-a1', digest: 'digest-a1' };

    expect(claimToolEffect(sql, key).kind).toBe('claimed');
    settleToolEffect(sql, key, JSON.stringify({ attempt: 1 }));
    settleToolEffect(sql, key, JSON.stringify({ attempt: 2 }));

    const claim = claimToolEffect(sql, key);
    expect(claim.kind === 'settled' ? claim.result : null).toEqual({ attempt: 1 });
  });

  test('an undeclared tool is claimed, never opted out', () => {
    // An MCP server's tool, or any adapter added later: nothing has established
    // its replay safety, so it goes through the claim.
    expect(replayPolicyFor('mcp__stripe__create_charge')).toBe('claimed');
    expect(replayPolicyFor('run')).toBe('claimed');
  });
});
