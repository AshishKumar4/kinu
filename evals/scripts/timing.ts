// Where each trial's wall time went, from the evidence a run kept (`timeline.jsonl` beside `ledger.jsonl`):
//   bun evals/scripts/timing.ts <evidence dir>... [--steps]
// A directory is searched for trials. Each trial prints its turns and its split; the run prints the
// split summed over every trial, and with `--steps` every step's first token, generation and tools.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import * as v from 'valibot';
import { parseJsonValue } from '@kinu.run/core';
import { buckets, LedgerRowSchema, TimelineEntrySchema, trialTiming, type StepTiming, type TrialTiming } from '../src/timing';

const { values, positionals } = parseArgs({ options: { steps: { type: 'boolean' } }, allowPositionals: true });

if (positionals.length === 0) throw new Error('Usage: bun evals/scripts/timing.ts <evidence dir>... [--steps]');

function trials(dir: string): string[] {
  if (existsSync(join(dir, 'timeline.jsonl'))) return [dir];

  return readdirSync(dir).map((name) => join(dir, name)).filter((path) => statSync(path).isDirectory()).flatMap(trials);
}

const jsonl = (path: string): unknown[] => readFileSync(path, 'utf8').split('\n').filter((line) => line !== '').map((line) => parseJsonValue(line));

const s = (ms: number): string => (ms / 1000).toFixed(1);

function quantile(sorted: readonly number[], q: number): number {
  return sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
}

function describe(name: string, timing: TrialTiming): string {
  const lines = [`${name}: ${s(timing.wallMs)}s wall, ${String(timing.turns.length)} turns, `
    + `${String(timing.turns.reduce((sum, turn) => sum + turn.steps.length, 0))} steps`
    + `${timing.unpairedSteps === 0 ? '' : `, ${String(timing.unpairedSteps)} steps unpaired with the ledger`}`];

  for (const [index, turn] of timing.turns.entries()) {
    const requests = turn.steps.map((step) => step.requestMs).sort((left, right) => left - right);
    const rates = turn.steps.filter((step) => step.generationMs > 0).map((step) => step.outputTokens / (step.generationMs / 1000)).sort((left, right) => left - right);
    const sum = (pick: (step: StepTiming) => number) => turn.steps.reduce((total, step) => total + pick(step), 0);
    const spans = Object.entries(turn.harness).map(([span, ms]) => `${span} ${s(ms)}`).join(', ');

    lines.push(`  turn ${String(index + 1)}: ${String(turn.steps.length)} steps; to first token ${s(sum((step) => step.requestMs))}s `
      + `(p50 ${s(quantile(requests, 0.5))}, max ${s(requests.at(-1) ?? 0)}), waits ${s(sum((step) => step.waitMs))}s, `
      + `generation ${s(sum((step) => step.generationMs))}s (${String(sum((step) => step.outputTokens))} tokens, `
      + `p50 ${quantile(rates, 0.5).toFixed(0)} tok/s), tools ${s(sum((step) => step.toolsMs))}s, step close ${s(sum((step) => step.closeMs))}s, `
      + `to stream ${s(turn.openMs)}s, after last step ${s(turn.endMs)}s; harness: ${spans}; `
      + `${String(turn.polls)} polls, ${String(turn.busyPolls)} busy`);

    if (values.steps === true) {
      for (const [at, step] of turn.steps.entries()) {
        lines.push(`    step ${String(at + 1)}: to first token ${s(step.requestMs)}s, wait ${s(step.waitMs)}s, `
          + `generation ${s(step.generationMs)}s for ${String(step.outputTokens)} tokens (${String(step.reasoningTokens)} reasoning), `
          + `tools ${s(step.toolsMs)}s, close ${s(step.closeMs)}s`);
      }
    }
  }

  lines.push(`  harness outside turns: ${Object.entries(timing.harness).map(([span, ms]) => `${span} ${s(ms)}`).join(', ')}`);

  return lines.join('\n');
}

const total: Record<string, number> = {};

let wall = 0;

for (const root of positionals) {
  for (const dir of trials(root)) {
    const timing = trialTiming(
      jsonl(join(dir, 'timeline.jsonl')).map((line) => v.parse(TimelineEntrySchema, line)),
      jsonl(join(dir, 'ledger.jsonl')).map((line) => v.parse(LedgerRowSchema, line)),
    );

    process.stdout.write(`${describe(relative(root, dir) || dir, timing)}\n`);
    wall += timing.wallMs;

    for (const [bucket, ms] of Object.entries(buckets(timing))) total[bucket] = (total[bucket] ?? 0) + ms;
  }
}

process.stdout.write(`\nSummed over trials: ${s(wall)}s\n`);

for (const [bucket, ms] of Object.entries(total).sort((left, right) => right[1] - left[1])) {
  process.stdout.write(`  ${bucket.padEnd(40)} ${s(ms).padStart(9)}s ${(100 * ms / wall).toFixed(1).padStart(5)}%\n`);
}
