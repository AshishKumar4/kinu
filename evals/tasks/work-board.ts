import type { EvalCheckOutcome, EvalVerifier } from '../src/verifier';

const plainTitle = (title: string): string => title.trim().replace(/^`+|[`.]+$/g, '').toLowerCase();

/** Done work, with the same title normalization for library and handoff tasks. */
export async function boardHolds(verifier: EvalVerifier, titles: readonly string[]): Promise<EvalCheckOutcome> {
  const tasks = await verifier.leadTasks();
  const notDone = titles.filter((title) => !tasks.some((item) => plainTitle(item.title) === plainTitle(title) && item.status === 'done'));

  return { pass: notDone.length === 0, evidence: { notDone, tasks } };
}
