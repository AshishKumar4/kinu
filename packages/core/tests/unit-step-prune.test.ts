// Step-boundary tool-output pruning (prompting/step-prune.ts) + its seat in
// the shared per-step pipeline (composePrepareStep). Invariants under test:
// over-budget step contexts shrink OLD tool outputs while the recent-tool
// budget stays verbatim; message count/order never change; truncation is
// deterministic, byte-stable across growing step arrays, and idempotent;
// cache markers still land LAST on the pruned array.
import { describe, test, expect } from 'bun:test';
import type { ModelMessage, ToolResultPart } from 'ai';
import {
  pruneStepToolOutputs,
  composePrepareStep,
  DynamicContextLedger,
  outputReserveTokens,
  stepContextLimit,
  STEP_RECENT_TOOL_BUDGET_TOKENS,
  type ModelWindow,
} from '../src/index';

function toolExchange(i: number, outputChars: number): ModelMessage[] {
  const id = `call_${i}`;
  return [
    {
      role: 'assistant',
      content: [
        { type: 'text', text: `Running step ${i}.` },
        { type: 'tool-call', toolCallId: id, toolName: 'run', input: { command: `step-${i}.sh` } },
      ],
    },
    {
      role: 'tool',
      content: [{
        type: 'tool-result', toolCallId: id, toolName: 'run',
        output: { type: 'text', value: `output-${i} ${'x'.repeat(outputChars)}` },
      }],
    },
  ];
}

/** 6 tool exchanges with 40k-char outputs (~10k tokens each ≈ 60k total).
 *  Against a 64k window with a 20k answer allowance (budget 44k) the newest
 *  three results fill the 40k recent budget and the oldest three must shrink.
 *  Exchange i's tool message sits at array index 2+2i. */
function bigTurn(): ModelMessage[] {
  const messages: ModelMessage[] = [{ role: 'user', content: 'go' }];
  for (let i = 0; i < 6; i++) messages.push(...toolExchange(i, 40_000));
  return messages;
}

const WINDOW = 64_000;
/** Below half of every window used below, so the reserve is the allowance
 *  itself and each budget is `window - MAX_OUTPUT`. */
const MAX_OUTPUT = 20_000;

function budgetFor(contextWindow: number): ModelWindow {
  return { contextWindow, modelOutputLimit: MAX_OUTPUT };
}

function resultPart(message: ModelMessage): ToolResultPart {
  if (message.role !== 'tool') throw new Error('expected tool message');
  const part = message.content[0];
  if (!part || part.type !== 'tool-result') throw new Error('expected tool result part');
  return part;
}

function outputText(part: ToolResultPart): string {
  const output = part.output;
  if (output.type !== 'text' && output.type !== 'error-text') throw new Error(`unexpected ${output.type}`);
  return output.value;
}

describe('pruneStepToolOutputs', () => {
  test('under budget → untouched (undefined)', () => {
    expect(pruneStepToolOutputs(bigTurn(), budgetFor(400_000))).toBeUndefined();
    expect(pruneStepToolOutputs([{ role: 'user', content: 'hi' }], budgetFor(30_000))).toBeUndefined();
  });

  test('over budget → OLD tool outputs shrink to head + marker, recent budget stays verbatim', () => {
    const messages = bigTurn();
    const pruned = pruneStepToolOutputs(messages, budgetFor(WINDOW));
    expect(pruned).toBeDefined();

    // Never remove or reorder: same count, same roles, same positions.
    expect(pruned!.length).toBe(messages.length);
    expect(pruned!.map((m) => m.role)).toEqual(messages.map((m) => m.role));

    // Oldest three results (fall outside the 40k recent budget) truncated.
    for (const idx of [2, 4, 6]) {
      const part = resultPart(pruned![idx]);
      const text = outputText(part);
      expect(text.length).toBeLessThan(2_200);
      expect(text.startsWith('output-')).toBe(true);
      expect(text).toContain('…[truncated: full output was');
      expect(text).toContain('; re-run the tool if needed]');
      // The marker reports the ORIGINAL serialized size.
      expect(text).toContain(`${outputText(resultPart(messages[idx])).length} chars`);
    }
    // The newest three results (recent 40k-token budget) are the SAME objects.
    for (const idx of [8, 10, 12]) {
      expect(pruned![idx]).toBe(messages[idx]);
    }
    // Non-tool messages untouched by identity; the input array never mutates.
    expect(pruned![0]).toBe(messages[0]);
    expect(pruned![1]).toBe(messages[1]);
    expect(outputText(resultPart(messages[2])).length).toBeGreaterThan(40_000);
  });

  test('byte-stable across steps: a grown array re-truncates old parts to identical bytes', () => {
    const stepN = bigTurn();
    const stepN1 = [...bigTurn(), ...toolExchange(6, 40_000)];
    const prunedN = pruneStepToolOutputs(stepN, budgetFor(WINDOW))!;
    const prunedN1 = pruneStepToolOutputs(stepN1, budgetFor(WINDOW))!;
    // Parts truncated at step N are truncated to the SAME bytes at step N+1.
    for (const idx of [2, 4, 6]) {
      expect(outputText(resultPart(prunedN1[idx]))).toBe(outputText(resultPart(prunedN[idx])));
    }
    // Growth is monotone: the new tail pushed exchange 3 (index 8) out of the
    // recent budget — protected at step N, truncated at step N+1 — and no
    // truncated part ever un-truncates.
    expect(prunedN[8]).toBe(stepN[8]);
    expect(outputText(resultPart(prunedN1[8]))).toContain('…[truncated:');
    expect(prunedN1.length).toBe(stepN1.length);
  });

  test('idempotent: already-truncated outputs are never re-truncated', () => {
    const pruned = pruneStepToolOutputs(bigTurn(), budgetFor(WINDOW))!;
    // The pruned array is under budget now — nothing further to do.
    expect(pruneStepToolOutputs(pruned, budgetFor(WINDOW))).toBeUndefined();
  });

  test('re-pruning already-truncated outputs keeps identical bytes', () => {
    const pruned = pruneStepToolOutputs(bigTurn(), budgetFor(WINDOW))!;
    const first = outputText(resultPart(pruned[2]));
    expect(first).toContain('…[truncated:');
    // Grow the turn so the pruner must run again over the truncated parts.
    const grown = [...pruned, ...toolExchange(6, 40_000), ...toolExchange(7, 40_000), ...toolExchange(8, 40_000)];
    const repruned = pruneStepToolOutputs(grown, budgetFor(WINDOW))!;
    // The already-truncated part passes through untouched — the marker still
    // reports the ORIGINAL serialized size, not the truncated one.
    expect(outputText(resultPart(repruned[2]))).toBe(first);
    expect(first).toContain(`${outputText(resultPart(bigTurn()[2])).length} chars`);
  });

  test('error outputs keep error semantics through truncation', () => {
    const messages = bigTurn();
    const message = messages[2];
    if (!message || message.role !== 'tool') throw new Error('expected tool message');
    message.content[0] = {
      type: 'tool-result', toolCallId: 'call_0', toolName: 'run',
      output: { type: 'error-text', value: `boom ${'e'.repeat(40_000)}` },
    };
    const pruned = pruneStepToolOutputs(messages, budgetFor(WINDOW))!;
    const part = resultPart(pruned[2]);
    expect(part.output.type).toBe('error-text');
    expect(outputText(part)).toContain('…[truncated:');
  });

  test('the exported budget constant is what the pipeline advertises', () => {
    expect(STEP_RECENT_TOOL_BUDGET_TOKENS).toBe(40_000);
  });
});

describe('composePrepareStep with pruning', () => {
  test('prune applies without extensions or a cache plan', async () => {
    const messages = bigTurn();
    const result = await composePrepareStep({ prune: budgetFor(WINDOW) }, { stepNumber: 3, messages });
    expect(result).toBeDefined();
    expect(result!.messages.length).toBe(messages.length);
    expect(outputText(resultPart(result!.messages[2]))).toContain('…[truncated:');
  });

  test('under budget with no extensions → no step override at all', async () => {
    const messages = bigTurn();
    expect(await composePrepareStep({ prune: budgetFor(400_000) }, { stepNumber: 3, messages }))
      .toBeUndefined();
    expect(await composePrepareStep({}, { stepNumber: 3, messages })).toBeUndefined();
  });

  // The pipeline prunes BEFORE it weaves — frozen block positions have to be
  // coordinates in the array the model actually receives — so the blocks the
  // weave is about to put back are absent from the array the pruner measures.
  // Left unreserved, a turn whose ledger has grown sends a request OVER the
  // budget the pruner just declared it was under. This test fails on that
  // ordering: the bare history sits under the budget, the woven request does
  // not, and only a pruner told about the ledger shrinks anything.
  test('the pruner is charged for the ledger blocks the weave adds back', async () => {
    const messages = bigTurn();
    // ~60k tokens of history against an 84k budget: under it on its own.
    // The allowance is stated here rather than taken from MAX_OUTPUT because
    // the margin is what this test is about.
    const budget: ModelWindow = { contextWindow: 120_000, modelOutputLimit: 36_000 };
    expect(await composePrepareStep({ prune: budget }, { stepNumber: 3, messages }))
      .toBeUndefined();

    // A busy turn's worth of frozen blocks — a block is appended whenever live
    // state changes, and nothing bounds them mid-turn.
    const ledger = new DynamicContextLedger();
    for (let i = 0; i < 20; i++) {
      ledger.weave(messages, { memoryTail: `lesson ${i}: ${'m'.repeat(6_000)}` });
    }
    expect(ledger.size).toBe(20);

    const result = await composePrepareStep({
      prune: budget,
      dynamic: { ledger, snapshot: () => ({}) },
    }, { stepNumber: 3, messages });

    expect(result).toBeDefined();
    expect(outputText(resultPart(result!.messages[2]))).toContain('…[truncated:');
  });

  test('a caller-supplied prune reserve adds to the ledger overhead', async () => {
    // Six 28k-char exchanges sit under the 44k budget on their own but over
    // it with a 5k caller reserve — so only a pruner told about the reserve
    // shrinks anything.
    const messages: ModelMessage[] = [{ role: 'user', content: 'go' }];
    for (let i = 0; i < 6; i++) messages.push(...toolExchange(i, 28_000));
    const callerReserve = { ...budgetFor(WINDOW), reservedTokens: 5_000 };
    const bare = await composePrepareStep({ prune: callerReserve }, { stepNumber: 1, messages });
    expect(bare).toBeDefined();
    expect(outputText(resultPart(bare!.messages[2]))).toContain('…[truncated:');
    // An empty ledger (zero overhead) must preserve the caller reserve, not erase it.
    const ledger = new DynamicContextLedger();
    const result = await composePrepareStep({
      prune: callerReserve,
      dynamic: { ledger, snapshot: () => ({}) },
    }, { stepNumber: 1, messages });
    expect(result).toBeDefined();
    expect(outputText(resultPart(result!.messages[2]))).toContain('…[truncated:');
  });

  test('cache markers land LAST, on the pruned array', async () => {
    const messages = bigTurn();
    const result = await composePrepareStep(
      { cache: { strategy: { kind: 'anthropic' } }, prune: budgetFor(WINDOW) },
      { stepNumber: 3, messages },
    );
    expect(result).toBeDefined();
    const out = result!.messages;
    // Pruning happened…
    expect(outputText(resultPart(out[2]))).toContain('…[truncated:');
    // …and the tail breakpoints ride the FINAL two messages.
    const marked = out.filter((m) =>
      JSON.stringify(m.providerOptions ?? {}).includes('cacheControl'));
    expect(marked).toHaveLength(2);
    expect(marked[0]).toBe(out[out.length - 2]);
    expect(marked[1]).toBe(out[out.length - 1]);
  });
});

// KINU-045. The admission used to keep a flat 0.7 share of the window
// (STEP_CONTEXT_BUDGET_RATIO), a number nobody could point at a fact for.
// It now reserves the resolved model's own answer allowance, bounded by the
// only split the window can guarantee both claimants.
describe('outputReserveTokens', () => {
  // Pairs read from models.dev/api.json for the exact models this repo
  // resolves: the first two publish an allowance well under half their window,
  // the last two publish an allowance that IS their whole window.
  const CATALOG: Array<[string, number, number, number]> = [
    ['anthropic/claude-opus-4-7', 1_000_000, 128_000, 128_000],
    ['deepseek/deepseek-v4-pro', 1_000_000, 384_000, 384_000],
    ['moonshotai/kimi-k2.7-code', 262_144, 262_144, 131_072],
    ['xai/grok-4.6', 500_000, 500_000, 250_000],
  ];

  test.each(CATALOG)(
    '%s reserves %d of %d as %d',
    (_spec, contextWindow, modelOutputLimit, reserved) => {
      expect(outputReserveTokens({ contextWindow, modelOutputLimit })).toBe(reserved);
    },
  );

  test('a published allowance that fills the window still leaves half for the instruction', () => {
    // The whole point of the bound: subtracting such an allowance verbatim
    // admits nothing, and `pruneStepToolOutputs` reads a non-positive limit as
    // "do not prune", so the pass would switch itself off for exactly the
    // models that need it most.
    const shared: ModelWindow = { contextWindow: 262_144, modelOutputLimit: 262_144 };
    expect(stepContextLimit(shared)).toBe(131_072);
    expect(pruneStepToolOutputs(bigTurn(), shared)).toBeUndefined();

    const tight: ModelWindow = { contextWindow: WINDOW, modelOutputLimit: WINDOW };
    expect(stepContextLimit(tight)).toBe(WINDOW / 2);
    expect(pruneStepToolOutputs(bigTurn(), tight)).toBeDefined();
  });

  test.each([
    [0, 0], [1, 0], [1, 5], [7, 3], [1_000, 999], [128_000, 128_000],
    [1_048_576, 384_000], [262_144, 262_144], [500_000, 1_000_000],
  ])('window %d / allowance %d holds every invariant', (contextWindow, modelOutputLimit) => {
    const limits: ModelWindow = { contextWindow, modelOutputLimit };
    const reserved = outputReserveTokens(limits);
    const admitted = stepContextLimit(limits);
    expect(reserved).toBeLessThanOrEqual(modelOutputLimit);
    expect(reserved).toBeLessThanOrEqual(Math.floor(contextWindow / 2));
    expect(admitted + reserved).toBe(contextWindow);
    expect(admitted).toBeGreaterThanOrEqual(reserved);
    expect(Number.isInteger(reserved)).toBe(true);
    // The five above are all satisfied by reserving NOTHING, which a mutation
    // run proved: replacing the body with `return 0` left this table green
    // while eleven other tests went red. These two are the discriminator — a
    // declared allowance always gets room, and an allowance the window can
    // afford is reserved in full rather than shaved.
    if (modelOutputLimit > 0 && contextWindow > 1) expect(reserved).toBeGreaterThan(0);
    if (modelOutputLimit <= Math.floor(contextWindow / 2)) expect(reserved).toBe(modelOutputLimit);
  });

  test('a larger allowance admits less, strictly so until the half bound takes over', () => {
    const window = 262_144;
    const half = window / 2;
    const allowances = [4_000, 20_000, 64_000, half, window];
    const admitted = allowances
      .map((modelOutputLimit) => stepContextLimit({ contextWindow: window, modelOutputLimit }));
    // Never increasing, whatever the allowance does.
    expect(admitted).toEqual([...admitted].sort((a, b) => b - a));
    // Strictly decreasing while the allowance is the binding constraint.
    const bound = admitted.slice(0, allowances.indexOf(half) + 1);
    for (let i = 1; i < bound.length; i++) expect(bound[i]).toBeLessThan(bound[i - 1]);
    // Past the bound the split is the constraint, so nothing moves further.
    expect(admitted.at(-1)).toBe(half);
    expect(admitted.at(-2)).toBe(half);
  });
});
