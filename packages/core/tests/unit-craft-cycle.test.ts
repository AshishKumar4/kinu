/**
 * The in-episode craft loop, through its public seam.
 *
 * The cycle only ever sees what a backend's tool hooks hand it — an
 * `execute_tools` call with its code, and that call's result — so every test
 * here drives it exactly as `AgentOrchestrator.turnExtension` does, and
 * asserts on the durable ledger and the turn's run record rather than on
 * anything internal.
 */

import { describe, test, expect } from 'bun:test';
import { CraftCycle } from '../src/orchestrator/craft-cycle.js';
import { TurnAccumulator } from '../src/orchestrator/turn-accumulator.js';
import type { CraftLedger } from '../src/craft/in-episode.js';
import { CRAFT_INVOCATION_QUALITY, craftInvocationError } from '../src/craft/in-episode.js';
import type { JsonValue } from '../src/utils/json.js';

interface Observation { names: string[]; quality: number }

/** A ledger over a plain name list, recording every observation. `dropped`
 *  names are reported back the way a below-floor tool would be. */
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

/** One settled `execute_tools` call, as the tool-result hook delivers it —
 *  the call's own args ride along, which is why no pairing is needed. */
function block(cycle: CraftCycle, code: string, opts: { fails?: boolean; result?: string } = {}): void {
  cycle.onToolResult({
    toolName: 'execute_tools',
    args: { code },
    result: opts.result ?? (opts.fails ? 'Error: something broke' : '{"result":"ok"}'),
    success: !opts.fails,
  });
}

describe('CraftCycle — the trigger', () => {
  test('a tool crafted mid-turn is recorded, without anything reporting it', () => {
    const ledger = fakeLedger();
    const cycle = new CraftCycle(ledger, new TurnAccumulator());
    cycle.reset(true);

    // The store changed while the call ran — which is how creation is seen.
    ledger.tools.push('sum');
    block(cycle, 'await workspace.createTool("sum","d","async()=>1")', { result: '{"ok":true}' });

    expect(cycle.snapshot()).toEqual({
      crafted: ['sum'], invoked: [], reused: [], returned: 0, raised: 0, dropped: [],
    });
  });

  test('a store that grew without the block asking is not the agent crafting', () => {
    // The detached turn-outcome review extracts tools of its own
    // (evolution/engine.ts). A block that never called createTool must not be
    // credited with whatever landed while it ran.
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
      result: JSON.stringify({ background: true, jobId: 'j1', kind: 'execute_tools', message: 'still running' }),
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

  test('tools other than execute_tools are not the craft surface', () => {
    const cycle = new CraftCycle(fakeLedger(['sum']), new TurnAccumulator());
    cycle.reset(true);
    cycle.onToolResult({ toolName: 'run', args: { command: 'tools.sum(1)' }, result: 'ok', success: true });
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
    block(cycle, 'await workspace.createTool("sum","d","async()=>1"); return codemode.sum(1)', { result: '1' });

    expect(ledger.observations).toEqual([]);
    const snap = cycle.snapshot()!;
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
    const snap = cycle.snapshot()!;
    expect(snap.raised).toBe(1);
    expect(snap.returned).toBe(0);
  });

  test('a raise the model CAUGHT is still a raise', () => {
    // The block reports success because the model handled the throw. The stamp
    // is the evidence about the artifact, not the block's own verdict.
    const ledger = fakeLedger(['sum']);
    const cycle = new CraftCycle(ledger, new TurnAccumulator());
    cycle.reset(true);
    block(cycle, 'try { await tools.sum(1) } catch (e) { console.log(e.message); return "recovered" }', {
      result: JSON.stringify({ result: 'recovered', logs: [craftInvocationError('sum', new Error('boom')).message] }),
    });
    expect(ledger.observations).toEqual([{ names: ['sum'], quality: CRAFT_INVOCATION_QUALITY.raised }]);
    expect(cycle.snapshot()!.returned).toBe(0);
  });

  test('a failure payload too long to parse is still a failure', () => {
    // The seam hands over a bounded prefix, so a verbose failure arrives as
    // unparseable JSON. Reading it as a success would credit the tool that
    // just broke.
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
    expect(cycle.snapshot()!.invoked).toEqual(['sum']);
  });

  test('a failure a tool caught and RETURNED still counts as a failure', () => {
    // The `run`-tool shape: success:true with an error payload. The repo's one
    // definition of a failing result (isFailingToolResult) is what decides.
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
    expect(cycle.snapshot()!.dropped).toEqual(['sum']);
  });
});

describe('CraftCycle — what it refuses to guess at', () => {
  test('several execute calls in one step are each attributed to their own code', () => {
    // The result carries its own args, so two calls in flight at once are not
    // ambiguous — which they were when the code had to be paired from the
    // dispatch hook.
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
    cycle.onToolResult({ toolName: 'execute_tools', args: { code: 42 }, result: 'ok', success: true });
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
  /** Drive the cycle exactly as AgentOrchestrator does, and read back what the
   *  turn snapshot and the durable usage row will both see. */
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
      { toolName: 'execute_tools', code: 'const a = await tools.sum(1); return codemode.fmt(a)' },
    ])).toEqual(['sum', 'fmt']);
  });

  test('MCP and extension tool calls are not crafted-tool use', () => {
    // The defect this replaced: "any tool call whose name is not built in" is a
    // set crafted tools are never in — they are codemode-only — so it selected
    // exactly the MCP/extension names and wrote craft scores against them.
    expect(turnUsage(fakeLedger(['sum']), [
      { toolName: 'mcp__github__create_issue' },
      { toolName: 'some_extension_tool' },
      { toolName: 'run' },
    ])).toEqual([]);
  });

  test('usage is deduped and accumulated across the turn\'s blocks', () => {
    expect(turnUsage(fakeLedger(['sum', 'fmt']), [
      { toolName: 'execute_tools', code: 'await tools.sum(1)' },
      { toolName: 'execute_tools', code: 'await tools.sum(2); await tools.fmt(3)' },
    ])).toEqual(['sum', 'fmt']);
  });

  test('a turn with evolution off records no craft usage — a craft score is evolution state', () => {
    expect(turnUsage(fakeLedger(['sum']), [
      { toolName: 'execute_tools', code: 'await tools.sum(1)' },
    ], false)).toEqual([]);
  });
});
