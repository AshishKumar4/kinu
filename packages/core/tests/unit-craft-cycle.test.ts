/**
 * The in-episode craft loop driven as `AgentOrchestrator.turnExtension` does, asserting on
 * the durable ledger and the turn's run record.
 */

import { describe, test, expect } from 'bun:test';
import { CraftCycle } from '../src/orchestrator/craft-cycle';
import { TurnAccumulator } from '../src/orchestrator/turn-accumulator';
import type { CraftLedger } from '../src/craft/in-episode';
import { CRAFT_INVOCATION_QUALITY, craftInvocationError } from '../src/craft/in-episode';
import type { JsonValue } from '../src/utils/json';
import type { ToolOutcome } from '../src/tools/outcome';
import { present } from '@kinu.run/test-utils';

interface Observation { names: string[]; quality: number }

/** A ledger over a name list; `dropped` names are reported back like below-floor tools. */
function fakeLedger(initial: string[] = [], dropped: string[] = []): CraftLedger & {
  tools: string[];
  observations: Observation[];
} {
  const tools = [...initial];
  const observations: Observation[] = [];

  return {
    tools,
    observations,
    names: () => tools,
    observe(names, quality) {
      observations.push({ names: [...names], quality });

      return names.filter((n) => dropped.includes(n));
    },
  };
}

/** One settled `eval` call; its args ride along, so no pairing is needed. */
function block(cycle: CraftCycle, code: string, opts: { fails?: boolean; result?: string } = {}): void {
  cycle.onToolResult({
    toolName: 'eval',
    args: { code },
    result: opts.result ?? (opts.fails ? 'Error: something broke' : '{"result":"ok"}'),
    ...(opts.fails ? { success: false, reason: null } satisfies ToolOutcome : { success: true } satisfies ToolOutcome),
  });
}

describe('CraftCycle — the trigger', () => {
  test('a tool crafted mid-turn is recorded, without anything reporting it', () => {
    const ledger = fakeLedger();
    const cycle = new CraftCycle(ledger, new TurnAccumulator());
    cycle.reset(true);

    // Creation is seen as the store changing while the call ran.
    ledger.tools.push('sum');
    block(cycle, 'await workspace.createTool("sum","d","async()=>1")', { result: '{"ok":true}' });

    expect(cycle.snapshot()).toEqual({
      crafted: ['sum'], invoked: [], reused: [], returned: 0, raised: 0, dropped: [],
    });
  });

  test('a store that grew without the block asking is not the agent crafting', () => {
    // The detached turn-outcome review (evolution/engine.ts) extracts tools too; a block that
    // never called createTool must not be credited with them.
    const ledger = fakeLedger();
    const cycle = new CraftCycle(ledger, new TurnAccumulator());
    cycle.reset(true);
    ledger.tools.push('extracted');
    block(cycle, 'return workspace.readFile("/a")');
    expect(cycle.snapshot()).toBeNull();
  });

  test('a backgrounded block is not a finished one', () => {
    const ledger = fakeLedger(['slow']);
    const cycle = new CraftCycle(ledger, new TurnAccumulator());
    cycle.reset(true);
    block(cycle, 'return await tools.slow(1)', {
      result: JSON.stringify({ background: true, jobId: 'j1', kind: 'eval', message: 'still running' }),
    });
    expect(ledger.observations).toEqual([]);
    expect(cycle.snapshot()).toBeNull();
  });

  test('tools that existed at turn start are never reported as crafted', () => {
    const ledger = fakeLedger(['sum']);
    const cycle = new CraftCycle(ledger, new TurnAccumulator());
    cycle.reset(true);
    block(cycle, 'return 1');
    expect(cycle.snapshot()).toBeNull();
  });

  test('tools other than eval are not the craft surface', () => {
    const cycle = new CraftCycle(fakeLedger(['sum']), new TurnAccumulator());
    cycle.reset(true);
    cycle.onToolResult({ toolName: 'shell', args: { command: 'tools.sum(1)' }, result: 'ok', success: true });
    expect(cycle.snapshot()).toBeNull();
  });

  test('a turn that neither crafts nor calls a crafted tool writes no row', () => {
    const cycle = new CraftCycle(fakeLedger(['sum']), new TurnAccumulator());
    cycle.reset(true);
    block(cycle, 'return workspace.readFile("/a")');
    expect(cycle.snapshot()).toBeNull();
  });

  test('with auto-evolution off nothing is observed and nothing is recorded', () => {
    const ledger = fakeLedger(['sum']);
    const cycle = new CraftCycle(ledger, new TurnAccumulator());
    cycle.reset(false);
    block(cycle, 'await tools.sum(1)');
    expect(ledger.observations).toEqual([]);
    expect(cycle.snapshot()).toBeNull();
  });
});

describe('CraftCycle — the fitness signal', () => {
  test('a pre-existing tool that ran earns the machine-evidence credit', () => {
    const ledger = fakeLedger(['sum']);
    const cycle = new CraftCycle(ledger, new TurnAccumulator());
    cycle.reset(true);
    block(cycle, 'return await tools.sum(2)');
    expect(ledger.observations).toEqual([{ names: ['sum'], quality: CRAFT_INVOCATION_QUALITY.returned }]);
    expect(cycle.snapshot()).toEqual({
      crafted: [], invoked: ['sum'], reused: [], returned: 1, raised: 0, dropped: [],
    });
  });

  test('a tool cannot certify itself in the block that created it', () => {
    const ledger = fakeLedger();
    const cycle = new CraftCycle(ledger, new TurnAccumulator());
    cycle.reset(true);
    ledger.tools.push('sum');
    block(cycle, 'await workspace.createTool("sum","d","async()=>1"); return tools.sum(1)', { result: '1' });

    expect(ledger.observations).toEqual([]);
    const snap = present(cycle.snapshot(), 'the craft-cycle snapshot');
    expect(snap.crafted).toEqual(['sum']);
    expect(snap.invoked).toEqual(['sum']);
    expect(snap.reused).toEqual([]);
    expect(snap.returned).toBe(0);
  });

  test('the loop closes when a LATER block reaches for what this turn crafted', () => {
    const ledger = fakeLedger();
    const cycle = new CraftCycle(ledger, new TurnAccumulator());
    cycle.reset(true);

    ledger.tools.push('sum');
    block(cycle, 'await workspace.createTool("sum","d","async()=>1")');

    block(cycle, 'return await tools.sum(3)');

    expect(ledger.observations).toEqual([{ names: ['sum'], quality: CRAFT_INVOCATION_QUALITY.returned }]);
    expect(cycle.snapshot()).toEqual({
      crafted: ['sum'], invoked: ['sum'], reused: ['sum'], returned: 1, raised: 0, dropped: [],
    });
  });

  test('a raised crafted call is scored against the tool the failure names', () => {
    const ledger = fakeLedger(['sum', 'other']);
    const cycle = new CraftCycle(ledger, new TurnAccumulator());
    cycle.reset(true);
    block(cycle, 'await tools.sum(1); await tools.other(2)', {
      fails: true,
      result: craftInvocationError('sum', new Error('boom')).message,
    });
    expect(ledger.observations).toEqual([{ names: ['sum'], quality: CRAFT_INVOCATION_QUALITY.raised }]);
    const snap = present(cycle.snapshot(), 'the craft-cycle snapshot');
    expect(snap.raised).toBe(1);
    expect(snap.returned).toBe(0);
  });

  test('a raise the model CAUGHT is still a raise', () => {
    // The stamp is evidence about the artifact, not the block's own verdict.
    const ledger = fakeLedger(['sum']);
    const cycle = new CraftCycle(ledger, new TurnAccumulator());
    cycle.reset(true);
    block(cycle, 'try { await tools.sum(1) } catch (e) { console.log(e.message); return "recovered" }', {
      result: JSON.stringify({ result: 'recovered', logs: [craftInvocationError('sum', new Error('boom')).message] }),
    });
    expect(ledger.observations).toEqual([{ names: ['sum'], quality: CRAFT_INVOCATION_QUALITY.raised }]);
    expect(present(cycle.snapshot(), 'the craft-cycle snapshot').returned).toBe(0);
  });

  test('a failure payload too long to parse is still a failure', () => {
    // A bounded prefix makes a verbose failure unparseable JSON; that is not a success.
    const ledger = fakeLedger(['sum']);
    const cycle = new CraftCycle(ledger, new TurnAccumulator());
    cycle.reset(true);
    const stamped = craftInvocationError('sum', new Error('x'.repeat(50))).message;
    block(cycle, 'await tools.sum(1)', { result: `{"error":"${stamped} ${'y'.repeat(50)}` });
    expect(ledger.observations).toEqual([{ names: ['sum'], quality: CRAFT_INVOCATION_QUALITY.raised }]);
  });

  test('a block that broke on its own account scores nobody', () => {
    const ledger = fakeLedger(['sum']);
    const cycle = new CraftCycle(ledger, new TurnAccumulator());
    cycle.reset(true);
    block(cycle, 'await tools.sum(1); undefinedFn()', { fails: true });
    expect(ledger.observations).toEqual([]);
    expect(present(cycle.snapshot(), 'the craft-cycle snapshot').invoked).toEqual(['sum']);
  });

  test('a failure a tool caught and RETURNED still counts as a failure', () => {
    // success:true with an error payload: `isFailingToolResult` decides.
    const ledger = fakeLedger(['sum']);
    const cycle = new CraftCycle(ledger, new TurnAccumulator());
    cycle.reset(true);
    block(cycle, 'await tools.sum(1)', {
      result: JSON.stringify({ result: null, error: craftInvocationError('sum', new Error('boom')).message }),
    });
    expect(ledger.observations).toEqual([{ names: ['sum'], quality: CRAFT_INVOCATION_QUALITY.raised }]);
  });

  test('a tool pushed below the injection floor is named in the turn record', () => {
    const ledger = fakeLedger(['sum'], ['sum']);
    const cycle = new CraftCycle(ledger, new TurnAccumulator());
    cycle.reset(true);
    block(cycle, 'await tools.sum(1)', {
      fails: true,
      result: craftInvocationError('sum', new Error('boom')).message,
    });
    expect(present(cycle.snapshot(), 'the craft-cycle snapshot').dropped).toEqual(['sum']);
  });
});

describe('CraftCycle — what it refuses to guess at', () => {
  test('several execute calls in one step are each attributed to their own code', () => {
    // The result carries its own args, so concurrent calls are unambiguous.
    const ledger = fakeLedger(['sum', 'other']);
    const cycle = new CraftCycle(ledger, new TurnAccumulator());
    cycle.reset(true);
    block(cycle, 'await tools.sum(1)');
    block(cycle, 'await tools.other(2)', {
      fails: true,
      result: craftInvocationError('other', new Error('boom')).message,
    });

    expect(ledger.observations).toEqual([
      { names: ['sum'], quality: CRAFT_INVOCATION_QUALITY.returned },
      { names: ['other'], quality: CRAFT_INVOCATION_QUALITY.raised },
    ]);
  });

  test('a non-string code argument is not guessed at', () => {
    const ledger = fakeLedger(['sum']);
    const cycle = new CraftCycle(ledger, new TurnAccumulator());
    cycle.reset(true);
    cycle.onToolResult({ toolName: 'eval', args: { code: 42 }, result: 'ok', success: true });
    expect(ledger.observations).toEqual([]);
  });

  test('reset clears the turn', () => {
    const ledger = fakeLedger(['sum']);
    const cycle = new CraftCycle(ledger, new TurnAccumulator());
    cycle.reset(true);
    block(cycle, 'await tools.sum(1)');
    expect(cycle.snapshot()).not.toBeNull();
    cycle.reset(true);
    expect(cycle.snapshot()).toBeNull();
  });
});

describe('CraftCycle — what the turn reports as crafted-tool use', () => {
  /** Drives the cycle as AgentOrchestrator does and reads back the turn snapshot and usage row. */
  function turnUsage(
    ledger: CraftLedger,
    calls: ReadonlyArray<{ toolName: string; code?: JsonValue; result?: string }>,
    enabled = true,
  ): string[] {
    const acc = new TurnAccumulator();
    const cycle = new CraftCycle(ledger, acc);
    acc.reset(Date.now());
    cycle.reset(enabled);

    for (const call of calls) {
      cycle.onToolResult({
        toolName: call.toolName,
        args: call.code === undefined ? {} : { code: call.code },
        result: call.result ?? '{"result":"ok"}',
        success: true,
      });
    }

    return acc.craftedToolsUsed();
  }

  test('a crafted tool called from a submitted block is the turn\'s craft usage', () => {
    expect(turnUsage(fakeLedger(['sum', 'fmt']), [
      { toolName: 'eval', code: 'const a = await tools.sum(1); return tools.fmt(a)' },
    ])).toEqual(['sum', 'fmt']);
  });

  test('MCP and extension tool calls are not crafted-tool use', () => {
    // Crafted tools are codemode-only, so non-builtin names are exactly MCP/extension tools.
    expect(turnUsage(fakeLedger(['sum']), [
      { toolName: 'mcp__github__create_issue' },
      { toolName: 'some_extension_tool' },
      { toolName: 'shell' },
    ])).toEqual([]);
  });

  test('usage is deduped and accumulated across the turn\'s blocks', () => {
    expect(turnUsage(fakeLedger(['sum', 'fmt']), [
      { toolName: 'eval', code: 'await tools.sum(1)' },
      { toolName: 'eval', code: 'await tools.sum(2); await tools.fmt(3)' },
    ])).toEqual(['sum', 'fmt']);
  });

  test('a turn with evolution off records no craft usage — a craft score is evolution state', () => {
    expect(turnUsage(fakeLedger(['sum']), [
      { toolName: 'eval', code: 'await tools.sum(1)' },
    ], false)).toEqual([]);
  });
});
