import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import * as v from 'valibot';
import { parseResults, trials, type EvalFile } from '../evals/src/results';

export const TrialItemSchema = v.object({
  leg: v.picklist(['candidate', 'baseline']), origin: v.string(), task: v.string(),
  model: v.string(), arm: v.string(), trial: v.number(), trials: v.number(),
  models: v.array(v.string()), arms: v.array(v.string()), pass: v.boolean(),
});

export type TrialItem = v.InferOutput<typeof TrialItemSchema>;

export const EvalRunSchema = v.object({
  definitions: v.string(), candidateBuild: v.string(), baselineBuild: v.string(),
  taskFiles: v.array(v.string()), models: v.array(v.string()), arms: v.array(v.string()), trials: v.number(),
  startedAt: v.number(), jobs: v.array(v.string()), pool: v.number(),
  queues: v.array(v.object({ calls: v.number(), pool: v.number(), job: v.string(), tasks: v.array(v.string()) })),
  wallSeconds: v.optional(v.number()), pass: v.boolean(),
});

export type EvalRun = v.InferOutput<typeof EvalRunSchema>;

/** armada map --json emits one outcome per item, with the path its own artifact extractor kept. */
export const MapResultSchema = v.object({
  index: v.number(), kind: v.string(), exitCode: v.number(), tail: v.string(),
  seconds: v.number(), artifacts: v.optional(v.string()),
});

export type MapResult = v.InferOutput<typeof MapResultSchema>;

/** Vitest's name filter leaves unselected cases as skipped. Select the exact requested case,
 * including a skipped case when collection failed: missing or failed collection stays incomplete. */
export function selectTrialReport(text: string, item: TrialItem): string {
  const parsed = v.parse(v.looseObject({ testResults: v.array(v.looseObject({
    name: v.string(), assertionResults: v.array(v.looseObject({ title: v.string() })),
  })) }), JSON.parse(text));

  const title = `${item.model} | ${item.arm} | trial ${String(item.trial)}`;

  const files = parsed.testResults.filter((file) => basename(file.name) === `${item.task}.eval.ts`)
    .map((file) => ({ ...file, assertionResults: file.assertionResults.filter((assertion) => assertion.title === title) }));

  if (files.length !== 1 || files[0]?.assertionResults.length !== 1) {
    throw new Error(`${item.leg} ${item.task}: expected one ${title}, found ${String(files[0]?.assertionResults.length ?? 0)}`);
  }

  const normalized = JSON.stringify({ ...parsed, testResults: files });

  const [assertion] = trials(parseResults('the requested trial', normalized));
  const metadata = assertion?.meta.harness.run.session.metadata;

  if (metadata?.taskId !== item.task || metadata.trial !== item.trial || metadata.arm !== item.arm
    || assertion?.meta.harness.run.usage.model !== item.model) throw new Error(`the recorded trial differs from ${title}`);

  return normalized;
}

/** Merge by task file, retaining every actual trial. The comparator rejects duplicate trial numbers;
 * a missing task keeps an empty file with its native infrastructure outcome, never a synthetic trial. */
export function joinTrialReports(reports: readonly { item: TrialItem; path?: string; failure: string }[]): string {
  const files = new Map<string, EvalFile>();

  for (const { item, path, failure } of reports) {
    const name = `evals/tasks/${item.task}.eval.ts`;
    const held = files.get(name) ?? { name, assertionResults: [] };

    if (path === undefined) {
      held.message = [held.message, `trial ${String(item.trial)}: ${failure}`].filter(Boolean).join('\n');
    } else {
      const [file] = parseResults(`${item.leg} ${item.task} trial ${String(item.trial)}`, readFileSync(path, 'utf8'));

      if (file === undefined || basename(file.name) !== `${item.task}.eval.ts`) throw new Error(`${path} names another task`);
      held.assertionResults.push(...file.assertionResults);

      if (file.startTime !== undefined) held.startTime = Math.min(held.startTime ?? file.startTime, file.startTime);

      if (file.endTime !== undefined) held.endTime = Math.max(held.endTime ?? file.endTime, file.endTime);
    }

    files.set(name, held);
  }

  return JSON.stringify({ testResults: [...files.values()] }, null, 2);
}

/** Read this run's provenance, not the driver's process exit or a caller-supplied boolean. */
export function readEvalRun(path: string): EvalRun {
  return v.parse(EvalRunSchema, JSON.parse(readFileSync(path, 'utf8')));
}
