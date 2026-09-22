/** Once-only claim in front of effectful tools (KINU-019), over real SQL. */
import { describe, expect, test } from 'bun:test';
import { createTestActors, createTestSql, present, toolExecute } from '@kinu.run/test-utils';
import type { JsonObject } from '../src/utils/json';
import { jsonSchema, tool, type ToolExecutionOptions, type ToolSet } from 'ai';
import {
  buildMcpToolSet, claimToolEffect, initToolEffectClaimTable, releaseTurnEffectClaims,
  settleToolEffect, TurnContextBudget,
  withEffectClaims, replayPolicyFor, type EffectClaimDeps, type JsonValue,
  type SerializableToolDescriptor,
} from '../src/index';
import { createMemoryVfs } from '@kinu.run/test-utils';

/** `ToolSet`'s index type erases the registry's input type, so the call shape is restated once here. */
function mcpCall(tools: ToolSet, name: string): (args: JsonObject, options: ToolExecutionOptions) => Promise<string> {
  const entry: { execute?: (args: JsonObject, options: ToolExecutionOptions) => PromiseLike<string> }
    = present(tools[name], `the ${name} tool`);

  return async (args, options) => await toolExecute(entry)(args, options);
}

/** The actor is fixed because a claim key is `(actor_id, turn, call, digest)`. */
function claimPlane(turnId = 'turn-1') {
  const { sql, execRaw } = createTestSql();
  initToolEffectClaimTable(execRaw);
  const actor = createTestActors(sql, execRaw).main;
  const scope = { turnId };
  const deps: EffectClaimDeps = { sql, actor, turnId: () => scope.turnId };

  return { sql, actor, deps, scope };
}

/** `jsonSchema<T>` so `tool()` infers INPUT; both tools share it because the claim digest covers these args. */
const RECIPIENT_SCHEMA = jsonSchema<{ to: string }>({
  type: 'object', properties: { to: { type: 'string' } }, required: ['to'],
});

/** `attempt` distinguishes a replayed answer from a second run. */
interface SendResult {
  readonly sent: string;
  readonly attempt: number;
}

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
        // Declared result: an `execute` that only throws infers `never`, typed as a tool without execute.
        execute: async (): Promise<SendResult> => {
          throw new Error('the connection dropped mid-send');
        },
      }),
    };

    const execute = toolExecute<{ to: string }, JsonValue>(withEffectClaims(tools, deps).run);

    // Claimed, then died unsettled: whether the effect landed is unknown.
    await expect(execute({ to: 'ops@example.test' }, OPTIONS)).rejects.toThrow('connection dropped');

    const replayed = execute({ to: 'ops@example.test' }, OPTIONS);
    await expect(replayed).rejects.toMatchObject({ code: 'denied' });
    await expect(replayed).rejects.toThrow('never recorded');
  });

  test('a different call in the same turn is not a replay', async () => {
    const { deps } = claimPlane();
    const { calls, tools } = countingTool();
    const execute = toolExecute<{ to: string }, JsonValue>(withEffectClaims(tools, deps).run);

    await execute({ to: 'a@example.test' }, OPTIONS);
    await execute({ to: 'b@example.test' }, OPTIONS);
    await execute({ to: 'a@example.test' }, { ...OPTIONS, toolCallId: 'call-a2' });

    expect(calls).toEqual(['a@example.test', 'b@example.test', 'a@example.test']);
  });

  test('the row is keyed on the identity the caller supplied, never an invented one', async () => {
    // Pins the identity columns: a default id for missing options would replay one call as another.
    const { sql, deps } = claimPlane('turn-7');
    const { tools } = countingTool();
    const execute = toolExecute<{ to: string }, JsonValue>(withEffectClaims(tools, deps).run);

    await execute({ to: 'ops@example.test' }, { toolCallId: 'call-from-provider', messages: [] });

    expect(sql`SELECT turn_id, normalized_call_id FROM tool_effect_claims`)
      .toEqual([{ turn_id: 'turn-7', normalized_call_id: 'call-from-provider' }]);
  });

  test('a released turn no longer replays, because its answer is durable', async () => {
    const { sql, actor, deps, scope } = claimPlane();
    const { calls, tools } = countingTool();
    const execute = toolExecute<{ to: string }, JsonValue>(withEffectClaims(tools, deps).run);

    await execute({ to: 'ops@example.test' }, OPTIONS);
    releaseTurnEffectClaims(sql, actor, scope.turnId);
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

  // Final-state tests cannot tell claim-before-effect from effect-before-claim; this holds the
  // effect open and reads the claim table mid-flight. Re-entry stands in for a reset.
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

    // Read while the effect is open, so the row cannot come from the settle.
    expect(sql`SELECT result_json FROM tool_effect_claims`)
      .toEqual([{ result_json: null }]);

    await expect(execute({ to: 'ops@example.test' }, OPTIONS)).rejects.toMatchObject({ code: 'denied' });
    expect(calls).toEqual(['ops@example.test']);

    release.resolve();
    expect(await inFlight).toEqual({ sent: 'ops@example.test', attempt: 1 });
    expect(calls).toEqual(['ops@example.test']);
    expect(sql`SELECT result_json FROM tool_effect_claims`)
      .toEqual([{ result_json: JSON.stringify({ sent: 'ops@example.test', attempt: 1 }) }]);
  });

  test('a settle cannot overwrite an outcome another attempt already recorded', async () => {
    // Direct, because the wrapper's re-entry refuses before reaching a second settle.
    const { sql, actor, deps } = claimPlane();
    const key = { turnId: deps.turnId(), callId: 'call-a1', digest: 'digest-a1' };

    expect(claimToolEffect(sql, actor, key).kind).toBe('claimed');
    settleToolEffect(sql, actor, key, JSON.stringify({ attempt: 1 }));
    settleToolEffect(sql, actor, key, JSON.stringify({ attempt: 2 }));

    const claim = claimToolEffect(sql, actor, key);
    expect(claim.kind === 'settled' ? claim.result : null).toEqual({ attempt: 1 });
  });

  test('an undeclared tool is claimed, never opted out', () => {
    expect(replayPolicyFor('mcp__stripe__create_charge')).toBe('claimed');
    expect(replayPolicyFor('shell')).toBe('claimed');
  });

  describe('buildMcpToolSet — an admitted remote surface is claimed before it merges', () => {
    const descriptor = (name: string, extra?: Partial<SerializableToolDescriptor>): SerializableToolDescriptor => ({
      serverId: 'srv',
      serverName: 'srv',
      name,
      toolKey: `mcp__srv__${name}`,
      ...extra,
    });

    test('a remote tool without a readOnly annotation is claimed, then replayed', async () => {
      const { sql, execRaw } = createTestSql();

      initToolEffectClaimTable(execRaw);

      const actor = createTestActors(sql, execRaw).main;
      let dispatched = 0;

      const tools = buildMcpToolSet(
        [descriptor('charge')],
        {
          call: async (_d, args) => {
            const rows = sql<{ n: number }>`SELECT count(*) AS n FROM tool_effect_claims`;

            expect(rows[0].n).toBe(1);
            dispatched += 1;

            return `charged-${Number(args.amount)}`;
          },
          effectClaims: { sql, actor, turnId: () => 'turn-1' },
          clamp: { vfs: createMemoryVfs().vfs, budget: new TurnContextBudget(), producer: 'external_tool' },
        },
      );

      const call = mcpCall(tools, 'mcp__srv__charge');

      expect(await call({ amount: 5 }, { toolCallId: 'call-1', messages: [] })).toBe('charged-5');

      expect(await call({ amount: 5 }, { toolCallId: 'call-1', messages: [] })).toBe('charged-5');
      expect(dispatched).toBe(1);
    });

    test('an absent annotation is not read-only — it is claimed', async () => {
      const { sql, execRaw } = createTestSql();

      initToolEffectClaimTable(execRaw);

      const actor = createTestActors(sql, execRaw).main;

      const tools = buildMcpToolSet(
        [descriptor('quiet')],
        {
          call: async () => 'ok',
          effectClaims: { sql, actor, turnId: () => 'turn-1' },
          clamp: { vfs: createMemoryVfs().vfs, budget: new TurnContextBudget(), producer: 'external_tool' },
        },
      );

      // SAFETY: the adapter always carries execute.
      expect(await mcpCall(tools, 'mcp__srv__quiet')({}, { toolCallId: 'c1', messages: [] })).toBe('ok');
      expect(sql<{ n: number }>`SELECT count(*) AS n FROM tool_effect_claims`[0].n).toBe(1);
    });

    test('a readOnly tool runs straight through — no claim row, no replay', async () => {
      const { sql, execRaw } = createTestSql();

      initToolEffectClaimTable(execRaw);

      const actor = createTestActors(sql, execRaw).main;
      let dispatched = 0;

      const tools = buildMcpToolSet(
        [descriptor('lookup', { readOnly: true })],
        {
          call: async () => {
            dispatched += 1;

            return `lookup-${String(dispatched)}`;
          },
          effectClaims: { sql, actor, turnId: () => 'turn-1' },
          clamp: { vfs: createMemoryVfs().vfs, budget: new TurnContextBudget(), producer: 'external_tool' },
        },
      );

      // SAFETY: the adapter always carries execute.
      const call = mcpCall(tools, 'mcp__srv__lookup');

      expect(await call({}, { toolCallId: 'c1', messages: [] })).toBe('lookup-1');
      expect(await call({}, { toolCallId: 'c1', messages: [] })).toBe('lookup-2');
      expect(sql<{ n: number }>`SELECT count(*) AS n FROM tool_effect_claims`[0].n).toBe(0);
    });
  });
});
