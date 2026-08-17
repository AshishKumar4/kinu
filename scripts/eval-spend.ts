#!/usr/bin/env bun
/**
 * What the eval tier's run actually cost, summed across suite processes.
 *
 * "State the cost per run" is not answerable with a constant. These suites let
 * the model take up to 500 steps, so the bill is decided by what the model
 * chose to do — which is the thing under test. So each suite process appends its
 * own measured totals to `PROTEUS_EVAL_SPEND_FILE` (see
 * packages/test-utils/src/live-model.ts `reportLiveModelSpend`) and this sums
 * them into the one number a run reports.
 *
 * Deliberately NOT a dollar figure. A price is a platform number, and this
 * repo's rule is that platform numbers come from `packages/core/src/
 * platform-catalog.ts` with an evidence label — which carries limits in bytes,
 * ms and counts, not prices. Tokens and call counts are things this run
 * MEASURED; a dollar figure would be a number nobody cited.
 *
 * Suites are separate processes (Bun keeps one module mock per specifier for a
 * whole run, so per-package isolation is load-bearing), which is why this is a
 * file rather than a shared in-memory counter.
 */
import { existsSync, readFileSync } from 'node:fs';
import * as v from 'valibot';

const SpendLineSchema = v.object({
  suite: v.string(),
  calls: v.number(),
  callsWithoutUsage: v.number(),
  inputTokens: v.number(),
  outputTokens: v.number(),
});
export type SpendLine = v.InferOutput<typeof SpendLineSchema>;

export interface SpendTotals {
  readonly suites: number;
  readonly calls: number;
  readonly callsWithoutUsage: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export function parseSpend(text: string): SpendLine[] {
  return text.split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => v.parse(SpendLineSchema, JSON.parse(line)));
}

export function totalSpend(lines: readonly SpendLine[]): SpendTotals {
  return {
    suites: lines.length,
    calls: lines.reduce((n, l) => n + l.calls, 0),
    callsWithoutUsage: lines.reduce((n, l) => n + l.callsWithoutUsage, 0),
    inputTokens: lines.reduce((n, l) => n + l.inputTokens, 0),
    outputTokens: lines.reduce((n, l) => n + l.outputTokens, 0),
  };
}

/**
 * The report. A zero-call run says so in the same shape a paid one does, because
 * "this tier cost nothing" and "this tier was not measured" have to be
 * different sentences.
 */
export function renderSpend(lines: readonly SpendLine[]): string {
  const total = totalSpend(lines);
  const rows = lines.map((l) =>
    `  ${l.suite}: ${String(l.calls)} call(s), ${String(l.inputTokens)} in / `
    + `${String(l.outputTokens)} out`
    + (l.callsWithoutUsage > 0 ? `, ${String(l.callsWithoutUsage)} unreported` : ''));

  if (total.suites === 0) {
    return 'eval-tier cost: no suite reported spend — either nothing ran, or a suite '
      + 'did not call reportLiveModelSpend in its teardown';
  }
  const unreported = total.callsWithoutUsage > 0
    ? ` (${String(total.callsWithoutUsage)} call(s) the provider reported no usage for, so the `
      + 'token totals under-count those)'
    : '';
  return [
    `eval-tier cost per run, measured over ${String(total.suites)} suite(s):`,
    ...rows,
    `  TOTAL: ${String(total.calls)} model call(s), ${String(total.inputTokens)} input + `
    + `${String(total.outputTokens)} output tokens${unreported}`,
  ].join('\n');
}

if (import.meta.main) {
  const path = process.argv[2];
  if (path === undefined) {
    console.error('usage: bun scripts/eval-spend.ts <spend.jsonl>');
    process.exit(1);
  }
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  console.log(renderSpend(parseSpend(text)));
}
