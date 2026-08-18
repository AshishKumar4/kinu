/**
 * `proteus label` — the hand-labeling flow that measures the turn-outcome
 * classifier, and the bias-corrected numbers it buys.
 *
 * Three steps, in order: draw a file, fill it in, hand it back.
 *
 *   proteus label export <agent>          # writes a file of turns to judge
 *   $EDITOR <file>                        # one letter per turn
 *   proteus label ingest <agent> <file>   # validates and stores
 *   proteus label report <agent>          # what the labels established
 *
 * And then, once labels exist, the question of whether that has to be done by
 * hand every time:
 *
 *   proteus label ensemble <agent>        # two LLM judges re-do the same turns
 *
 * which scores a cross-family panel against those labels and says plainly
 * whether it may stand in for the owner next time. It refuses to run before
 * there is anything to score it against — an unmeasured stand-in would be the
 * same unmeasured judge the calibration flow exists to eliminate.
 *
 * And, off to one side, a free second opinion on the same raters:
 *
 *   proteus label mine                    # weak-label the owner's CC history
 *   proteus label score <agent>           # run both raters over it
 *
 * which mines the owner's own Claude Code transcripts for turns their BEHAVIOUR
 * already labeled — interrupts, refused tools, re-pasted requests — and scores
 * the same classifier and panel against those. It complements the flow above
 * and cannot replace it: those turns are off-distribution and selected rather
 * than sampled, so they license no corrected rate. See
 * evolution/behavior-labels.ts.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  DEFAULT_LABEL_BUDGET, corpusStats, decodeJsonValue, describeEnsembleGap, parseLabelingFile,
  renderCalibrationReport, renderCorpusReport, renderEnsembleReport, renderLabelingFile,
  weakLabel,
  type CalibrationReport, type CorpusEvalReport, type EnsembleReport, type EnsembleRunResult,
  type LabelIngestResult, type LabelingItem, type OutcomeLabel, type TurnOutcome,
} from '@proteus/core';
import type { JsonValue } from '@proteus/core';
import * as v from 'valibot';
import { resolveAgentTarget, type AgentTarget } from '../agent-target';
import { defaultTranscriptRoot, mineTranscripts, renderMineSkips, type MineResult } from '../cc-transcript';
import { requireAuthConfig } from '../config';
import { callAgentRpc } from '../cloud-api';
import { ACCENT, DIM, OK, WARN } from '../display';
import {
  getLocalCalibration, getLocalEnsemble, recordLocalOutcomeLabels, runLocalCorpusEval,
  runLocalOutcomeEnsemble, sampleLocalLabeling,
} from '../local-inspection';

interface LabelOpts {
  out?: string;
  size?: string;
  labeler?: string;
  models?: string;
  json?: boolean;
  root?: string;
  projects?: string;
  limit?: string;
}

const USAGE = 'Usage: proteus label <export|ingest|ensemble|report|mine|score> [agent] [file]';

const TurnOutcomeSchema = v.picklist([
  'accepted', 'corrected', 'frustrated', 'abandoned',
] satisfies TurnOutcome[]);
const OutcomeLabelSchema = v.picklist([
  'accepted', 'corrected', 'frustrated', 'abandoned', 'unclear',
] satisfies OutcomeLabel[]);
const MeasuredProportionSchema = v.object({ mean: v.number(), lo: v.number(), hi: v.number(), n: v.number(), se: v.number() });
const KappaEstimateSchema = v.object({ value: v.number(), lo: v.number(), hi: v.number(), n: v.number() });
const ClassifierAccuracySchema = v.object({
  sensitivity: MeasuredProportionSchema, specificity: MeasuredProportionSchema, prevalence: v.number(),
});
const CorrectedRateSchema = v.object({
  corrected: MeasuredProportionSchema, raw: v.number(), bias: v.number(), population: v.number(),
});
const CalibrationGapSchema = v.object({
  kind: v.picklist(['no_population', 'no_labels', 'unlabeled_strata', 'uninformative_classifier']),
  strata: v.array(v.string()),
});
const EnsembleGapSchema = v.object({
  kind: v.picklist(['no_population', 'no_gold_labels', 'no_usable_labels', 'too_few_judges', 'not_run']),
  judges: v.array(v.string()),
});
const LabelingItemSchema: v.GenericSchema<LabelingItem> = v.object({
  outcomeId: v.string(), userMessage: v.string(), assistantResponse: v.string(),
  followup: v.nullable(v.string()), createdAt: v.number(),
});
const LabelIngestResultSchema: v.GenericSchema<LabelIngestResult> = v.object({
  stored: v.number(), unknown: v.array(v.string()), disagreements: v.number(),
});
const EnsembleRunResultSchema: v.GenericSchema<EnsembleRunResult> = v.union([
  v.object({
    run: v.object({
      judged: v.array(v.object({ model: v.string(), stored: v.number(), failed: v.number() })),
      turns: v.number(), alreadyJudged: v.number(),
    }),
    gap: v.null(),
  }),
  v.object({ run: v.null(), gap: EnsembleGapSchema }),
]);
const CalibrationReportSchema: v.GenericSchema<CalibrationReport> = v.object({
  universe: v.number(), labeled: v.number(), unclear: v.number(), orphaned: v.number(),
  labelers: v.array(v.string()), lastLabeledAt: v.nullable(v.number()),
  strata: v.array(v.object({
    predicted: TurnOutcomeSchema, population: v.number(), labeled: v.number(),
    actual: v.array(v.object({ outcome: TurnOutcomeSchema, count: v.number() })),
  })),
  accuracy: v.nullable(ClassifierAccuracySchema),
  kappa: v.nullable(KappaEstimateSchema),
  overall: v.nullable(CorrectedRateSchema),
  segments: v.array(v.object({
    scaffoldVersion: v.nullable(v.number()),
    observed: v.object({ events: v.number(), population: v.number() }),
    rate: v.nullable(CorrectedRateSchema),
  })),
  gap: v.nullable(CalibrationGapSchema),
});
const EnsembleReportSchema: v.GenericSchema<EnsembleReport> = v.object({
  members: v.array(v.object({ model: v.string(), labeled: v.number(), kappa: v.nullable(KappaEstimateSchema) })),
  gold: v.number(), covered: v.number(), split: v.number(), compared: v.number(),
  kappa: v.object({
    humanEnsemble: v.nullable(KappaEstimateSchema), humanClassifier: v.nullable(KappaEstimateSchema),
    ensembleClassifier: v.nullable(KappaEstimateSchema),
  }),
  confusion: v.array(v.object({ ensemble: OutcomeLabelSchema, human: TurnOutcomeSchema, count: v.number() })),
  accuracy: v.nullable(ClassifierAccuracySchema),
  standIn: v.nullable(v.object({
    qualified: v.boolean(),
    conditions: v.array(v.object({ name: v.string(), met: v.boolean(), detail: v.string() })),
  })),
  gap: v.nullable(EnsembleGapSchema),
});

export async function labelCommand(
  action: string | undefined,
  name: string | undefined,
  file: string | undefined,
  opts: LabelOpts = {},
): Promise<void> {
  // `mine` reads the owner's own transcripts and no agent's ledger, so it is
  // the one action that names no agent.
  if (action === 'mine') return mineCorpus(opts);
  if (!name) throw new Error(USAGE);
  const target = resolveAgentTarget(name);
  switch (action) {
    case 'export': return exportLabels(target, opts);
    case 'ingest': return ingestLabels(target, file, opts);
    case 'ensemble': return ensembleLabels(target, opts);
    case 'report': return reportLabels(target, opts);
    case 'score': return scoreCorpus(target, opts);
    default:
      throw new Error(
        `Unknown action "${action ?? ''}" — use export, ingest, ensemble, report, mine, or score.`,
      );
  }
}

// ── export ───────────────────────────────────────────────────────

async function exportLabels(target: AgentTarget, opts: LabelOpts): Promise<void> {
  const size = parsePositiveInt(opts.size, DEFAULT_LABEL_BUDGET, 'size');
  const items = target.mode === 'cloud'
    ? await cloudRpc(target, 'sampleOutcomeLabeling', v.array(LabelingItemSchema), [size])
    : sampleLocalLabeling(target.localName, size);

  if (items.length === 0) {
    console.log(`${WARN('nothing to label')} ${target.name} has no classifier-graded turns left to check.`);
    console.log(DIM('The classifier grades a turn once the user sends a follow-up. Chat with the agent first.'));
    return;
  }

  const path = resolve(opts.out ?? `${target.name}-calibration.txt`);
  writeFileSync(path, renderLabelingFile(items), 'utf8');

  if (opts.json) {
    console.log(JSON.stringify({ path, turns: items.length }, null, 2));
    return;
  }
  console.log(`${OK('drew')} ${items.length} turn${items.length === 1 ? '' : 's'} → ${ACCENT(path)}` +
    DIM(`  (~${Math.round(items.length * 0.35)}–${Math.round(items.length * 0.5)} minutes)`));
  console.log('');
  console.log('  1. Open it and put one letter after each `verdict:` —');
  console.log(DIM('       a accepted   c corrected   f frustrated   b abandoned   ? unclear'));
  console.log(DIM('     In vim: /^verdict:  then  n  to step, then  A <letter> Esc.'));
  console.log(`  2. ${ACCENT(`proteus label ingest ${target.requestedName} ${path}`)}`);
  console.log(`  3. ${ACCENT(`proteus label report ${target.requestedName}`)}`);
  console.log(DIM(`     …and ${`proteus label ensemble ${target.requestedName}`} to find out whether two models`));
  console.log(DIM('     could have done this for you next time.'));
  console.log('');
  console.log(DIM("The classifier's own verdicts are not in the file on purpose — seeing them"));
  console.log(DIM('first would anchor yours, and the gap between the two is the measurement.'));
}

// ── ingest ───────────────────────────────────────────────────────

async function ingestLabels(target: AgentTarget, file: string | undefined, opts: LabelOpts): Promise<void> {
  if (!file) throw new Error('Usage: proteus label ingest <agent> <file>');
  const path = resolve(file);
  const parsed = parseLabelingFile(readFileSync(path, 'utf8'));

  // Nothing is written while the file has a problem in it: a labeling pass is
  // half an hour of a person's attention, and a partial write would make the
  // rest of it ambiguous to re-do. Every problem is listed at once so the file
  // is fixed in one pass.
  if (parsed.errors.length > 0) {
    throw new Error(
      `${parsed.errors.length} problem${parsed.errors.length === 1 ? '' : 's'} in ${path} — nothing was stored:\n` +
      parsed.errors.map((problem) => `  ${problem}`).join('\n'),
    );
  }
  if (parsed.labels.length === 0) {
    console.log(`${WARN('no verdicts')} every turn in ${path} was left blank.`);
    return;
  }

  const labeler = opts.labeler ?? process.env.USER ?? 'owner';
  const result = target.mode === 'cloud'
    ? await cloudRpc(target, 'recordOutcomeLabeling', LabelIngestResultSchema, [labeler, decodeJsonValue({ value: parsed.labels })])
    : await recordLocalOutcomeLabels(target.localName, { labeler, labels: parsed.labels });

  if (opts.json) {
    console.log(JSON.stringify({ ...result, skipped: parsed.skipped, labeler }, null, 2));
    return;
  }
  console.log(`${OK('stored')} ${result.stored} verdict${result.stored === 1 ? '' : 's'} as ${labeler}` +
    (parsed.skipped > 0 ? DIM(`  (${parsed.skipped} left blank)`) : ''));
  if (result.stored > 0) {
    console.log(`  You disagreed with the classifier on ${result.disagreements} of ${result.stored}.`);
  }
  if (result.unknown.length > 0) {
    console.log(`${WARN('skipped')} ${result.unknown.length} turn${result.unknown.length === 1 ? '' : 's'} ` +
      `no longer in the ledger: ${result.unknown.slice(0, 3).join(', ')}${result.unknown.length > 3 ? '…' : ''}`);
  }
  console.log('');
  console.log(renderCalibrationReport(await fetchReport(target)));
}

// ── ensemble ─────────────────────────────────────────────────────

async function ensembleLabels(target: AgentTarget, opts: LabelOpts): Promise<void> {
  const specs = (opts.models ?? '')
    .split(',')
    .map((spec) => spec.trim())
    .filter((spec) => spec !== '');

  if (!opts.json) {
    console.log(DIM('Each judge sees the same clipped turn you did and nothing else — not the'));
    console.log(DIM("classifier's verdict, not yours, not the other judge's. This costs one model"));
    console.log(DIM('call per judge per labeled turn.'));
    console.log('');
  }

  const result = target.mode === 'cloud'
    ? await cloudRpc(target, 'runOutcomeEnsemble', EnsembleRunResultSchema, specs.length > 0 ? [specs] : [])
    : await runLocalOutcomeEnsemble(target.localName, specs.length > 0 ? specs : null);

  if (opts.json) {
    console.log(JSON.stringify({ run: result, report: await fetchEnsemble(target) }, null, 2));
    return;
  }
  if (result.run === null) {
    console.log(`${WARN('did not run')} ${describeEnsembleGap(result.gap)}`);
    return;
  }
  for (const judge of result.run.judged) {
    console.log(`${OK('judged')} ${judge.model} — ${judge.stored} verdict${judge.stored === 1 ? '' : 's'}` +
      (judge.failed > 0 ? WARN(`, ${judge.failed} unanswered`) : ''));
  }
  if (result.run.alreadyJudged > 0) {
    console.log(DIM(`  ${result.run.alreadyJudged} already judged on an earlier run, left alone.`));
  }
  console.log('');
  console.log(renderEnsembleReport(await fetchEnsemble(target)));
}

// ── mine / score (the behavioural corpus) ────────────────────────

/** Where mined reports land by default: outside every repository, because they
 *  describe the owner's private sessions. `.gitignore` also covers `.cc-corpus/`
 *  and `CC-CORPUS-*.md` for a run deliberately pointed at the repo. */
function defaultCorpusDir(): string {
  const cache = process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache');
  return join(cache, 'proteus', 'cc-corpus');
}

function corpusReportPath(opts: LabelOpts): string {
  if (opts.out) return resolve(opts.out);
  return join(defaultCorpusDir(), `CC-CORPUS-${new Date().toISOString().slice(0, 10)}.md`);
}

function writeReport(path: string, markdown: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, markdown, 'utf8');
}

/** Mine and weak-label, with the options both actions share. Read-only over
 *  the transcripts, and the same deterministic order every run, so `score`
 *  measures the corpus `mine` reported. */
function mineAndLabel(opts: LabelOpts) {
  const mined = mineTranscripts({
    root: opts.root ? resolve(opts.root) : defaultTranscriptRoot(homedir()),
    projects: (opts.projects ?? '').split(',').map((p) => p.trim()).filter((p) => p !== ''),
  });
  return { mined, labels: mined.turns.map(weakLabel) };
}

/** The report shape for a pass with no rater — the mining half on its own. */
function miningOnly(mined: MineResult, labels: ReturnType<typeof weakLabel>[]): CorpusEvalReport {
  return {
    stats: corpusStats(mined.turns, labels),
    classifier: null, panel: null, judges: [], panelSplit: 0, cost: [],
  };
}

async function mineCorpus(opts: LabelOpts): Promise<void> {
  const { mined, labels } = mineAndLabel(opts);
  const report = miningOnly(mined, labels);
  if (opts.json) {
    console.log(JSON.stringify({ ...report, provenance: mined.skips, versions: mined.versions }, null, 2));
    return;
  }

  const path = corpusReportPath(opts);
  const markdown = renderCorpusReport(report, {
    title: `Claude Code transcript corpus — ${new Date().toISOString().slice(0, 10)}`,
    provenance: renderMineSkips(mined),
  });
  writeReport(path, markdown);
  console.log(markdown);
  console.log(`${OK('wrote')} ${ACCENT(path)}`);
  if (report.stats.labeled === 0) {
    console.log(`${WARN('no labels')} no rule fired on any mined turn — nothing to score a rater against.`);
    return;
  }
  console.log(DIM(`Score the classifier and the panel against these with:  ` +
    `proteus label score <agent>  (${report.stats.labeled} labeled turns available)`));
}

/** Labeled turns scored per run when the owner does not say. Small on purpose:
 *  a pass is one classifier call plus one call per judge per turn, so the
 *  default is a few tens of cents at worst and the number is the ONLY thing
 *  standing between a typo and a large bill. */
const DEFAULT_SCORE_LIMIT = 25;

async function scoreCorpus(target: AgentTarget, opts: LabelOpts): Promise<void> {
  if (target.mode !== 'local') {
    throw new Error(
      `The transcript corpus lives on this machine, so it is scored with a local agent's models — ` +
      `"${target.requestedName}" is a cloud agent.`,
    );
  }
  const limit = parsePositiveInt(opts.limit, DEFAULT_SCORE_LIMIT, 'limit');
  const specs = (opts.models ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');

  const { mined, labels } = mineAndLabel(opts);
  // Only labeled turns are put to a rater, so the budget is spent where an
  // answer can be checked. Trimming the LABELS rather than the turns keeps the
  // corpus composition in the report honest about what was mined.
  const scored = new Set(labels.filter((label) => label.label !== null).slice(0, limit)
    .map((label) => label.turnId));
  const budgeted = labels.map((label) =>
    scored.has(label.turnId) ? label : { ...label, label: null });

  if (scored.size === 0) {
    console.log(`${WARN('nothing to score')} no rule fired on any mined turn.`);
    return;
  }
  if (!opts.json) {
    console.log(DIM(`Scoring ${scored.size} labeled turn${scored.size === 1 ? '' : 's'} — one classifier`));
    console.log(DIM('call plus one call per judge each. Every rater sees only the turn, never a rule.'));
    console.log('');
  }

  const report = await runLocalCorpusEval(target.localName, {
    turns: mined.turns, labels: budgeted, specs: specs.length > 0 ? specs : null,
  });
  if (opts.json) {
    console.log(JSON.stringify({ ...report, provenance: mined.skips, versions: mined.versions }, null, 2));
    return;
  }
  const path = corpusReportPath(opts);
  const markdown = renderCorpusReport(report, {
    title: `Claude Code transcript corpus, scored — ${new Date().toISOString().slice(0, 10)}`,
    provenance: renderMineSkips(mined),
  });
  writeReport(path, markdown);
  console.log(markdown);
  console.log(`${OK('wrote')} ${ACCENT(path)}`);
}

// ── report ───────────────────────────────────────────────────────

async function reportLabels(target: AgentTarget, opts: LabelOpts): Promise<void> {
  const [calibration, ensemble] = await Promise.all([fetchReport(target), fetchEnsemble(target)]);
  if (opts.json) {
    console.log(JSON.stringify({ calibration, ensemble }, null, 2));
    return;
  }
  console.log(renderCalibrationReport(calibration));
  console.log('');
  console.log(renderEnsembleReport(ensemble));
}

/** The calibration report for either backend. Shared with `proteus alignment`,
 *  which renders the same block beneath K_align. */
export async function fetchReport(target: AgentTarget): Promise<CalibrationReport> {
  return target.mode === 'cloud'
    ? cloudRpc(target, 'getOutcomeCalibration', CalibrationReportSchema)
    : getLocalCalibration(target.localName);
}

function fetchEnsemble(target: AgentTarget): Promise<EnsembleReport> {
  return target.mode === 'cloud'
    ? cloudRpc(target, 'getOutcomeEnsemble', EnsembleReportSchema)
    : Promise.resolve(getLocalEnsemble(target.localName));
}

function cloudRpc<T>(
  target: AgentTarget,
  method: string,
  schema: v.GenericSchema<T>,
  args: JsonValue[] = [],
): Promise<T> {
  const auth = requireAuthConfig();
  return callAgentRpc(auth.origin, auth.token, target.cloudName, method, schema, args);
}

function parsePositiveInt(value: string | undefined, fallback: number, label: string): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`);
  return parsed;
}
