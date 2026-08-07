#!/usr/bin/env bun
// The long-horizon family's check: exit 0 when every answer is right.
//
// Run inside the attempt sandbox like every other check, with the encoded spec
// as its only argument. There is no answer key on disk — the expected answers
// are recomputed from the spec, and the spec reaches this process through the
// argv the harness holds, never through the sandbox. `scripts` and
// `packages/core/src` are restored from the pristine tree immediately before
// this runs, so the apparatus a solver could tamper with is the apparatus it
// cannot tamper with.
//
// Nothing here is an LLM, a rubric, or a partial credit: a task passes when
// every question matches.
import { existsSync, readFileSync } from 'node:fs';
import {
  LONGHORIZON_ANSWER_FILE, buildLongHorizonQuestions, decodeLongHorizonSpec,
  scoreLongHorizonAnswers,
} from '../packages/core/src/bench/longhorizon.js';

const encoded = process.argv[2];
if (!encoded) {
  console.error('usage: bun scripts/bench-longhorizon-check.ts <encoded-spec>');
  process.exit(2);
}

if (!existsSync(LONGHORIZON_ANSWER_FILE)) {
  console.error(`no ${LONGHORIZON_ANSWER_FILE} in ${process.cwd()} — the solver never answered`);
  process.exit(1);
}

const questions = buildLongHorizonQuestions(decodeLongHorizonSpec(encoded));
const score = scoreLongHorizonAnswers(questions, readFileSync(LONGHORIZON_ANSWER_FILE, 'utf8'));

// Which questions were missed, never what the answers were: check output is
// kept for diagnosis and the corpus is reused across runs.
for (const result of score.results) {
  console.log(`${result.ok ? 'ok  ' : 'MISS'} ${result.id}${result.submitted === null ? ' (unanswered)' : ''}`);
}
process.exit(score.passed ? 0 : 1);
