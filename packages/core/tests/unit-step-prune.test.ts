// Step-boundary tool-output pruning (prompting/step-prune.ts) and its place in composePrepareStep.
import { describe, test, expect } from 'bun:test';
import type { ModelMessage, ToolResultPart } from 'ai';
import {
  pruneStepToolOutputs,
  composePrepareStep,
  DynamicContextLedger,
  outputReserveTokens,
  stepContextLimit,
  type ModelWindow,
} from '../src/index';
import { present } from '@kinu.run/test-utils';

function toolExchange(i: number, outputChars: number): ModelMessage[] {
  const id = `call_${i}`;

  return [
    {
      role: 'assistant',
      content: [
        { type: 'text', text: `Running step ${i}.` },
        { type: 'tool-call', toolCallId: id, toolName: 'shell', input: { command: `step-${i}.sh` } },
      ],
    },
    {
      role: 'tool',
      content: [{
        type: 'tool-result', toolCallId: id, toolName: 'shell',
        output: { type: 'text', value: `output-${i} ${'x'.repeat(outputChars)}` },
      }],
    },
  ];
}

/** 6 exchanges of 40k chars against a 64k window / 20k allowance: the oldest three must shrink.
 *  Exchange i's tool message sits at index 2+2i. */
function bigTurn(): ModelMessage[] {
  const messages: ModelMessage[] = [{ role: 'user', content: 'go' }];

  for (let i = 0; i < 6; i++) messages.push(...toolExchange(i, 40_000));

  return messages;
}

const WINDOW = 64_000;

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
    const pruned = present(pruneStepToolOutputs(messages, budgetFor(WINDOW)), 'pruned step');

    expect(pruned.length).toBe(messages.length);
    expect(pruned.map((m) => m.role)).toEqual(messages.map((m) => m.role));

    for (const idx of [2, 4, 6]) {
      const part = resultPart(pruned[idx]);
      const text = outputText(part);
      expect(text.length).toBeLessThan(2_200);
      expect(text.startsWith('output-')).toBe(true);
      expect(text).toContain('…[truncated: full output was');
      expect(text).toContain('; re-run the tool if needed]');
      // The marker reports the original serialized size.
      expect(text).toContain(`${outputText(resultPart(messages[idx])).length} chars`);
    }

    for (const idx of [8, 10, 12]) {
      expect(pruned[idx]).toBe(messages[idx]);
    }

    expect(pruned[0]).toBe(messages[0]);
    expect(pruned[1]).toBe(messages[1]);
    expect(outputText(resultPart(messages[2])).length).toBeGreaterThan(40_000);
  });

  test('byte-stable across steps: a grown array re-truncates old parts to identical bytes', () => {
    const stepN = bigTurn();
    const stepN1 = [...bigTurn(), ...toolExchange(6, 40_000)];
    const prunedN = present(pruneStepToolOutputs(stepN, budgetFor(WINDOW)), 'pruned step');
    const prunedN1 = present(pruneStepToolOutputs(stepN1, budgetFor(WINDOW)), 'pruned step');

    for (const idx of [2, 4, 6]) {
      expect(outputText(resultPart(prunedN1[idx]))).toBe(outputText(resultPart(prunedN[idx])));
    }

    // This fixture crosses a batch line, so the boundary advances; no truncated part ever un-truncates.
    expect(prunedN[8]).toBe(stepN[8]);
    expect(outputText(resultPart(prunedN1[8]))).toContain('…[truncated:');
    expect(prunedN1.length).toBe(stepN1.length);
  });

  test('idempotent: already-truncated outputs are never re-truncated', () => {
    const pruned = present(pruneStepToolOutputs(bigTurn(), budgetFor(WINDOW)), 'pruned step');
    expect(pruneStepToolOutputs(pruned, budgetFor(WINDOW))).toBeUndefined();
  });

  test('re-pruning already-truncated outputs keeps identical bytes', () => {
    const pruned = present(pruneStepToolOutputs(bigTurn(), budgetFor(WINDOW)), 'pruned step');
    const first = outputText(resultPart(pruned[2]));
    expect(first).toContain('…[truncated:');
    const grown = [...pruned, ...toolExchange(6, 40_000), ...toolExchange(7, 40_000), ...toolExchange(8, 40_000)];
    const repruned = present(pruneStepToolOutputs(grown, budgetFor(WINDOW)), 'pruned step');
    expect(outputText(resultPart(repruned[2]))).toBe(first);
    expect(first).toContain(`${outputText(resultPart(bigTurn()[2])).length} chars`);
  });

  test('error outputs keep error semantics through truncation', () => {
    const messages = bigTurn();
    const message = messages[2];

    if (!message || message.role !== 'tool') throw new Error('expected tool message');
    message.content[0] = {
      type: 'tool-result', toolCallId: 'call_0', toolName: 'shell',
      output: { type: 'error-text', value: `boom ${'e'.repeat(40_000)}` },
    };
    const pruned = present(pruneStepToolOutputs(messages, budgetFor(WINDOW)), 'pruned step');
    const part = resultPart(pruned[2]);
    expect(part.output.type).toBe('error-text');
    expect(outputText(part)).toContain('…[truncated:');
  });

  // The SDK rebuilds every step from the original history, so the pass never sees its own output;
  // its bytes must stay identical until a whole batch of new output arrives, or each step is a cache write.
  test('the boundary moves once per batch, not once per step', () => {
    const limits: ModelWindow = { contextWindow: 200_000, modelOutputLimit: 64_000 };
    const STEPS = 40;
    const turn: ModelMessage[] = [{ role: 'user', content: 'ship the feature' }];
    let previous: string | null = null;
    const moved: number[] = [];

    for (let step = 0; step < STEPS; step++) {
      turn.push(...toolExchange(step, 24_000));
      const request = JSON.stringify(pruneStepToolOutputs(turn, limits) ?? turn);

      if (previous !== null && !request.startsWith(previous.slice(0, previous.lastIndexOf(']')))) {
        moved.push(step);
      }

      previous = request;
    }

    // The boundary must move once per batch, never on consecutive steps.
    expect(moved.length).toBeGreaterThan(0);
    expect(moved.length).toBeLessThanOrEqual(STEPS / 5);

    for (let i = 1; i < moved.length; i++) {
      expect(moved[i]).toBeGreaterThan(moved[i - 1] + 1);
    }
  });

  test('a pass frees a share of the allocation, so a larger window frees more per pass', () => {
    // The quantum is a share of the allocation, not a fixed token count.
    const truncatedByFirstPass = (limits: ModelWindow): number => {
      const turn: ModelMessage[] = [{ role: 'user', content: 'go' }];

      for (let step = 0; ; step++) {
        turn.push(...toolExchange(step, 8_000));
        const pruned = pruneStepToolOutputs(turn, limits);

        if (pruned !== undefined) return pruned.filter((message, i) => message !== turn[i]).length;
      }
    };

    const sonnet = truncatedByFirstPass({ contextWindow: 200_000, modelOutputLimit: 64_000 });
    const million = truncatedByFirstPass({ contextWindow: 1_000_000, modelOutputLimit: 128_000 });
    expect(sonnet).toBeGreaterThan(1);
    expect(million).toBeGreaterThan(sonnet);
  });
});

describe('composePrepareStep with pruning', () => {
  test('prune applies without extensions or a cache plan', async () => {
    const messages = bigTurn();
    const result = present(await composePrepareStep({ prune: budgetFor(WINDOW) }, { stepNumber: 3, messages, steps: [] }), 'prepared step');
    expect(result.messages.length).toBe(messages.length);
    expect(outputText(resultPart(result.messages[2]))).toContain('…[truncated:');
  });

  test('under budget with no extensions → no step override at all', async () => {
    const messages = bigTurn();
    expect(await composePrepareStep({ prune: budgetFor(400_000) }, { stepNumber: 3, messages, steps: [] }))
      .toBeUndefined();
    expect(await composePrepareStep({}, { stepNumber: 3, messages, steps: [] })).toBeUndefined();
  });

  // Pruning precedes the weave, so the pruner must reserve room for the ledger blocks the weave adds back.
  test('the pruner is charged for the ledger blocks the weave adds back', async () => {
    const messages = bigTurn();
    const budget: ModelWindow = { contextWindow: 120_000, modelOutputLimit: 36_000 };
    expect(await composePrepareStep({ prune: budget }, { stepNumber: 3, messages, steps: [] }))
      .toBeUndefined();

    const ledger = new DynamicContextLedger();

    for (let i = 0; i < 20; i++) {
      ledger.weave(messages, { memoryTail: `lesson ${i}: ${'m'.repeat(6_000)}` });
    }

    expect(ledger.size).toBe(20);

    const result = present(await composePrepareStep({
      prune: budget,
      dynamic: { ledger, snapshot: () => ({}) },
    }, { stepNumber: 3, messages, steps: [] }), 'prepared step');

    expect(outputText(resultPart(result.messages[2]))).toContain('…[truncated:');
  });

  test('a caller-supplied prune reserve adds to the ledger overhead', async () => {
    const messages: ModelMessage[] = [{ role: 'user', content: 'go' }];

    for (let i = 0; i < 6; i++) messages.push(...toolExchange(i, 28_000));
    const callerReserve = { ...budgetFor(WINDOW), reservedTokens: 5_000 };
    const bare = present(await composePrepareStep({ prune: callerReserve }, { stepNumber: 1, messages, steps: [] }), 'prepared step');
    expect(outputText(resultPart(bare.messages[2]))).toContain('…[truncated:');
    const ledger = new DynamicContextLedger();

    const result = present(await composePrepareStep({
      prune: callerReserve,
      dynamic: { ledger, snapshot: () => ({}) },
    }, { stepNumber: 1, messages, steps: [] }), 'prepared step');

    expect(outputText(resultPart(result.messages[2]))).toContain('…[truncated:');
  });

  test('cache markers land LAST, on the pruned array', async () => {
    const messages = bigTurn();
    const result = present(await composePrepareStep({ cache: { strategy: { kind: 'anthropic' } }, prune: budgetFor(WINDOW) }, { stepNumber: 3, messages, steps: [] }), 'prepared step');
    const out = result.messages;
    expect(outputText(resultPart(out[2]))).toContain('…[truncated:');

    // Tail breakpoints ride the final two messages.
    const marked = out.filter((m) =>
      JSON.stringify(m.providerOptions ?? {}).includes('cacheControl'));

    expect(marked).toHaveLength(2);
    expect(marked[0]).toBe(out[out.length - 2]);
    expect(marked[1]).toBe(out[out.length - 1]);
  });
});

// KINU-045: reserve the model's own answer allowance, bounded by the split the window can guarantee.
describe('outputReserveTokens', () => {
  // Pairs from models.dev/api.json; the last two publish an allowance equal to their whole window.
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
    // A non-positive limit reads as "do not prune", which would switch the pass off for these models.
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

    // These two reject a body that reserves nothing, which satisfies the five above.
    if (modelOutputLimit > 0 && contextWindow > 1) expect(reserved).toBeGreaterThan(0);

    if (modelOutputLimit <= Math.floor(contextWindow / 2)) expect(reserved).toBe(modelOutputLimit);
  });

  test('a larger allowance admits less, strictly so until the half bound takes over', () => {
    const window = 262_144;
    const half = window / 2;
    const allowances = [4_000, 20_000, 64_000, half, window];

    const admitted = allowances
      .map((modelOutputLimit) => stepContextLimit({ contextWindow: window, modelOutputLimit }));

    expect(admitted).toEqual([...admitted].sort((a, b) => b - a));
    const bound = admitted.slice(0, allowances.indexOf(half) + 1);

    for (let i = 1; i < bound.length; i++) expect(bound[i]).toBeLessThan(bound[i - 1]);
    expect(admitted.at(-1)).toBe(half);
    expect(admitted.at(-2)).toBe(half);
  });
});
