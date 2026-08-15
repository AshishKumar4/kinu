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
  STEP_CONTEXT_BUDGET_RATIO,
  STEP_RECENT_TOOL_BUDGET_TOKENS,
} from '../src/index.ts';

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
 *  Against a 64k window (budget 44.8k) the newest three results fill the 40k
 *  recent budget and the oldest three must shrink. Exchange i's tool message
 *  sits at array index 2+2i. */
function bigTurn(): ModelMessage[] {
  const messages: ModelMessage[] = [{ role: 'user', content: 'go' }];
  for (let i = 0; i < 6; i++) messages.push(...toolExchange(i, 40_000));
  return messages;
}

const WINDOW = 64_000;

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
    expect(pruneStepToolOutputs(bigTurn(), { contextWindow: 400_000 })).toBeUndefined();
    expect(pruneStepToolOutputs([{ role: 'user', content: 'hi' }], { contextWindow: 1000 })).toBeUndefined();
  });

  test('over budget → OLD tool outputs shrink to head + marker, recent budget stays verbatim', () => {
    const messages = bigTurn();
    const pruned = pruneStepToolOutputs(messages, { contextWindow: WINDOW });
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
      expect(text).toContain('— re-run the tool if needed]');
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
    const prunedN = pruneStepToolOutputs(stepN, { contextWindow: WINDOW })!;
    const prunedN1 = pruneStepToolOutputs(stepN1, { contextWindow: WINDOW })!;
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
    const pruned = pruneStepToolOutputs(bigTurn(), { contextWindow: WINDOW })!;
    // The pruned array is under budget now — nothing further to do.
    expect(pruneStepToolOutputs(pruned, { contextWindow: WINDOW })).toBeUndefined();
  });

  test('error outputs keep error semantics through truncation', () => {
    const messages = bigTurn();
    const message = messages[2];
    if (!message || message.role !== 'tool') throw new Error('expected tool message');
    message.content[0] = {
      type: 'tool-result', toolCallId: 'call_0', toolName: 'run',
      output: { type: 'error-text', value: `boom ${'e'.repeat(40_000)}` },
    };
    const pruned = pruneStepToolOutputs(messages, { contextWindow: WINDOW })!;
    const part = resultPart(pruned[2]);
    expect(part.output.type).toBe('error-text');
    expect(outputText(part)).toContain('…[truncated:');
  });

  test('the exported budget constants are what the pipeline advertises', () => {
    expect(STEP_CONTEXT_BUDGET_RATIO).toBe(0.7);
    expect(STEP_RECENT_TOOL_BUDGET_TOKENS).toBe(40_000);
  });
});

describe('composePrepareStep with pruning', () => {
  test('prune applies without extensions or a cache plan', () => {
    const messages = bigTurn();
    const result = composePrepareStep({ prune: { contextWindow: WINDOW } }, { stepNumber: 3, messages });
    expect(result).toBeDefined();
    expect(result!.messages.length).toBe(messages.length);
    expect(outputText(resultPart(result!.messages[2]))).toContain('…[truncated:');
  });

  test('under budget with no extensions → no step override at all', () => {
    const messages = bigTurn();
    expect(composePrepareStep({ prune: { contextWindow: 400_000 } }, { stepNumber: 3, messages }))
      .toBeUndefined();
    expect(composePrepareStep({}, { stepNumber: 3, messages })).toBeUndefined();
  });

  test('cache markers land LAST, on the pruned array', () => {
    const messages = bigTurn();
    const result = composePrepareStep(
      { cache: { strategy: { kind: 'anthropic' } }, prune: { contextWindow: WINDOW } },
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
