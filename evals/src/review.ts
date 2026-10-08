/**
 * The reviewer's judgement of one trial, and the run's reviews put together with its measures. The reviewer is an
 * agent with the file tool, on GPT 6.1 Sol through the owner's ChatGPT login (`askOnce`), given one trial's trimmed
 * rollout, its task's objectives and the product's prompts and tool catalog. It judges three things: whether each
 * objective was met, whether the agent used the product as intended, and, for each failure or friction, where in the
 * prompts, tool descriptions or schemas the likely cause lies. Reported beside the verdict, never deciding it.
 */
import * as v from 'valibot';

export const MET = ['yes', 'partly', 'no'] as const;

/** What a use of the product that is not its intended one does. */
export const HACKS = ['prototype', 'polling', 'workaround', 'misuse'] as const;

/** Where a friction's likely cause lies: in what the product says (its prompts, tool descriptions, schemas), in the
 *  product's behaviour, in the model, or in the task itself. */
export const CAUSES = ['tool-description', 'prompt', 'schema', 'product', 'model', 'task'] as const;

const Line = v.pipe(v.string(), v.trim(), v.minLength(1));

const Turn = v.pipe(v.number(), v.integer(), v.minValue(1));

const ReviewSchema = v.strictObject({
  objectives: v.array(v.strictObject({ objective: Line, met: v.picklist(MET), evidence: Line })),
  use: v.strictObject({
    clean: v.boolean(),
    findings: v.array(v.strictObject({ kind: v.picklist(HACKS), what: Line, turn: Turn })),
  }),
  frictions: v.array(v.strictObject({ what: Line, turn: Turn, cause: v.picklist(CAUSES), file: Line, fix: Line })),
  summary: Line,
});

export type TrialReview = v.InferOutput<typeof ReviewSchema>;

/** One reviewed trial, by task and trial number, its review or why there is none. */
export type Reviewed = {
  readonly task: string;
  readonly trial: number;
  readonly passed: boolean;
  readonly review: TrialReview | null;
  readonly refused: string | null;
};

/**
 * A reply as a review of a trial whose task named `objectives`, each judged once in order, every finding's turn one the
 * trial had, and every friction's file one the reviewer was given (a path under `files`) or `none`.
 */
export function parseReview(reply: string, at: { readonly objectives: readonly string[]; readonly turns: number; readonly files: ReadonlySet<string> }): TrialReview {
  const review = v.parse(ReviewSchema, JSON.parse(reply));
  const judged = review.objectives.map(({ objective }) => objective);

  if (judged.length !== at.objectives.length || judged.some((objective, index) => objective !== at.objectives[index])) {
    throw new Error(`the review judged ${JSON.stringify(judged)}, not the task's objectives in order`);
  }

  const turns = [...review.use.findings.map((finding) => finding.turn), ...review.frictions.map((friction) => friction.turn)];

  if (turns.some((turn) => turn > at.turns)) throw new Error(`the review names a turn past the trial's ${String(at.turns)}`);
  const unknown = review.frictions.filter(({ file }) => file !== 'none' && !at.files.has(file.replace(/:\d+$/u, '')));

  if (unknown.length > 0) throw new Error(`the review points at files it was not given: ${unknown.map(({ file }) => file).join(', ')}`);

  if (review.use.clean !== (review.use.findings.length === 0)) throw new Error('the review calls the use clean and lists a hack, or neither');

  return review;
}

/** A friction shared by trials: the same cause in the same file, with the trials it held and its first fix. */
type Finding = { readonly cause: string; readonly file: string; readonly trials: string[]; readonly failed: number; readonly what: string; readonly fix: string };

/** The reviews' frictions by cause and file, those that held in the most trials, then the most failed trials, first. */
export function rankedFindings(reviewed: readonly Reviewed[]): Finding[] {
  const findings = new Map<string, Finding>();

  for (const { task, trial, passed, review } of reviewed) {
    for (const friction of review?.frictions ?? []) {
      const file = friction.file.replace(/:\d+$/u, '');
      const key = `${friction.cause}\u0000${file}`;
      const held = findings.get(key) ?? { cause: friction.cause, file, trials: [], failed: 0, what: friction.what, fix: friction.fix };
      const name = `${task} #${String(trial)}`;

      if (!held.trials.includes(name)) findings.set(key, { ...held, trials: [...held.trials, name], failed: held.failed + (passed ? 0 : 1) });
    }
  }

  return [...findings.values()].sort((left, right) => right.trials.length - left.trials.length || right.failed - left.failed
    || left.file.localeCompare(right.file));
}

const quoted = (text: string) => `\`${text.replace(/\s+/gu, ' ').replaceAll('`', "'").slice(0, 200)}\``;

/** A measure from the run's comparison that names an optimization of its own. */
export type Measured = { readonly what: string; readonly trials: number };

/**
 * The reviews and the run's measures as one ranked list for whoever fixes it: each task's objectives as judged, every
 * hack, the frictions by where their cause lies, and the optimizations, the widest first. An objective judged unmet in a
 * trial whose checks all passed is named first: a check that missed it is the eval's own gap.
 */
export function renderReviews(reviewed: readonly Reviewed[], measured: readonly Measured[]): string {
  const tasks = [...new Set(reviewed.map(({ task }) => task))].sort();

  const tally = (task: string) => {
    const mine = reviewed.filter((each) => each.task === task);
    const judged = mine.flatMap(({ review }) => review?.objectives ?? []);
    const count = (met: (typeof MET)[number]) => String(judged.filter((objective) => objective.met === met).length);

    return `| ${task} | ${String(mine.filter(({ review }) => review !== null).length)}/${String(mine.length)} | ${count('yes')} / ${count('partly')} / ${count('no')} | `
      + `${String(mine.filter(({ review }) => review?.use.clean === false).length)} | ${String(mine.reduce((sum, { review }) => sum + (review?.frictions.length ?? 0), 0))} |`;
  };

  const missed = reviewed.flatMap(({ task, trial, passed, review }) => passed
    ? (review?.objectives ?? []).filter(({ met }) => met === 'no').map(({ objective, evidence }) => `- ${task} #${String(trial)}: ${quoted(objective)}: ${quoted(evidence)}`)
    : []);

  const hacks = reviewed.flatMap(({ task, trial, review }) => (review?.use.findings ?? [])
    .map(({ kind, what, turn }) => `- ${task} #${String(trial)}, turn ${String(turn)}, ${kind}: ${quoted(what)}`));

  const findings = rankedFindings(reviewed);

  const optimizations = [
    ...findings.map((finding) => ({ trials: finding.trials.length, line: `${finding.cause} in \`${finding.file}\`: ${quoted(finding.fix)}` })),
    ...measured.map((measure) => ({ trials: measure.trials, line: measure.what })),
  ].sort((left, right) => right.trials - left.trials).slice(0, 8);

  const unreviewed = reviewed.filter(({ review }) => review === null)
    .map(({ task, trial, refused }) => `- ${task} #${String(trial)}: ${quoted(refused ?? 'no reply')}`);

  return [
    '## The run, reviewed', '',
    'Every trial read by the reviewer agent (GPT 6.1 Sol, the file tool alone), against its task\u2019s objectives. Reported, '
      + 'not gating: the verdict above is the measures\u2019 alone.', '',
    '| Task | Reviewed | Objectives met: yes / partly / no | Hacky trials | Frictions |', '| --- | --- | --- | --- | --- |',
    ...tasks.map(tally), '',
    ...missed.length > 0 ? ['### Objectives judged unmet in trials that passed every check', '', ...missed, ''] : [],
    '### Optimizations, the widest first', '',
    ...optimizations.length === 0 ? ['None found.'] : optimizations.map(({ trials, line }, index) => `${String(index + 1)}. ${line} (${String(trials)} trials)`), '',
    '### Frictions by where the cause lies', '',
    ...findings.length === 0 ? ['None found.'] : ['| Cause | File | Trials | Of them failed | First seen |', '| --- | --- | --- | --- | --- |',
      ...findings.map((finding) => `| ${finding.cause} | \`${finding.file}\` | ${String(finding.trials.length)} | ${String(finding.failed)} | ${quoted(finding.what)} |`)], '',
    ...hacks.length > 0 ? ['### Not the intended use', '', ...hacks, ''] : [],
    ...unreviewed.length > 0 ? ['### Not reviewed', '', ...unreviewed, ''] : [],
  ].join('\n');
}
