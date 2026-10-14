/**
 * The in-episode craft loop as `buildActorTools` installs it: each `eval` call observed where it runs, asserting on the
 * durable ledger and the turn's run record.
 */

import { describe, test, expect } from 'bun:test';
import { jsonSchema, tool, type ToolSet } from 'ai';
import { observingCrafts } from '../src/delegation/actor-tools';
import { TurnAccumulator } from '../src/orchestrator/turn-accumulator';
import { TurnCraftLedger } from '../src/craft/turn-ledger';
import type { CraftLedger } from '../src/craft/in-episode';
import { CRAFT_NEUTRAL_PRIOR, craftInvocationError } from '../src/craft/in-episode';
import { runWorkModeInvocation } from '../src/execution/work-mode';
import type { JsonValue } from '../src/utils/json';
import { present, toolExecute } from '@kinu.run/test-utils';

/** A scored observation: credit lifts a tool above its prior, blame lowers it. */
interface Observation { names: string[]; verdict: 'credit' | 'blame' }

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
    names: () => [...tools],
    observe(names, quality) {
      observations.push({ names: [...names], verdict: quality > CRAFT_NEUTRAL_PRIOR ? 'credit' : 'blame' });

      return names.filter((n) => dropped.includes(n));
    },
  };
}

/** A recording turn's record. */
function recording(): TurnCraftLedger {
  return new TurnCraftLedger(true);
}

let calls = 0;

/** One `eval` call through the observer: its program may create `creates` as it runs, then returns `result` or throws
 *  `failure`. */
async function block(turn: TurnCraftLedger, ledger: ReturnType<typeof fakeLedger>, code: JsonValue, opts: {
  creates?: string; result?: JsonValue; failure?: string;
} = {}): Promise<void> {
  const program: ToolSet[string] = tool({
    inputSchema: jsonSchema<{ code: JsonValue }>({ type: 'object' }),
    execute: async () => {
      if (opts.creates !== undefined) ledger.tools.push(opts.creates);

      if (opts.failure !== undefined) throw new Error(opts.failure);

      return opts.result ?? { result: 'ok' };
    },
  });

  calls += 1;
  const call = toolExecute<{ code: JsonValue }, unknown>(observingCrafts(program, ledger, turn))({ code }, { toolCallId: `call-${String(calls)}`, messages: [], context: undefined });

  // Observed, a failing call still fails the tool call with its own error.
  if (opts.failure === undefined) await call;
  else await expect(call).rejects.toThrow(opts.failure);
}

describe('craft observation — the trigger', () => {
  test('a tool crafted by the call is recorded, without anything reporting it', async () => {
    const ledger = fakeLedger();
    const turn = recording();

    await block(turn, ledger, 'await workspace.createTool("sum","d","async()=>1")', { creates: 'sum', result: { ok: true } });

    expect(turn.snapshot()).toEqual({
      crafted: ['sum'], invoked: [], reused: [], returned: 0, raised: 0, dropped: [],
    });
  });

  test('a store that grew without the block asking is not the agent crafting', async () => {
    // The detached turn-outcome review (evolution/engine.ts) extracts tools too; a block that
    // never called createTool must not be credited with them.
    const ledger = fakeLedger();
    const turn = recording();

    await block(turn, ledger, 'return workspace.readFile("/a")', { creates: 'extracted' });
    expect(turn.snapshot()).toBeNull();
  });

  test('a backgrounded block is not a finished one', async () => {
    const ledger = fakeLedger(['slow']);
    const turn = recording();

    await block(turn, ledger, 'return await tools.slow(1)', {
      result: { background: true, jobId: 'j1', kind: 'eval', message: 'still running' },
    });
    expect(ledger.observations).toEqual([]);
    expect(turn.snapshot()).toBeNull();
  });

  test('tools that existed when the call was dispatched are never reported as crafted', async () => {
    const ledger = fakeLedger(['sum']);
    const turn = recording();

    await block(turn, ledger, 'await workspace.createTool("sum","d","async()=>2")');
    expect(turn.snapshot()).toBeNull();
  });

  test('a turn that neither crafts nor calls a crafted tool writes no row', async () => {
    const turn = recording();

    await block(turn, fakeLedger(['sum']), 'return workspace.readFile("/a")');
    expect(turn.snapshot()).toBeNull();
  });

  test('with auto-evolution off nothing is observed and nothing is recorded', async () => {
    const ledger = fakeLedger(['sum']);
    const turn = new TurnCraftLedger(false);

    await block(turn, ledger, 'await tools.sum(1)');
    expect(ledger.observations).toEqual([]);
    expect(turn.snapshot()).toBeNull();
  });

  test('a Plan invocation is not observed, whatever the turn records', async () => {
    const ledger = fakeLedger(['sum']);
    const turn = recording();

    await runWorkModeInvocation('plan', async () => { await block(turn, ledger, 'await tools.sum(1)'); });
    expect(ledger.observations).toEqual([]);
    expect(turn.snapshot()).toBeNull();
  });
});

describe('craft observation — the fitness signal', () => {
  test('a pre-existing tool that ran earns the machine-evidence credit', async () => {
    const ledger = fakeLedger(['sum']);
    const turn = recording();

    await block(turn, ledger, 'return await tools.sum(2)');
    expect(ledger.observations).toEqual([{ names: ['sum'], verdict: 'credit' }]);
    expect(turn.snapshot()).toEqual({
      crafted: [], invoked: ['sum'], reused: [], returned: 1, raised: 0, dropped: [],
    });
  });

  test('a tool cannot certify itself in the block that created it', async () => {
    const ledger = fakeLedger();
    const turn = recording();

    await block(turn, ledger, 'await workspace.createTool("sum","d","async()=>1"); return tools.sum(1)', { creates: 'sum', result: 1 });

    expect(ledger.observations).toEqual([]);
    const snap = present(turn.snapshot(), 'the craft-cycle snapshot');
    expect(snap.crafted).toEqual(['sum']);
    expect(snap.invoked).toEqual(['sum']);
    expect(snap.reused).toEqual([]);
    expect(snap.returned).toBe(0);
  });

  test('the loop closes when a LATER block reaches for what this turn crafted', async () => {
    const ledger = fakeLedger();
    const turn = recording();

    await block(turn, ledger, 'await workspace.createTool("sum","d","async()=>1")', { creates: 'sum' });
    await block(turn, ledger, 'return await tools.sum(3)');

    expect(ledger.observations).toEqual([{ names: ['sum'], verdict: 'credit' }]);
    expect(turn.snapshot()).toEqual({
      crafted: ['sum'], invoked: ['sum'], reused: ['sum'], returned: 1, raised: 0, dropped: [],
    });
  });

  test('a raised crafted call is scored against the tool the failure names', async () => {
    const ledger = fakeLedger(['sum', 'other']);
    const turn = recording();

    await block(turn, ledger, 'await tools.sum(1); await tools.other(2)', { failure: craftInvocationError('sum', new Error('boom')).message });
    expect(ledger.observations).toEqual([{ names: ['sum'], verdict: 'blame' }]);
    const snap = present(turn.snapshot(), 'the craft-cycle snapshot');
    expect(snap.raised).toBe(1);
    expect(snap.returned).toBe(0);
  });

  test('a raise the model CAUGHT is still a raise', async () => {
    // The stamp is evidence about the artifact, not the block's own verdict.
    const ledger = fakeLedger(['sum']);
    const turn = recording();

    await block(turn, ledger, 'try { await tools.sum(1) } catch (e) { console.log(e.message); return "recovered" }', {
      result: { result: 'recovered', logs: [craftInvocationError('sum', new Error('boom')).message] },
    });
    expect(ledger.observations).toEqual([{ names: ['sum'], verdict: 'blame' }]);
    expect(present(turn.snapshot(), 'the craft-cycle snapshot').returned).toBe(0);
  });

  test('a failure payload too long to parse is still a failure', async () => {
    // A bounded prefix makes a verbose failure unparseable JSON; that is not a success.
    const ledger = fakeLedger(['sum']);
    const turn = recording();
    const stamped = craftInvocationError('sum', new Error('x'.repeat(50))).message;

    await block(turn, ledger, 'await tools.sum(1)', { result: `{"error":"${stamped} ${'y'.repeat(50)}` });
    expect(ledger.observations).toEqual([{ names: ['sum'], verdict: 'blame' }]);
  });

  test('a block that broke on its own account scores nobody', async () => {
    const ledger = fakeLedger(['sum']);
    const turn = recording();

    await block(turn, ledger, 'await tools.sum(1); undefinedFn()', { failure: 'ReferenceError: undefinedFn is not defined' });
    expect(ledger.observations).toEqual([]);
    expect(present(turn.snapshot(), 'the craft-cycle snapshot').invoked).toEqual(['sum']);
  });

  test('a failure a tool caught and RETURNED still counts as a failure', async () => {
    const ledger = fakeLedger(['sum']);
    const turn = recording();

    await block(turn, ledger, 'await tools.sum(1)', {
      result: { result: null, error: craftInvocationError('sum', new Error('boom')).message },
    });
    expect(ledger.observations).toEqual([{ names: ['sum'], verdict: 'blame' }]);
  });

  test('a tool pushed below the injection floor is named in the turn record', async () => {
    const ledger = fakeLedger(['sum'], ['sum']);
    const turn = recording();

    await block(turn, ledger, 'await tools.sum(1)', { failure: craftInvocationError('sum', new Error('boom')).message });
    expect(present(turn.snapshot(), 'the craft-cycle snapshot').dropped).toEqual(['sum']);
  });
});

describe('craft observation — what it refuses to guess at', () => {
  test('several execute calls in one step are each attributed to their own code', async () => {
    const ledger = fakeLedger(['sum', 'other']);
    const turn = recording();

    await block(turn, ledger, 'await tools.sum(1)');
    await block(turn, ledger, 'await tools.other(2)', { failure: craftInvocationError('other', new Error('boom')).message });

    expect(ledger.observations).toEqual([
      { names: ['sum'], verdict: 'credit' },
      { names: ['other'], verdict: 'blame' },
    ]);
  });

  test('a non-string code argument is not guessed at', async () => {
    const ledger = fakeLedger(['sum']);
    const turn = recording();

    await block(turn, ledger, 42);
    expect(ledger.observations).toEqual([]);
  });

  test('reset clears the turn and stops its recording', async () => {
    const ledger = fakeLedger(['sum']);
    const turn = recording();

    await block(turn, ledger, 'await tools.sum(1)');
    expect(turn.snapshot()).not.toBeNull();
    turn.reset();
    expect(turn.snapshot()).toBeNull();
    expect(turn.recording).toBe(false);
  });
});

describe('craft observation — what the turn reports as crafted-tool use', () => {
  /** A turn's `eval` calls observed into its accumulator, as both backends' turns are. */
  async function turnUsage(ledger: ReturnType<typeof fakeLedger>, codes: readonly string[], enabled = true): Promise<string[]> {
    const acc = new TurnAccumulator();

    acc.reset(Date.now());
    acc.ledgers.craft.recording = enabled;

    for (const code of codes) await block(acc.ledgers.craft, ledger, code);

    return acc.craftedToolsUsed();
  }

  test('a crafted tool called from a submitted block is the turn\'s craft usage', async () => {
    expect(await turnUsage(fakeLedger(['sum', 'fmt']), ['const a = await tools.sum(1); return tools.fmt(a)'])).toEqual(['sum', 'fmt']);
  });

  test('usage is deduped and accumulated across the turn\'s blocks', async () => {
    expect(await turnUsage(fakeLedger(['sum', 'fmt']), ['await tools.sum(1)', 'await tools.sum(2); await tools.fmt(3)'])).toEqual(['sum', 'fmt']);
  });

  test('a turn with evolution off records no craft usage — a craft score is evolution state', async () => {
    expect(await turnUsage(fakeLedger(['sum']), ['await tools.sum(1)'], false)).toEqual([]);
  });

  test('a call observed where it ran is the same use in the turn that keeps its record elsewhere', async () => {
    // The workspace observes a call; the agent's isolate notes what its answer carried, under the same call id.
    const ledger = fakeLedger(['sum']);
    const ran = recording();
    const kept = new TurnAccumulator();

    await block(ran, ledger, 'await tools.sum(1)');
    kept.ledgers.craft.note(`call-${String(calls)}`, present(ran.call(`call-${String(calls)}`), 'the observed call'));

    expect(kept.craftedToolsUsed()).toEqual(['sum']);
    expect(kept.ledgers.craft.snapshot()).toEqual(ran.snapshot());
  });
});
