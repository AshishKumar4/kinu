#!/usr/bin/env bun
/**
 * What the eval tier's run actually cost, summed across suite processes.
 *
 * "State the cost per run" is not answerable with a constant. These suites let
 * the model take up to 500 steps, so the bill is decided by what the model
 * chose to do — which is the thing under test. So each suite process appends its
 * own measured totals to `KINU_EVAL_SPEND_FILE` (see
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
import { addUsage, usageReported, UsageSchema } from '../packages/core/src/index';
import type { Usage } from '../packages/core/src/index';

/** One suite process's line. `usage` is the same `Usage` the meter accumulates
 *  (packages/test-utils/src/live-model.ts), parsed rather than trusted, so a line
 *  whose fields are absent stays absent here — the whole point being that this
 *  file's totals are a floor over the calls a provider actually reported, with
 *  `callsWithoutUsage` saying how many it did not. */
const SpendLineSchema = v.object({
  suite: v.string(),
  calls: v.number(),
  callsWithoutUsage: v.number(),
  usage: UsageSchema,
  /** Episodes the suite drove and could not account for. A suite line with
   *  `calls: 0` and this above 0 is a HOLE, not a free tier, and the render
   *  below says which. */
  episodesUnmeasured: v.number(),
  /** Episodes the suite declared drive no model, with the store agreeing. A
   *  measured zero, so it never counts against liveness. */
  episodesWithoutModel: v.number(),
});
export type SpendLine = v.InferOutput<typeof SpendLineSchema>;

export interface SpendTotals {
  readonly suites: number;
  readonly calls: number;
  readonly callsWithoutUsage: number;
  readonly usage: Usage;
  readonly episodesUnmeasured: number;
  readonly episodesWithoutModel: number;
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
    usage: lines.reduce<Usage>((total, l) => addUsage(total, l.usage), {}),
    episodesUnmeasured: lines.reduce((n, l) => n + l.episodesUnmeasured, 0),
    episodesWithoutModel: lines.reduce((n, l) => n + l.episodesWithoutModel, 0),
  };
}

/**
 * The report. A zero-call run says so in the same shape a paid one does, because
 * "this tier cost nothing" and "this tier was not measured" have to be
 * different sentences — and a suite that drove episodes it could not account for
 * is named, since its zero is the second sentence wearing the first one's clothes.
 */
export function renderSpend(lines: readonly SpendLine[]): string {
  const total = totalSpend(lines);
  const rows = lines.map((l) =>
    `  ${l.suite}: ${String(l.calls)} call(s), ${l.usage.input ?? 'unreported'} in / `
    + `${l.usage.output ?? 'unreported'} out`
    + (l.callsWithoutUsage > 0 ? `, ${String(l.callsWithoutUsage)} unreported` : '')
    + (l.episodesUnmeasured > 0
      ? `, ${String(l.episodesUnmeasured)} EPISODE(S) UNACCOUNTED — this line is not this `
        + 'suite\'s cost'
      : '')
    + (l.episodesWithoutModel > 0
      ? `, ${String(l.episodesWithoutModel)} episode(s) declared no model`
      : ''));

  if (total.suites === 0) {
    return 'eval-tier cost: no suite reported spend — either nothing ran, or a suite '
      + 'did not call reportLiveModelSpend in its teardown';
  }
  const unreported = total.callsWithoutUsage > 0
    ? ` (${String(total.callsWithoutUsage)} call(s) the provider reported no usage for, so the `
      + 'token totals under-count those)'
    : '';
  // Named on its own line rather than folded into the parenthetical above: an
  // unaccounted episode is not an under-count of a known size, it is a piece of
  // the run whose cost this file cannot bound at all, and a reader has to be able
  // to tell those two apart before quoting the total.
  const unaccounted = total.episodesUnmeasured > 0
    ? `\n  NOT A TOTAL: ${String(total.episodesUnmeasured)} episode(s) ran whose spend no suite `
      + 'could account for, so the figure above is a floor of unknown distance from the bill'
    : '';
  return [
    `eval-tier cost per run, measured over ${String(total.suites)} suite(s):`,
    ...rows,
    `  TOTAL: ${String(total.calls)} model call(s), ${total.usage.input ?? 'unreported'} input + `
    + `${total.usage.output ?? 'unreported'} output tokens${unreported}${unaccounted}`,
  ].join('\n');
}

/**
 * Whether a run PROVED it exercised a model — the assertion this file exists to
 * carry, and the one it used to lack.
 *
 * WHY. `renderSpend` above already prints the difference between a tier that
 * spent nothing and a tier that measured nothing. It printed
 * `TOTAL: 0 model call(s)` for a run of six live suites, over a credential that
 * was present, and the script exited 0 — so `run_required_gate "Behavioural
 * evals"` in scripts/deploy.sh passed a deploy over a tier that had called no
 * model at all. A gate that renders the defect and returns success is the
 * "green over the empty set" shape AGENTS.md § Build & Check records; the render
 * was never the missing half, the exit code was.
 *
 * `expected` is whether the tier RESOLVED a target, decided by
 * scripts/eval-tier.sh which is the one place that knows. It is not the same
 * question as "did anything run": with no credential anywhere the tier is
 * deliberately allowed to skip everything and pass, because a tier that cannot
 * run without a secret reproduces nowhere and the skip-ratchet is what keeps
 * those skips declared. So the rule is conditional and states which condition it
 * is under, rather than banning a zero outright.
 */
export type LivenessVerdict =
  /** A target was resolved and the run measured real calls against it. */
  | { readonly kind: 'proven'; readonly calls: number; readonly detail: string }
  /** A target was resolved and the run cannot show it reached a model. */
  | { readonly kind: 'unproven'; readonly reason: string }
  /** No target — nothing to prove, and saying so is not the same as passing. */
  | { readonly kind: 'unconfigured' };

/**
 * The three ways a resolved target still fails to produce evidence, in the order
 * a reader needs them: nothing reported at all, nothing called, or called and
 * unaccounted. Each is a different repair, so each is a different sentence.
 */
export function livenessVerdict(
  lines: readonly SpendLine[],
  expected: boolean,
): LivenessVerdict {
  if (!expected) return { kind: 'unconfigured' };
  const total = totalSpend(lines);

  if (total.suites === 0) {
    return {
      kind: 'unproven',
      reason: 'a live-model target was resolved and NO suite reported spend. Either every '
        + 'suite skipped despite the target, or no suite reached the '
        + '`reportLiveModelSpend` call in its teardown — both are a tier measuring nothing '
        + 'while exiting 0.',
    };
  }
  if (total.calls === 0) {
    return {
      kind: 'unproven',
      reason: `a live-model target was resolved and ${String(total.suites)} suite(s) reported `
        + '0 model calls between them. The tier ran without reaching a model, so every '
        + 'behavioural assertion it made was vacuous.',
    };
  }
  // Checked AFTER the call count, because a run with calls AND a hole did reach a
  // model — it just cannot bound what that cost. Different defect, so it is not
  // allowed to borrow the sentence above.
  if (total.episodesUnmeasured > 0) {
    return {
      kind: 'unproven',
      reason: `${String(total.episodesUnmeasured)} episode(s) ran whose spend no suite could `
        + `account for, alongside ${String(total.calls)} measured call(s). The reported total is `
        + 'a floor of unknown distance from the bill, which is the shape that reported '
        + '`0 model call(s)` over ~584,751 real neurons.',
    };
  }
  if (!usageReported(total.usage)) {
    return {
      kind: 'unproven',
      reason: `${String(total.calls)} call(s) were made and NOT ONE reported token usage, so the `
        + 'tier can show it reached a model but cannot say what it spent. A call count '
        + 'without a token count is half a measurement.',
    };
  }
  return {
    kind: 'proven',
    calls: total.calls,
    detail: `${String(total.calls)} model call(s) over ${String(total.suites)} suite(s), `
      + `${String(total.usage.input ?? 0)} input + ${String(total.usage.output ?? 0)} output tokens`,
  };
}

/** One line stating the verdict, in the same register as the report above it. */
export function renderLiveness(verdict: LivenessVerdict): string {
  switch (verdict.kind) {
    case 'proven':
      return `eval-tier liveness: PROVEN — ${verdict.detail}`;
    case 'unproven':
      return `eval-tier liveness: UNPROVEN — ${verdict.reason}`;
    case 'unconfigured':
      return 'eval-tier liveness: not asserted — no live-model target was resolved, so this '
        + 'run had nothing to prove. The skip-ratchet is what holds the skips accountable.';
  }
}

if (import.meta.main) {
  // `--expect-live` is scripts/eval-tier.sh saying it resolved a target. Passed
  // in rather than re-derived from the environment here, because this process
  // does not see the credential the tier borrowed from the signed-in CLI
  // session, and a second resolver would be a second answer to the one question
  // the banner already printed.
  const args = process.argv.slice(2);
  const expectLive = args.includes('--expect-live');
  const path = args.find((arg) => !arg.startsWith('--'));
  if (path === undefined) {
    console.error('usage: bun scripts/eval-spend.ts <spend.jsonl> [--expect-live]');
    process.exit(1);
  }
  const text = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const lines = parseSpend(text);
  console.log(renderSpend(lines));

  const verdict = livenessVerdict(lines, expectLive);
  console.log(renderLiveness(verdict));
  if (verdict.kind === 'unproven') process.exit(1);
}
