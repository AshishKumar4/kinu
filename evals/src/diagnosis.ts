import * as v from 'valibot';
import type { EvalVerdict } from './comparison';
import { EVIDENCE_FILES, type TrialInsights } from './insights';
import { redact } from './redact';
import type { Assertion } from './results';

export const SIMPLE_CAUSES = ['agent:spec-misread', 'agent:gave-up/incomplete', 'agent:wrong-answer',
  'product:tool-error', 'product:refusal', 'product:reset/stream-drop', 'product:hang', 'provider:refused', 'provider:throttled', 'harness'] as const;

export const ORCHESTRATION_CAUSES = ['idle helpers', 'duplicated work', 'lead did the delegated work', 'never waited for a report'] as const;

export const DIAGNOSIS_HEADING = '## \u{1F52C} Why the evals failed';

/** The heading when no trial failed, and the review is of how the work changed alone. */
export const CHANGES_HEADING = '## \u{1F52C} How the evals\u2019 work changed';

const Sentence = v.pipe(v.string(), v.trim(), v.minLength(1));

const CauseSchema = v.variant('kind', [
  v.strictObject({ kind: v.picklist(SIMPLE_CAUSES) }),
  v.strictObject({ kind: v.literal('agent:tool-misuse'), tool: Sentence }),
  v.strictObject({ kind: v.literal('agent:orchestration'), problem: v.picklist(ORCHESTRATION_CAUSES) }),
]);

const Line = v.pipe(v.number(), v.integer(), v.minValue(1));

/** How a cohort's work moved from the baseline's trials to the candidate's, read off both legs' trajectories. */
export const CHANGES = ['worse', 'better', 'same', 'mixed'] as const;

export const LEGS = ['baseline', 'candidate'] as const;

const ReplySchema = v.strictObject({
  verdict: v.strictObject({ value: v.picklist(['improved', 'regressed', 'unchanged', 'inconclusive']), reason: Sentence }),
  trials: v.array(v.strictObject({
    id: Sentence, cause: CauseSchema, explanation: Sentence, fix: Sentence,
    evidence: v.pipe(v.array(v.strictObject({ file: v.picklist(EVIDENCE_FILES), line: Line })), v.minLength(1)),
  })),
  changes: v.array(v.strictObject({
    id: Sentence, change: v.picklist(CHANGES), explanation: Sentence, fix: Sentence,
    evidence: v.pipe(v.array(v.strictObject({ leg: v.picklist(LEGS), line: Line })), v.minLength(1)),
  })),
});

export type Diagnosis = v.InferOutput<typeof ReplySchema>;

export type ReviewTrial = { id: string; insights: TrialInsights };

/** One compared cohort whose two legs' trajectories the reviewer reads, passing trials included, and each leg file's
 *  line count, which bounds what it may cite. */
export type ReviewChange = {
  readonly id: string; readonly taskId: string; readonly model: string; readonly arm: string;
  readonly lines: Readonly<Record<(typeof LEGS)[number], number>>;
};

/** The harness ended a turn as `hung` only when its workspace stayed busy and silent, so that cause is computed. */
function hung(insights: TrialInsights | undefined): boolean {
  return insights?.facts.some((fact) => fact.kind === 'turn-outcome' && v.is(v.object({ status: v.literal('hung') }), fact.data)) === true;
}

/** The schema covers exactly the failed trials and the compared cohorts, without inventing tools or source lines. */
export function parseDiagnosis(text: string, verdict: EvalVerdict, reviews: readonly ReviewTrial[], changes: readonly ReviewChange[]): Diagnosis {
  const expected = new Map(reviews.map((review) => [review.id, review.insights]));
  const compared = new Map(changes.map((change) => [change.id, change]));

  const DiagnosisSchema = v.pipe(
    ReplySchema,
    v.check((diagnosis) => diagnosis.verdict.value === verdict, 'the diagnosis changed the comparison verdict'),
    v.check((diagnosis) => diagnosis.trials.length === reviews.length
      && new Set(diagnosis.trials.map((trial) => trial.id)).size === reviews.length
      && diagnosis.trials.every((trial) => expected.has(trial.id)), 'the diagnosis must include every failed trial exactly once'),
    v.check((diagnosis) => diagnosis.trials.every((trial) => {
      if (trial.cause.kind !== 'agent:tool-misuse') return true;

      const tool = trial.cause.tool;
      const observed = expected.get(trial.id);

      return observed !== undefined && observed.facts.some((fact) => {
        if (fact.kind !== 'tool-calls' && fact.kind !== 'tool-errors') return false;

        const data = v.safeParse(v.object({ tool: v.string() }), fact.data);

        return data.success && data.output.tool === tool;
      });
    }), 'the diagnosis names a tool that trial did not call'),
    v.check((diagnosis) => diagnosis.trials.every((trial) => (trial.cause.kind === 'product:hang') === hung(expected.get(trial.id))),
      'a trial is a product hang exactly when one of its turns hung'),
    v.check((diagnosis) => diagnosis.trials.every((trial) => {
      const observed = expected.get(trial.id);

      return observed !== undefined && trial.evidence.every((source) => source.line <= observed.lines[source.file]);
    }), 'a diagnosis citation is outside the evidence'),
    v.check((diagnosis) => diagnosis.changes.length === changes.length
      && new Set(diagnosis.changes.map((change) => change.id)).size === changes.length
      && diagnosis.changes.every((change) => compared.has(change.id)), 'the review must include every compared cohort exactly once'),
    v.check((diagnosis) => diagnosis.changes.every((change) => {
      const legs = compared.get(change.id)?.lines;

      return legs !== undefined && change.evidence.every((source) => source.line <= legs[source.leg]);
    }), 'a change citation is outside its trajectories'),
  );

  return v.parse(DiagnosisSchema, JSON.parse(text));
}

function causeLabel(cause: Diagnosis['trials'][number]['cause']): string {
  if (cause.kind === 'agent:tool-misuse') return `${cause.kind}(${cause.tool})`;

  if (cause.kind === 'agent:orchestration') return `${cause.kind} (${cause.problem})`;

  return cause.kind;
}

function inline(text: string): string {
  return redact(text).replace(/\s+/g, ' ').replaceAll('|', '\\|').replaceAll('`', "'").replaceAll('<', '&lt;').replaceAll('>', '&gt;').trim();
}

function cohort(taskId: string, model: string, arm: string): string {
  return JSON.stringify([taskId, model, arm]);
}

const VERDICT: Record<EvalVerdict, string> = {
  improved: '\u{1F7E2} improved', regressed: '\u{1F534} regressed', unchanged: '\u26AA unchanged', inconclusive: '\u{1F7E1} inconclusive',
};

/** Counts are computed here, never entrusted to the model, and retain every task/model/arm denominator. */
export function renderDiagnosis(diagnosis: Diagnosis, reviews: readonly ReviewTrial[], assertions: readonly Assertion[], changes: readonly ReviewChange[]): string {
  const byId = new Map(reviews.map((review) => [review.id, review.insights]));
  const groups = new Map<string, { taskId: string; model: string; arm: string; runs: number; failed: number }>();

  for (const assertion of assertions) {
    const run = assertion.meta.harness.run;
    const { taskId, arm } = run.session.metadata;
    const model = run.usage.model;
    const key = cohort(taskId, model, arm);
    const group = groups.get(key) ?? { taskId, model, arm, runs: 0, failed: 0 };

    group.runs += 1;

    if (assertion.status === 'failed') group.failed += 1;

    groups.set(key, group);
  }

  const columns = [...groups].filter(([, group]) => group.failed > 0)
    .sort(([, left], [, right]) => left.taskId.localeCompare(right.taskId) || left.model.localeCompare(right.model) || left.arm.localeCompare(right.arm));

  const counts = new Map<string, Map<string, number>>();

  for (const trial of diagnosis.trials) {
    const identity = byId.get(trial.id);

    if (identity === undefined) throw new Error(`no evidence for ${trial.id}`);

    const cause = causeLabel(trial.cause), key = cohort(identity.taskId, identity.model, identity.arm);
    const row = counts.get(cause) ?? new Map<string, number>();

    row.set(key, (row.get(key) ?? 0) + 1);
    counts.set(cause, row);
  }

  const verdict = `**Verdict.** ${VERDICT[diagnosis.verdict.value]} — ${inline(diagnosis.verdict.reason)}`;

  // With no failed trial there is no cause to count: the review is of how the work changed alone.
  if (diagnosis.trials.length === 0) return `${[CHANGES_HEADING, verdict, ...changeLines(diagnosis, changes)].join('\n')}\n`;

  const lines = [DIAGNOSIS_HEADING, verdict, '',
    `| Cause | ${columns.map(([, group]) => `${inline(group.taskId)} · ${inline(group.model)} · ${inline(group.arm)} (${String(group.failed)}/${String(group.runs)} failed)`).join(' | ')} |`,
    `|---|${columns.map(() => '---:').join('|')}|`];

  for (const [cause, row] of [...counts].sort(([left], [right]) => left.localeCompare(right))) {
    lines.push(`| ${inline(cause)} | ${columns.map(([key]) => String(row.get(key) ?? 0)).join(' | ')} |`);
  }

  lines.push('');

  for (const trial of diagnosis.trials) {
    const identity = byId.get(trial.id);

    if (identity === undefined) throw new Error(`no evidence for ${trial.id}`);

    const evidence = trial.evidence.map((source) => `\`${trial.id}/${source.file}:${String(source.line)}\``).join(', ');

    lines.push(`- **${inline(identity.taskId)}** · ${inline(identity.model)} · ${inline(identity.arm)} · trial ${String(identity.trial)} · `
      + `${inline(causeLabel(trial.cause))} — ${inline(trial.explanation)} (${evidence}). **Fix:** ${inline(trial.fix)}`);
  }

  return `${[...lines, ...changeLines(diagnosis, changes)].join('\n')}\n`;
}

const CHANGE: Record<(typeof CHANGES)[number], string> = {
  worse: '\u{1F534} worse', better: '\u{1F7E2} better', same: '\u26AA same', mixed: '\u{1F7E1} mixed',
};

/** How the agent's work changed in each compared cohort, passing trials included, worse first. */
function changeLines(diagnosis: Diagnosis, changes: readonly ReviewChange[]): string[] {
  if (diagnosis.changes.length === 0) return [];

  const byId = new Map(changes.map((change) => [change.id, change]));
  const order = (change: (typeof CHANGES)[number]): number => CHANGES.indexOf(change);

  return ['', '### How the agent\u2019s work changed, baseline \u2192 candidate', '',
    ...[...diagnosis.changes].sort((left, right) => order(left.change) - order(right.change)).map((change) => {
      const compared = byId.get(change.id);

      if (compared === undefined) throw new Error(`no cohort for ${change.id}`);

      const evidence = change.evidence.map((source) => `\`${change.id}/${source.leg}.md:${String(source.line)}\``).join(', ');

      return `- **${inline(compared.taskId)}** · ${inline(compared.model)} · ${inline(compared.arm)} · ${CHANGE[change.change]} — `
        + `${inline(change.explanation)} (${evidence}). **Fix:** ${inline(change.fix)}`;
    })];
}
