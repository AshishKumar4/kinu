/** Check one live C3 record: acknowledged checkpoints, raw PUT traffic and a cold file read. */
import { readFileSync } from 'node:fs';
import * as v from 'valibot';
import { evaluateLiveC3, LiveC3ObservationSchema, type LiveC3Observation } from '../packages/devbox/bench/c3-result';
import { C3_BYTES_BOUND } from '../packages/devbox/bench/witness-files';

const path = Bun.argv[2];

if (path === undefined) {
  process.stderr.write('usage: bun scripts/bench-c3-overwrite-cell.ts <stdout.ndjson> [196608]\n');
  process.exit(2);
}

const bound = Bun.argv[3] === undefined ? C3_BYTES_BOUND : Number(Bun.argv[3]);

if (bound !== C3_BYTES_BOUND) {
  process.stderr.write(`the C3 bound is fixed at ${C3_BYTES_BOUND}\n`);
  process.exit(2);
}

const CompletionSchema = v.looseObject({
  event: v.literal('matched.chain.complete'), case: v.string(), runId: v.string(), correctness: v.string(),
});

const observations: LiveC3Observation[] = [];

const completions: v.InferOutput<typeof CompletionSchema>[] = [];

let invalid = false;

for (const line of readFileSync(path, 'utf8').split('\n')) {
  if (!line.startsWith('{')) continue;
  const parsed = JSON.parse(line);
  const observation = v.safeParse(LiveC3ObservationSchema, parsed);

  if (observation.success) {
    observations.push(observation.output);
    continue;
  }

  const completion = v.safeParse(CompletionSchema, parsed);

  if (completion.success) completions.push(completion.output);
  else {
    const event = v.safeParse(v.looseObject({ event: v.string() }), parsed);

    if (event.success && event.output.event === 'matched.chain.C3.observations') invalid = true;
  }
}

if (invalid || observations.length !== 1 || observations[0] === undefined) {
  process.stderr.write(`expected one complete live C3 evidence row in ${path}\n`);
  process.exit(1);
}

const row = observations[0];

const verdict = evaluateLiveC3(row);

const completed = completions.filter((entry) => entry.case === row.case && entry.runId === row.runId);

const errors = [...verdict.errors];

if (completed.length !== 1 || completed[0]?.correctness !== 'passed' || row.correctness !== verdict.correctness) {
  errors.push('the matching run/case has no unique, verified completion');
}

for (const error of errors) process.stderr.write(`${row.runId} ${row.case}: ${error}\n`);

if (errors.length === 0) {
  process.stdout.write(`${row.runId} ${row.case}: ${verdict.bytesPut} bytes, ${verdict.objectsPut} object attempt; cold file verified\n`);
}

process.exit(errors.length === 0 ? 0 : 1);
