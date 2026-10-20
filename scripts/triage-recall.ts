/**
 * Whether triage lets through what it must: the same recorded turns rated by Clef through the one production rater,
 * batched five at a time as a cadence dream takes them, each with its rating in the state triage reads
 * (`renderRatedTurn`). A batch holding a low-rated or a likely-corrected turn must pass (`TRIAGE_YES`); a batch of
 * only well-rated, uncorrected turns may stop. For each threshold: the share of must-pass batches that pass (recall)
 * and of may-stop batches that stop.
 *
 *   CLOUDFLARE_ACCOUNT_ID=… CLOUDFLARE_API_TOKEN=… bun scripts/triage-recall.ts --turns turns.jsonl [--limit 200]
 */
import { parseArgs } from 'node:util';
import { isCorrected, isHighRating, isLowRating, type RatingVerdict } from '../packages/core/src/evolution/ratings';
import { TRIAGE } from '../packages/core/src/evolution/refinement-lane';
import { createDecisionPort, DEFAULT_DECISION_MODEL, type DecisionPort } from '../packages/core/src/providers/decision-model';
import { renderThrownChain } from '../packages/core/src/obs/index';
import { clefRun, inFours, rated, triageWindows, turnsFrom } from './decision-agreement';

const THRESHOLDS = [0.1, 0.2, 0.25, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9];

/** Must pass: a turn rated low or likely corrected. May stop: every turn rated high and none corrected. Else neither. */
export function windowLabel(verdicts: readonly RatingVerdict[]): 'must' | 'may' | null {
  if (verdicts.some((verdict) => isLowRating(verdict.score) || isCorrected(verdict))) return 'must';

  return verdicts.every((verdict) => isHighRating(verdict.score)) ? 'may' : null;
}

/**
 * At each threshold, as `dreamRequest` decides: a must-pass batch passes by rule, so recall counts only what Clef would
 * have stopped of the rest; the may-stop batches it stops, and the batches that are neither it passes, each as a share.
 * `clefAlone` is the same table had Clef triaged every batch.
 */
export function recallTable(triaged: readonly { readonly label: 'must' | 'may' | null; readonly worth: number }[]) {
  const share = (of: readonly { readonly worth: number }[], kept: (p: number) => boolean) => (of.length === 0 ? null : of.filter((window) => kept(window.worth)).length / of.length);
  const must = triaged.filter((window) => window.label === 'must');
  const may = triaged.filter((window) => window.label === 'may');
  const neither = triaged.filter((window) => window.label === null);

  return THRESHOLDS.map((threshold) => ({
    threshold,
    recall: must.length === 0 ? null : 1,
    clefAlone: share(must, (p) => p >= threshold),
    stops: share(may, (p) => p < threshold),
    neitherPass: share(neither, (p) => p >= threshold),
  }));
}

async function worth(decide: DecisionPort, state: string): Promise<number | null> {
  try {
    const answer = (await decide({ state, questions: TRIAGE }))?.answers.worth;

    return answer?.type === 'noul' ? answer.noul : null;
  } catch (cause) {
    console.error(`untriaged: ${renderThrownChain({ cause })}`);

    return null;
  }
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { turns: { type: 'string' }, db: { type: 'string' }, limit: { type: 'string' } } });
  const account = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;

  if (account === undefined || token === undefined) throw new Error('set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN');
  const turns = turnsFrom({ ...values, limit: Number(values.limit ?? '200') });

  const clef = createDecisionPort({
    run: clefRun(account, token), model: async () => DEFAULT_DECISION_MODEL, report: () => {},
    refusals: { changes: () => 0, refused: () => {}, answered: () => {} },
  });

  const verdicts = await inFours(turns, async (turn) => ({ turn, verdict: await rated(clef, turn) }));
  const windows = triageWindows(verdicts.flatMap(({ turn, verdict }) => (verdict === null ? [] : [{ turn, verdict }])));

  const triaged = (await inFours(windows, async (window) => ({ label: windowLabel(window.rated), worth: await worth(clef, window.state) })))
    .flatMap((window) => (window.worth === null ? [] : [{ label: window.label, worth: window.worth }]));

  console.log(JSON.stringify({
    against: DEFAULT_DECISION_MODEL, turns: turns.length, rated: windows.length === 0 ? 0 : verdicts.filter(({ verdict }) => verdict !== null).length,
    windows: triaged.length, must: triaged.filter((window) => window.label === 'must').length, may: triaged.filter((window) => window.label === 'may').length,
    worth: triaged.map((window) => ({ label: window.label, worth: Number(window.worth.toFixed(3)) })),
    table: recallTable(triaged),
  }));
}
