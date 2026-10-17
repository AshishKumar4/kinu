// Where each trial's wall time went, from the evidence a run kept (`timeline.jsonl` beside `ledger.jsonl`):
//   bun evals/scripts/timing.ts <evidence dir>... [--steps]
// A directory is searched for trials. Each trial prints its turns and its split; the run prints the
// split summed over every trial, and with `--steps` every step's first token, generation and tools.
// Where the deployment recorded its requests (`model_attempt`), each trial and the run also print the
// split by the product's own clock, the helpers' requests (`descendants.jsonl`) beside the lead's.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parseArgs } from 'node:util';
import * as v from 'valibot';
import { parseJsonValue } from '@kinu.run/core';
import { attemptTiming, buckets, LedgerRowSchema, TimelineEntrySchema, trialTiming, type AttemptTiming, type StepTiming, type TrialTiming } from '../src/timing';

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

/** The requests' split, as one line: none where the deployment recorded none. */
function requestSplit(timing: AttemptTiming): string {
  if (timing.attempts === 0) return 'no requests recorded (a deployment before model_attempt)';
  const headers = [...timing.headersMs].sort((left, right) => left - right);
  const first = [...timing.firstOutputMs].sort((left, right) => left - right);
  const outcomes = Object.entries(timing.outcomes).map(([outcome, count]) => `${String(count)} ${outcome}`).join(', ');

  return `${String(timing.attempts)} requests (${outcomes}); headers p50 ${s(quantile(headers, 0.5))}s p95 ${s(quantile(headers, 0.95))}s, `
    + `first output p50 ${s(quantile(first, 0.5))}s p95 ${s(quantile(first, 0.95))}s, generation ${s(timing.generationMs)}s; `
    + `answer to next request ${s(timing.betweenMs)}s: tools ${s(timing.toolsMs)}s, provider waits ${s(timing.waitMs)}s, `
    + `product ${s(timing.betweenMs - timing.toolsMs - timing.waitMs)}s`;
}

const DescendantSchema = v.object({ actor: v.string(), event: LedgerRowSchema });

const total: Record<string, number> = {};

const asked: AttemptTiming[] = [];

let wall = 0;

for (const root of positionals) {
  for (const dir of trials(root)) {
    const ledger = jsonl(join(dir, 'ledger.jsonl')).map((line) => v.parse(LedgerRowSchema, line));
    const helpers = existsSync(join(dir, 'descendants.jsonl')) ? jsonl(join(dir, 'descendants.jsonl')).map((line) => v.parse(DescendantSchema, line)) : [];
    // A helper's runs are its own: its run ids are kept apart from the lead's by its actor.
    const attempts = attemptTiming([...ledger, ...helpers.map(({ actor, event }) => ({ ...event, runId: `${actor}/${event.runId}` }))]);
    const timing = trialTiming(jsonl(join(dir, 'timeline.jsonl')).map((line) => v.parse(TimelineEntrySchema, line)), ledger);

    process.stdout.write(`${describe(relative(root, dir) || dir, timing)}\n  requests: ${requestSplit(attempts)}\n`);
    wall += timing.wallMs;
    asked.push(attempts);

    for (const [bucket, ms] of Object.entries(buckets(timing))) total[bucket] = (total[bucket] ?? 0) + ms;
  }
}

process.stdout.write(`\nSummed over trials: ${s(wall)}s\n`);

for (const [bucket, ms] of Object.entries(total).sort((left, right) => right[1] - left[1])) {
  process.stdout.write(`  ${bucket.padEnd(40)} ${s(ms).padStart(9)}s ${(100 * ms / wall).toFixed(1).padStart(5)}%\n`);
}

const all: AttemptTiming = {
  attempts: asked.reduce((sum, each) => sum + each.attempts, 0),
  outcomes: asked.reduce<Record<string, number>>((sum, each) => {
    for (const [outcome, count] of Object.entries(each.outcomes)) sum[outcome] = (sum[outcome] ?? 0) + count;

    return sum;
  }, {}),
  headersMs: asked.flatMap((each) => each.headersMs), firstOutputMs: asked.flatMap((each) => each.firstOutputMs),
  generationMs: asked.reduce((sum, each) => sum + each.generationMs, 0), betweenMs: asked.reduce((sum, each) => sum + each.betweenMs, 0),
  toolsMs: asked.reduce((sum, each) => sum + each.toolsMs, 0), waitMs: asked.reduce((sum, each) => sum + each.waitMs, 0),
};

process.stdout.write(`\nRequests over trials: ${requestSplit(all)}\n`);
