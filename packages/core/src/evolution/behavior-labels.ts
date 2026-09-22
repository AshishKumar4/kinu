/**
 * Behavioral weak labels: turns judged by what the user did (Escape, tool
 * rejection, re-asking, approval), and the harness that scores raters against
 * them. Pure; model calls go through the caller's `LLM`.
 *
 * Not a substitute for calibration.ts: these turns come from another agent and
 * population, so a sensitivity/specificity profile here does not transport to a
 * Kinu ledger, and the labeled subset is selected (rules fire only on clear
 * acts), so every number is conditional on a rule firing. Hence no
 * `correctedRate`: PPI's rectifier needs a known-probability sample.
 *
 * The labeler is mechanical (no LLM) and precision-first: rules that disagree
 * make the turn abstain.
 */

import type { LLM } from '../types/primitives';
import { formatScoreInterval } from '../utils/stats';
import { estimateTokens, estimateUsdCost, meterLLM, type LLMUsage } from '../llm';
import type { LabelingItem } from './calibration';
import { askEnsembleJudge, flagsNegative, panelVerdict, type EnsembleJudge } from './ensemble';
import {
  classifyTurnOutcome, isNegativeOutcome, OUTCOME_LABELS,
  type OutcomeLabel,
} from './outcomes';
import {
  designWeightedKappa, resampledAccuracy,
  type ClassifierAccuracy, type KappaEstimate,
} from './ppi';

/** Acts the user took (or the agent took at their request); nothing inferred. */
export interface TurnSignals {
  interrupted: boolean;
  /** A user rejection; config- or policy-level denials are not this. */
  toolRejected: boolean;
  /** Next turn's shell commands, only so the revert rule can corroborate. */
  nextTurnCommands: readonly string[];
}

export interface CorpusTurn {
  project: string;
  sessionId: string;
  /** Exactly what `renderLabelingEvidence` shows a rater; `outcomeId` is the corpus id. */
  item: LabelingItem;
  signals: TurnSignals;
}

export interface BehaviorRule {
  /** Stable report key and label provenance; renaming breaks cross-report comparison. */
  name: string;
  label: OutcomeLabel;
  meaning: string;
  fires(turn: CorpusTurn): boolean;
}

/** Whole-message approval vocabulary; hedges and negations are absent so mixed
 *  messages never fire. "continue"/"go ahead"/"next" are excluded (see `RESUME_ASK`). */
const APPROVAL_WORDS = new Set([
  'ok', 'okay', 'k', 'kk', 'cool', 'nice', 'great', 'awesome', 'perfect',
  'excellent', 'beautiful', 'lovely', 'sweet', 'brilliant', 'lgtm', 'ship',
  'merge', 'it', 'yes', 'yess', 'yep', 'yup', 'yeah', 'sure', 'thanks', 'thank',
  'you', 'thx', 'ty', 'good', 'job', 'well', 'done', 'looks', 'to', 'me',
  'love', 'this', 'that', 'works', 'worked', 'and', 'very', 'much', 'so',
  'super', 'please', 'ofc', 'ofcourse', 'of', 'course',
]);

const APPROVAL_MAX_WORDS = 8;

/** The owner's documented steers ("Wait,", "NO WAIT!"). "Listen." is excluded:
 *  in the corpus it introduced new directives, not verdicts. */
const STEERING_OPENER = /^\s*(?:no\s+)?(?:wait|stop|hold\s+on)\b[\s,.!?]/i;

/** Two or more adjacent shouted words of 4+ letters; 3-letter runs matched acronyms. */
const SHOUTED_RUN = /\b[A-Z]{4,}(?:['’]?[A-Z]*)?(?:[ \t]+[A-Z]{4,}(?:['’]?[A-Z]*)?)+\b/;

/**
 * A follow-up asking the agent to carry on (after a rate limit, reboot, or
 * mistaken Escape). Fires as `unclear`, so it vetoes other rules. Length-bounded
 * because a long message with "continue" usually carries a real instruction,
 * unless it admits the stop was a mistake.
 */
const RESUME_ASK = /\b(?:continue|resume|keep\s+(?:going|implementing|building|grinding)|carry\s+on|proceed)\b/i;

const RESUME_MISTAKE = /\b(?:mistake|mistakenly|accident|accidentally)\b/i;

const RESUME_MAX_WORDS = 14;

/** Stripped before the shouting test: pasted traces and env names are not shouting. */
const CODE_SPAN = /```[\s\S]*?```|`[^`]*`/g;

/** A revert rule needs both the ask and a revert the next turn actually ran;
 *  either half alone fires on ordinary work. */
const REVERT_ASK = /\b(?:revert|undo|roll\s?back|back\s?out)\b/i;

const REVERT_COMMAND = /\bgit\s+(?:revert\b|reset\s+--hard\b|restore\b|checkout\s+--)/;

const REPEAT_JACCARD = 0.8;

const REPEAT_MIN_WORDS = 5;

function words(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9']+/g) ?? [];
}

/** Set overlap, not sequence: re-pasted requests reorder and repeat words. */
function tokenOverlap(a: string, b: string): number {
  const left = new Set(words(a));
  const right = new Set(words(b));

  if (left.size < REPEAT_MIN_WORDS || right.size < REPEAT_MIN_WORDS) return 0;
  let shared = 0;

  for (const token of left) if (right.has(token)) shared++;

  return shared / (left.size + right.size - shared);
}

function shouts(text: string): boolean {
  return SHOUTED_RUN.test(text.replace(CODE_SPAN, ' '));
}

function isApproval(text: string): boolean {
  const tokens = words(text);

  if (tokens.length === 0 || tokens.length > APPROVAL_MAX_WORDS) return false;

  return tokens.every((token) => APPROVAL_WORDS.has(token));
}

function asksToResume(text: string): boolean {
  return RESUME_ASK.test(text) &&
    (words(text).length <= RESUME_MAX_WORDS || RESUME_MISTAKE.test(text));
}

/** Cannot fire on a session's last turn. */
function onFollowup(test: (followup: string, turn: CorpusTurn) => boolean) {
  return (turn: CorpusTurn): boolean =>
    turn.item.followup !== null && test(turn.item.followup, turn);
}

/**
 * Every rule, in report order. `interrupted` also needs a follow-up: a stop the
 * user never returned from is abandonment, which the classifier cannot express.
 */
export const BEHAVIOR_RULES: ReadonlyArray<BehaviorRule> = [
  {
    name: 'interrupted',
    label: 'corrected',
    meaning: 'the user hit Escape while the agent was working, then said something',
    fires: onFollowup((_, turn) => turn.signals.interrupted),
  },
  {
    name: 'tool_rejected',
    label: 'corrected',
    meaning: 'the user refused a tool call the agent asked to make',
    fires: (turn) => turn.signals.toolRejected,
  },
  {
    name: 'steering',
    label: 'corrected',
    meaning: 'the follow-up opens with a documented steer ("Wait,", "NO WAIT", "hold on")',
    fires: onFollowup((followup) => STEERING_OPENER.test(followup)),
  },
  {
    name: 'shouted',
    label: 'frustrated',
    meaning: 'the follow-up shouts, outside of any code it pasted',
    fires: onFollowup(shouts),
  },
  {
    name: 'repeat_ask',
    label: 'corrected',
    meaning: 'the follow-up re-states the same request in the same words',
    fires: onFollowup((followup, turn) =>
      tokenOverlap(turn.item.userMessage, followup) >= REPEAT_JACCARD),
  },
  {
    name: 'reverted',
    label: 'corrected',
    meaning: 'the user asked for a revert and the next turn ran one',
    fires: onFollowup((followup, turn) => REVERT_ASK.test(followup) &&
      turn.signals.nextTurnCommands.some((command) => REVERT_COMMAND.test(command))),
  },
  {
    name: 'approved',
    label: 'accepted',
    meaning: 'the follow-up is approval and nothing else',
    fires: onFollowup(isApproval),
  },
  {
    name: 'resumed',
    label: 'unclear',
    meaning: 'the follow-up just asks to carry on — a veto, not a verdict',
    fires: onFollowup(asksToResume),
  },
];

export interface WeakLabel {
  turnId: string;
  /** null when nothing fired or the fired rules disagreed. */
  label: OutcomeLabel | null;
  rules: string[];
  /** Null because rules disagreed, not because nothing fired. */
  conflicted: boolean;
}

/**
 * Unanimity or nothing, as in ensemble.ts. An `unclear` rule is therefore a veto.
 */
export function weakLabel(turn: CorpusTurn): WeakLabel {
  const fired = BEHAVIOR_RULES.filter((rule) => rule.fires(turn));
  const verdicts = new Set(fired.map((rule) => rule.label));

  return {
    turnId: turn.item.outcomeId,
    label: verdicts.size === 1 && !verdicts.has('unclear') ? fired[0].label : null,
    rules: fired.map((rule) => rule.name),
    conflicted: verdicts.size > 1,
  };
}

export interface CorpusStats {
  turns: number;
  /** Turns a rule decided; eval reports are over these. */
  labeled: number;
  abstained: number;
  conflicted: number;
  byLabel: Array<{ label: OutcomeLabel; count: number }>;
  byRule: Array<{
    rule: string;
    label: OutcomeLabel;
    meaning: string;
    fired: number;
    /** Decided alone or in agreement; a large gap means another rule cancels it. */
    decided: number;
  }>;
  byProject: Array<{ project: string; turns: number; labeled: number; negative: number }>;
}

/** Takes the labels so a report and its eval cannot disagree about what fired. */
export function corpusStats(
  turns: ReadonlyArray<CorpusTurn>,
  labels: ReadonlyArray<WeakLabel>,
): CorpusStats {
  const byId = new Map(labels.map((label) => [label.turnId, label]));
  const decided = labels.filter((label) => label.label !== null);
  const projects = [...new Set(turns.map((turn) => turn.project))].sort();

  return {
    turns: turns.length,
    labeled: decided.length,
    abstained: labels.filter((label) => label.label === null && !label.conflicted).length,
    conflicted: labels.filter((label) => label.conflicted).length,
    byLabel: OUTCOME_LABELS
      .map((label) => ({ label, count: decided.filter((entry) => entry.label === label).length }))
      .filter((row) => row.count > 0),
    byRule: BEHAVIOR_RULES.map((rule) => ({
      rule: rule.name,
      label: rule.label,
      meaning: rule.meaning,
      fired: labels.filter((label) => label.rules.includes(rule.name)).length,
      decided: decided.filter((label) => label.rules.includes(rule.name)).length,
    })),
    byProject: projects.map((project) => {
      const rows = turns.filter((turn) => turn.project === project);
      const found = rows.map((turn) => byId.get(turn.item.outcomeId)?.label ?? null);

      return {
        project,
        turns: rows.length,
        labeled: found.filter((label) => label !== null).length,
        negative: found.filter((label) => label !== null && label !== 'unclear' &&
          isNegativeOutcome(label)).length,
      };
    }),
  };
}

export interface RaterScore {
  name: string;
  answered: number;
  /** Errors and unusable answers; reported, not treated as abstention. */
  failed: number;
  /** Over the turns both the rater and the rules settled. */
  kappa: KappaEstimate | null;
  /** Negative-class profile; conditional on a rule having fired. */
  accuracy: ClassifierAccuracy | null;
  confusion: Array<{ rater: OutcomeLabel; behavior: OutcomeLabel; count: number }>;
  /** Per-rule agreement; locates a bad rule or a rater blind spot. */
  byRule: Array<{ rule: string; n: number; agreed: number }>;
}

interface RatedTurn {
  turnId: string;
  behavior: OutcomeLabel;
  rater: OutcomeLabel;
  rules: ReadonlyArray<string>;
}

/** The corpus is a census, not a stratified draw: one self-weighted stratum,
 *  which reduces the design-weighted estimators to the plain quantity. */
function oneStratum<T>(draws: ReadonlyArray<T>): Array<{ key: string; population: number; draws: ReadonlyArray<T> }> {
  return [{ key: 'corpus', population: draws.length, draws }];
}

function scoreRater(name: string, rated: ReadonlyArray<RatedTurn>, failed: number): RaterScore {
  const accuracy = rated.length === 0 ? null : resampledAccuracy(oneStratum(rated.map((row) => ({
    predictedEvent: flagsNegative(row.rater),
    event: flagsNegative(row.behavior),
  })))).accuracy;

  return {
    name,
    answered: rated.length,
    failed,
    kappa: rated.length === 0
      ? null
      : designWeightedKappa(oneStratum(rated.map((row) => ({ a: row.rater, b: row.behavior })))),
    accuracy,
    confusion: OUTCOME_LABELS.flatMap((rater) => OUTCOME_LABELS.map((behavior) => ({
      rater,
      behavior,
      count: rated.filter((row) => row.rater === rater && row.behavior === behavior).length,
    }))).filter((cell) => cell.count > 0),
    byRule: BEHAVIOR_RULES.map((rule) => {
      const rows = rated.filter((row) => row.rules.includes(rule.name));

      return {
        rule: rule.name,
        n: rows.length,
        agreed: rows.filter((row) => row.rater === row.behavior).length,
      };
    }).filter((row) => row.n > 0),
  };
}

export interface RaterCost {
  name: string;
  usage: LLMUsage;
  /** Estimated from characters: the `LLM` seam reports no token counts. */
  estimatedTokens: number;
  estimatedUsd: number;
}

function raterCost(name: string, usage: LLMUsage): RaterCost {
  const estimatedTokens = estimateTokens(usage.promptChars + usage.responseChars);

  return { name, usage, estimatedTokens, estimatedUsd: estimateUsdCost(estimatedTokens) };
}

export interface CorpusEvalReport {
  stats: CorpusStats;
  classifier: RaterScore | null;
  panel: RaterScore | null;
  /** Each judge alone, so a member that beats the panel is visible. */
  judges: RaterScore[];
  /** Turns every judge answered but did not agree on. */
  panelSplit: number;
  cost: RaterCost[];
}

export interface CorpusEvalInput {
  turns: ReadonlyArray<CorpusTurn>;
  labels: ReadonlyArray<WeakLabel>;
  /** Null skips it. */
  classifier: { name: string; llm: LLM } | null;
  /** Fewer than two judges are scored per member only, with no panel. */
  judges: ReadonlyArray<EnsembleJudge>;
}

/**
 * Score every rater against the rules over rule-decided turns only, so spend is
 * one classifier call plus one call per judge per labeled turn. Rater failures
 * are counted, not scored as disagreement. The classifier sees production
 * evidence budgets and the panel the human-file clip, as each actually runs.
 */
export async function runCorpusEval(input: CorpusEvalInput): Promise<CorpusEvalReport> {
  const byId = new Map(input.turns.map((turn) => [turn.item.outcomeId, turn]));

  const decided = input.labels.filter(
    (label): label is WeakLabel & { label: OutcomeLabel } => label.label !== null,
  );

  // Metered here so the classifier's spend is separable from the panel's.
  const classifier = input.classifier === null
    ? null
    : { name: input.classifier.name, ...meterLLM(input.classifier.llm) };

  const judges = input.judges.map((judge) => ({ spec: judge.spec, ...meterLLM(judge.llm) }));

  const classifierRated: RatedTurn[] = [];
  let classifierFailed = 0;
  const judgeRated: RatedTurn[][] = judges.map(() => []);
  const judgeFailed = judges.map(() => 0);
  const panelRated: RatedTurn[] = [];
  let panelSplit = 0;

  for (const label of decided) {
    const turn = byId.get(label.turnId);

    if (turn === undefined) continue;

    if (classifier !== null) {
      const verdict = await classifyTurnOutcome(classifier.llm, {
        userMessage: turn.item.userMessage,
        assistantResponse: turn.item.assistantResponse,
        followup: turn.item.followup ?? '',
      });

      if (verdict === null) classifierFailed++;
      else classifierRated.push({
        turnId: label.turnId, behavior: label.label, rater: verdict.outcome, rules: label.rules,
      });
    }

    const answers: OutcomeLabel[] = [];

    for (const [index, judge] of judges.entries()) {
      const verdict = await askEnsembleJudge(judge, turn.item);

      if (verdict === null) {
        judgeFailed[index]++;
        continue;
      }

      answers.push(verdict);
      judgeRated[index].push({
        turnId: label.turnId, behavior: label.label, rater: verdict, rules: label.rules,
      });
    }

    // A judge that missed this turn leaves the panel without a verdict.
    if (answers.length < judges.length) continue;
    const verdict = panelVerdict(answers);

    if (verdict === null) continue;

    if (verdict === 'unclear') panelSplit++;
    panelRated.push({ turnId: label.turnId, behavior: label.label, rater: verdict, rules: label.rules });
  }

  return {
    stats: corpusStats(input.turns, input.labels),
    classifier: classifier === null
      ? null
      : scoreRater(classifier.name, classifierRated, classifierFailed),
    panel: judges.length < 2 ? null : scoreRater('panel (unanimous)', panelRated, 0),
    judges: judges.map((judge, index) =>
      scoreRater(judge.spec, judgeRated[index], judgeFailed[index])),
    panelSplit,
    cost: [
      ...(classifier === null ? [] : [raterCost(classifier.name, classifier.usage)]),
      ...judges.map((judge) => raterCost(judge.spec, judge.usage)),
    ],
  };
}

/** Every number in a report is conditional on these two caveats. */
const CAVEAT = [
  '> **Selection bias.** A rule fires only on an unambiguous act, so these are the',
  '> clearest turns in the corpus — the interrupts, the refusals, the one-word',
  '> approvals. Every number below is conditional on a rule having fired, and a',
  '> rater looks better here than it does on the ambiguous middle the rules abstain',
  '> on.',
  '>',
  '> **Off-distribution.** These turns come from a different agent, scaffold, model',
  '> and toolset than the ledger the classifier runs on, and calibration does not',
  '> transport across distributions. Nothing here licenses a corrected rate, and',
  '> nothing here substitutes for the on-distribution hand-labeling pass',
  '> (`kinu label export`). This is a second, free, independent read — not a',
  '> replacement for the first one.',
].join('\n');

function kappaText(estimate: KappaEstimate | null): string {
  return estimate === null
    ? 'undefined at these marginals'
    : `${estimate.value.toFixed(2)} (95% CI ${estimate.lo.toFixed(2)}–${estimate.hi.toFixed(2)}, n=${estimate.n})`;
}

function raterSection(score: RaterScore): string[] {
  const lines = [
    `### ${score.name}`,
    '',
    `- answered ${score.answered}${score.failed > 0 ? `, failed on ${score.failed}` : ''}`,
    `- κ vs the rules: ${kappaText(score.kappa)}`,
  ];

  if (score.accuracy !== null) {
    lines.push(
      `- negative class (corrected/frustrated): recall ${formatScoreInterval(score.accuracy.sensitivity)}` +
      `, specificity ${formatScoreInterval(score.accuracy.specificity)}`,
    );
  }

  if (score.byRule.length > 0) {
    lines.push('', '| rule | turns | rater agreed |', '| --- | ---: | ---: |');

    for (const row of score.byRule) {
      lines.push(`| ${row.rule} | ${row.n} | ${row.agreed} (${((row.agreed / row.n) * 100).toFixed(0)}%) |`);
    }
  }

  if (score.confusion.length > 0) {
    lines.push('', '| rater said | the rules said | turns |', '| --- | --- | ---: |');

    for (const cell of score.confusion) {
      lines.push(`| ${cell.rater} | ${cell.behavior} | ${cell.count} |`);
    }
  }

  return [...lines, ''];
}

/** Corpus composition, then each rater; the mining half prints even with no rater. */
export function renderCorpusReport(
  report: CorpusEvalReport,
  opts: {
    title: string;
    /** Miner-provided source and unread-transcript notes; this module cannot derive them. */
    provenance?: ReadonlyArray<string>;
  },
): string {
  const { stats } = report;

  const lines = [
    `# ${opts.title}`,
    '',
    CAVEAT,
    '',
    '## Corpus',
    '',
    ...(opts.provenance ?? []),
    `- ${stats.turns} mined turns`,
    `- ${stats.labeled} labeled, ${stats.abstained} abstained, ${stats.conflicted} conflicted` +
      ` (${stats.turns === 0 ? '0' : ((stats.labeled / stats.turns) * 100).toFixed(1)}% coverage)`,
    `- by verdict: ${stats.byLabel.length === 0 ? '(none)' : stats.byLabel.map((row) => `${row.label} ${row.count}`).join(', ')}`,
    '',
    '### Rules',
    '',
    '| rule | verdict | fired | decided | what it reads |',
    '| --- | --- | ---: | ---: | --- |',
    ...stats.byRule.map((row) =>
      `| ${row.rule} | ${row.label} | ${row.fired} | ${row.decided} | ${row.meaning} |`),
    '',
    '### Projects',
    '',
    '| project | turns | labeled | negative |',
    '| --- | ---: | ---: | ---: |',
    ...stats.byProject.map((row) =>
      `| ${row.project} | ${row.turns} | ${row.labeled} | ${row.negative} |`),
    '',
  ];

  const raters = [
    ...(report.classifier === null ? [] : [report.classifier]),
    ...(report.panel === null ? [] : [report.panel]),
    ...report.judges,
  ];

  if (raters.length === 0) {
    lines.push('## Raters', '', 'No rater was run — this is the mining half only.', '');

    return lines.join('\n');
  }

  lines.push('## Raters', '');

  if (report.panel !== null) {
    lines.push(`The panel split on ${report.panelSplit} of the turns it covered (counted as \`unclear\`).`, '');
  }

  for (const score of raters) lines.push(...raterSection(score));

  if (report.cost.length > 0) {
    const tokens = report.cost.reduce((sum, row) => sum + row.estimatedTokens, 0);
    const usd = report.cost.reduce((sum, row) => sum + row.estimatedUsd, 0);
    lines.push(
      '## Cost',
      '',
      '| rater | calls | prompt chars | response chars | est. tokens | est. USD |',
      '| --- | ---: | ---: | ---: | ---: | ---: |',
      ...report.cost.map((row) =>
        `| ${row.name} | ${row.usage.calls} | ${row.usage.promptChars} | ${row.usage.responseChars} |` +
        ` ${row.estimatedTokens} | $${row.estimatedUsd.toFixed(4)} |`),
      `| **total** | ${report.cost.reduce((sum, row) => sum + row.usage.calls, 0)} | | |` +
        ` ${tokens} | $${usd.toFixed(4)} |`,
      '',
      'Tokens are estimated from characters and priced at the repo\'s blended rate —' +
      ' a size, not an invoice.',
      '',
    );
  }

  return lines.join('\n');
}
