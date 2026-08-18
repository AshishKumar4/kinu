/**
 * The live-spend meter's own arithmetic.
 *
 * This is the module that answers "what did this run cost", and it answered wrong
 * in two directions at once. The behavioural tier reported `0 model call(s),
 * unreported in / unreported out tokens` over a run that spent ~584,751 neurons,
 * because nothing fed the meter and `calls: 0` could not say the difference
 * between "cost nothing" and "was never measured". And every suite line after the
 * first was a running total of its predecessors, which `scripts/eval-spend.ts`
 * then SUMMED — so the same tokens were counted once per reporting suite.
 *
 * Both are money numbers, so both get tests that fail on the old behaviour. The
 * per-episode path needs a real agent store and is proven end to end against a
 * scripted model in `tests/evals/harness-wiring.test.ts`; what is proven here is
 * the accumulation, the draining and the absence rules that make a total either
 * correct or visibly incomplete.
 */
import { describe, test, expect, beforeEach } from 'bun:test';
import type { LanguageModelUsage } from 'ai';
import {
  liveModelSpend, recordLiveModelSpend, reportLiveModelSpend, resetLiveModelSpend,
} from '../src/live-model';

// Module-level counters, so each case starts from a stated zero rather than from
// whatever the previous one left behind.
beforeEach(() => { resetLiveModelSpend(); });

/**
 * A provider usage payload in the AI SDK's own shape.
 *
 * One factory rather than a literal per case: the SDK's type requires two detail
 * objects this meter never reads, and repeating them six times would bury the one
 * thing each case is about — which counts the provider reported and which it did
 * not. `undefined` here means the provider omitted the count, which is precisely
 * the input the absence rules are written for.
 */
function sdkUsage(input: number | undefined, output: number | undefined): LanguageModelUsage {
  return {
    inputTokens: input,
    inputTokenDetails: {
      noCacheTokens: undefined, cacheReadTokens: undefined, cacheWriteTokens: undefined,
    },
    outputTokens: output,
    outputTokenDetails: { textTokens: undefined, reasoningTokens: undefined },
    totalTokens: input === undefined || output === undefined ? undefined : input + output,
  };
}

describe('recordLiveModelSpend — one call at a time', () => {
  test('a reported call adds its tokens and counts once', () => {
    recordLiveModelSpend(sdkUsage(100, 10));
    const spend = liveModelSpend();
    expect(spend.calls).toBe(1);
    expect(spend.callsWithoutUsage).toBe(0);
    expect(spend.usage.input).toBe(100);
    expect(spend.usage.output).toBe(10);
  });

  test('a call the provider reported nothing for is counted, never priced at zero', () => {
    recordLiveModelSpend(undefined);
    const spend = liveModelSpend();
    // The call happened and cost something. What is unknown is how much.
    expect(spend.calls).toBe(1);
    expect(spend.callsWithoutUsage).toBe(1);
    // ABSENT, not 0. `input: 0` would read as a measured zero and is the exact
    // fabrication the Usage contract exists to prevent.
    expect(spend.usage.input).toBeUndefined();
    expect(spend.usage.output).toBeUndefined();
  });

  test('a partial report contributes only the field the provider sent', () => {
    recordLiveModelSpend(sdkUsage(undefined, 7));
    const spend = liveModelSpend();
    // Something was reported, so this is not an unmeasured call...
    expect(spend.callsWithoutUsage).toBe(0);
    expect(spend.usage.output).toBe(7);
    // ...but the side the provider omitted stays omitted. `+= input ?? 0` here is
    // what turns a floor into a number that reads as measured.
    expect(spend.usage.input).toBeUndefined();
  });
});

describe('reportLiveModelSpend — a line is the suite\'s own spend, not a running total', () => {
  test('reporting drains, so two suites in one process do not double-count', () => {
    // `bun test ./tests/` runs every root suite in ONE process against this one
    // module-level meter. Suite A spends, reports, and suite B then reports its
    // own nothing.
    recordLiveModelSpend(sdkUsage(100, 10));
    const first = reportLiveModelSpend('Suite A');
    expect(first.calls).toBe(1);
    expect(first.usage.input).toBe(100);

    const second = reportLiveModelSpend('Suite B');
    // THE OVER-COUNT, in one line: this used to be 1 call and 100 input tokens
    // again — suite B claiming suite A's spend — and `totalSpend` sums the lines,
    // so the tier published 200 input tokens for 100 spent.
    expect(second.calls).toBe(0);
    expect(second.usage.input).toBeUndefined();
  });

  test('spend recorded after a report belongs to the next report', () => {
    recordLiveModelSpend(sdkUsage(100, 10));
    reportLiveModelSpend('Suite A');
    recordLiveModelSpend(sdkUsage(5, 1));

    const second = reportLiveModelSpend('Suite B');
    // Suite B's own spend, whole and unmixed: the two lines now partition the
    // process's calls instead of overlapping.
    expect(second.calls).toBe(1);
    expect(second.usage.input).toBe(5);
  });

  test('the returned line is the shape the aggregate parses', () => {
    recordLiveModelSpend(undefined);
    const total = reportLiveModelSpend('Suite A');
    // `reportLiveModelSpend` appends `{ suite, ...total }`, and
    // `scripts/eval-spend.ts` parses exactly these four fields. A field missing
    // here is a field the tier's cost report silently drops.
    expect(Object.keys(total).sort())
      .toEqual(['calls', 'callsWithoutUsage', 'episodesUnmeasured', 'usage']);
  });
});

describe('resetLiveModelSpend — a scripted suite clears instead of publishing', () => {
  test('reset returns every counter to its stated zero', () => {
    recordLiveModelSpend(sdkUsage(100, 10));
    recordLiveModelSpend(undefined);
    resetLiveModelSpend();

    const spend = liveModelSpend();
    expect(spend.calls).toBe(0);
    expect(spend.callsWithoutUsage).toBe(0);
    expect(spend.episodesUnmeasured).toBe(0);
    // Cleared to ABSENT, so a later suite's first report cannot inherit a zero
    // that reads as measured.
    expect(spend.usage.input).toBeUndefined();
  });

  test('a fresh meter reports the one honest zero: nothing ran and nothing is missing', () => {
    const spend = liveModelSpend();
    expect(spend.calls).toBe(0);
    // This is the ONLY state in which a clean zero is the truth, and it is what
    // distinguishes it from a tier that drove episodes it could not account for.
    expect(spend.episodesUnmeasured).toBe(0);
  });
});
