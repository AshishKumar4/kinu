/**
 * Behavioral weak labels — turns judged by what the user DID, not by what a
 * model thought, and the harness that scores the raters against them.
 *
 * calibration.ts buys ~100 hand labels on ONE agent's ledger, and ensemble.ts
 * asks whether a two-model panel could stand in for the owner next time. Both
 * are stuck behind the same bottleneck: the owner's attention. Meanwhile the
 * owner has already labeled tens of thousands of turns, without meaning to, by
 * pressing Escape, rejecting a tool call, re-pasting a request the agent
 * ignored, or replying "perfect". Those actions are free, mechanical, and
 * recorded.
 *
 * This module states what such an action licenses as a label, aggregates the
 * rules into one verdict per turn, and scores the outcome classifier and the
 * judge panel against the result. Everything here is pure: a `CorpusTurn`
 * arrives already mined, and the only model calls happen through the `LLM`
 * seam the caller passes in.
 *
 * ── What this is, and what it is NOT ─────────────────────────────
 *
 * It is a SECOND, cheap, independent read on the same question the calibration
 * flow asks: does a rater agree with the truth about how a turn landed?
 *
 * It is NOT a replacement for the on-distribution calibration in
 * calibration.ts, and no number here may be substituted for one there. Two
 * reasons, both fatal to any such substitution:
 *
 *  - **Calibration does not transport across distributions.** ppi.ts corrects a
 *    rate by a sensitivity/specificity pair that is prevalence-free and so
 *    transports across SLICES of one population. It does not transport across
 *    POPULATIONS: these turns come from a different agent (Claude Code), a
 *    different scaffold, different tools and a different model. A profile
 *    measured here describes a rater's behaviour on Claude Code transcripts and
 *    says nothing quantitative about its behaviour on a Proteus ledger. The
 *    C8 hand-labeling pass remains the only thing that licenses a corrected
 *    rate, and this corpus is a complement to it, never a substitute.
 *
 *  - **The labeled subset is selected, not sampled.** A rule fires only on an
 *    unambiguous action, so the labeled turns are exactly the easy ones — the
 *    interrupts, the outright rejections, the one-word approvals. A rater
 *    scored here is being scored on the clearest turns in the corpus, where any
 *    rater looks better than it is on the ambiguous middle that the rules
 *    abstain on. Every number this module produces is therefore CONDITIONAL on
 *    a rule having fired, and `renderCorpusReport` prints that caveat on every
 *    report rather than leaving it to be remembered.
 *
 * For the same reason there is deliberately no `correctedRate` here. PPI's
 * rectifier is only unbiased for a sample drawn at known probability from the
 * population being corrected; this one is drawn by a filter on the answer. A
 * corrected rate over it would be confidently wrong, which is worse than
 * absent.
 *
 * What the numbers below ARE good for: κ and a confusion matrix over the
 * clear cases. A rater that disagrees with the owner's own Escape key on the
 * turns where the owner pressed it has a problem that no amount of ambiguity
 * elsewhere excuses, and that is a finding worth having for free.
 *
 * ── Rule design ──────────────────────────────────────────────────
 *
 * Mechanical only: no LLM is consulted anywhere in the labeler. A model in the
 * labeler would make the corpus a measurement of model-versus-model agreement,
 * which is the thing the corpus exists to check from the outside.
 *
 * Precision over recall throughout. Each rule fires on one unambiguous act, and
 * the aggregate ABSTAINS whenever two rules disagree — a turn where the user
 * both interrupted and thanked the agent settles nothing, and guessing which
 * half to believe would put noise into the one signal that is supposed to be
 * cleaner than the classifier being measured. Abstentions are counted, not
 * hidden: `CorpusStats` reports how much of the corpus each rule carries and
 * how much nothing carries.
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

// ── One mined turn ───────────────────────────────────────────────

/** What the transcript mechanically recorded about a turn, beyond its text.
 *  Every field is an ACT the user took (or the agent took at their request) —
 *  nothing inferred, nothing a model produced. */
export interface TurnSignals {
  /** The user stopped the agent mid-turn (Escape). */
  interrupted: boolean;
  /** The user rejected a tool call this turn. Config- or policy-level denials
   *  are NOT this: they are the deployment's opinion, not the user's. */
  toolRejected: boolean;
  /** Shell commands the NEXT turn ran. Carried only so the revert rule can
   *  corroborate a follow-up that asks for one — the whole next turn would be
   *  a second turn's worth of evidence about this one. */
  nextTurnCommands: readonly string[];
}

/** One turn of a mined transcript: the evidence a rater sees, the provenance
 *  a report breaks down by, and the acts the rules read. */
export interface CorpusTurn {
  /** The project the session ran in — the report's per-project key. */
  project: string;
  sessionId: string;
  /** Exactly what `renderLabelingEvidence` shows a rater, so the classifier,
   *  the panel and the human file are all judging the same thing. `outcomeId`
   *  is this turn's corpus id. */
  item: LabelingItem;
  signals: TurnSignals;
}

// ── The rules ────────────────────────────────────────────────────

/** One mechanical act, and the verdict it licenses. */
export interface BehaviorRule {
  /** Stable name — the report's per-rule key, and what a label carries as its
   *  provenance. Renaming one invalidates comparisons across reports. */
  name: string;
  /** What this act says about how the turn landed. */
  label: OutcomeLabel;
  /** One sentence: the act, in the user's terms. */
  meaning: string;
  fires(turn: CorpusTurn): boolean;
}

/** Words that, on their own, are an approval and nothing else. A message every
 *  one of whose words is in here cannot also be a complaint — which is what
 *  makes the whole-message test precise where a keyword search is not:
 *  "not bad", "great, but the tests fail" and "thanks, though it's wrong" all
 *  contain a hedge or negation that is absent from this list, so none of them
 *  fire. Deliberately excludes "continue", "go ahead" and "next": the owner
 *  types those both when satisfied and when the agent stopped early, so they
 *  settle nothing — see `RESUME_ASK`, which reads them as an abstention. */
const APPROVAL_WORDS = new Set([
  'ok', 'okay', 'k', 'kk', 'cool', 'nice', 'great', 'awesome', 'perfect',
  'excellent', 'beautiful', 'lovely', 'sweet', 'brilliant', 'lgtm', 'ship',
  'merge', 'it', 'yes', 'yess', 'yep', 'yup', 'yeah', 'sure', 'thanks', 'thank',
  'you', 'thx', 'ty', 'good', 'job', 'well', 'done', 'looks', 'to', 'me',
  'love', 'this', 'that', 'works', 'worked', 'and', 'very', 'much', 'so',
  'super', 'please', 'ofc', 'ofcourse', 'of', 'course',
]);

/** Longest approval accepted. A long message is doing something besides
 *  approving even when every word looks positive. */
const APPROVAL_MAX_WORDS = 8;

/**
 * The steering openers, anchored where a steer is issued. From the owner's
 * documented vocabulary (global CLAUDE.md: `"Wait,"` / `"NO WAIT!"` mean *stop
 * and re-ground*), narrowed by what the mined corpus actually contained:
 * every "wait"/"hold on" opener there challenged the previous answer, while
 * both "Listen." openers introduced a NEW forward-looking directive and said
 * nothing about the turn before them. So "listen" is not read as a verdict,
 * documented here rather than silently dropped.
 */
const STEERING_OPENER = /^\s*(?:no\s+)?(?:wait|stop|hold\s+on)\b[\s,.!?]/i;

/**
 * A run of at least two shouted words.
 *
 * Four letters minimum, not three: at three, the corpus's false positives were
 * all adjacent acronyms in ordinary prose ("NNX API"), which are vocabulary
 * rather than volume. At four, every remaining hit was the owner raising their
 * voice inside a complaint. Two in a row, so a single shouted word — a product
 * name, an env var — never fires it.
 */
const SHOUTED_RUN = /\b[A-Z]{4,}(?:['’]?[A-Z]*)?(?:[ \t]+[A-Z]{4,}(?:['’]?[A-Z]*)?)+\b/;

/**
 * A follow-up whose business is getting the agent going again — after a rate
 * limit, a reboot, a dropped connection, or an Escape the owner regretted.
 *
 * This is the corpus's most common confounder by a distance: roughly a quarter
 * of all interrupts are followed by "continue", "limits were reset, continue"
 * or "I cancelled it by mistake, please keep implementing". Read naively they
 * are corrections, and they are the opposite — the user wants exactly what was
 * already happening. So this fires as `unclear`, which makes it a VETO: it
 * disagrees with whatever else fired and the turn abstains.
 *
 * Bounded by length, because a resume verb inside a long message is usually
 * "continue, and also fix X" — a real instruction. An explicit admission that
 * the stop was a mistake overrides the bound, since that settles it outright.
 */
const RESUME_ASK = /\b(?:continue|resume|keep\s+(?:going|implementing|building|grinding)|carry\s+on|proceed)\b/i;
const RESUME_MISTAKE = /\b(?:mistake|mistakenly|accident|accidentally)\b/i;
const RESUME_MAX_WORDS = 14;

/** Fenced and inline code, stripped before the shouting test: a pasted stack
 *  trace, SQL statement or set of env var names is not the user raising their
 *  voice. */
const CODE_SPAN = /```[\s\S]*?```|`[^`]*`/g;

/** What a follow-up asking for a revert says, and what the next turn must
 *  actually have RUN for the rule to believe it. The conjunction is the
 *  precision: either half alone fires on ordinary work (an agent cleaning a
 *  worktree, a user musing about undoing something later). */
const REVERT_ASK = /\b(?:revert|undo|roll\s?back|back\s?out)\b/i;
const REVERT_COMMAND = /\bgit\s+(?:revert\b|reset\s+--hard\b|restore\b|checkout\s+--)/;

/** Token-set overlap above which a follow-up counts as the SAME request again.
 *  Below it, two messages about one subject differ by more than word choice. */
const REPEAT_JACCARD = 0.8;

/** Shortest message a repeat is measured on. Two short messages share their
 *  few words by coincidence far too often for the overlap to mean anything. */
const REPEAT_MIN_WORDS = 5;

function words(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9']+/g) ?? [];
}

/** Jaccard over token SETS rather than sequences: the owner re-states a request
 *  by re-pasting it with the parts the agent missed emphasised, so the order
 *  and the duplicates move but the vocabulary does not. */
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

/** A rule that only reads the follow-up, and therefore cannot fire on the last
 *  turn of a session. */
function onFollowup(test: (followup: string, turn: CorpusTurn) => boolean) {
  return (turn: CorpusTurn): boolean =>
    turn.item.followup !== null && test(turn.item.followup, turn);
}

/**
 * Every rule, in the order a report lists them.
 *
 * Two structural rules that read an act directly, four that read the follow-up,
 * and one veto. A rule that reads the follow-up cannot fire on the last turn of
 * a session — there is nothing to read — which is why a session's tail is an
 * abstention and is counted as one.
 *
 * The `interrupted` rule also requires a follow-up, for a different reason: a
 * stop the user never came back from is an abandonment, and the classifier
 * under test has no `abandoned` verdict to be scored against. Calling it a
 * correction would manufacture a disagreement that is the corpus's fault.
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

/** One turn's verdict, and why. */
export interface WeakLabel {
  turnId: string;
  /** null when nothing fired, or when what fired disagreed. */
  label: OutcomeLabel | null;
  /** Every rule that fired, in `BEHAVIOR_RULES` order. */
  rules: string[];
  /** True when `label` is null BECAUSE the rules disagreed, as opposed to
   *  nothing having fired. The two are different findings and a report that
   *  merged them would hide a rule that is systematically at odds with
   *  another. */
  conflicted: boolean;
}

/**
 * Aggregate the rules over one turn.
 *
 * Unanimity or nothing — the same posture ensemble.ts takes with its judges,
 * for the same reason. Rules that disagree are two mechanical facts pointing
 * opposite ways, and no precedence order between them is defensible: a user who
 * interrupts and then says "perfect" has done something this corpus cannot
 * read, and saying so is the honest answer.
 *
 * A rule whose verdict is `unclear` is therefore a veto by construction — it
 * settles nothing alone, and it disagrees with anything else that fired. That
 * needs no machinery beyond the vocabulary already in use: `unclear` means
 * "you genuinely cannot tell from what is here" for the human labeler and the
 * judges too.
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

// ── What the corpus is made of ───────────────────────────────────

export interface CorpusStats {
  turns: number;
  /** Turns a rule decided. Every number in an eval report is over these. */
  labeled: number;
  /** Turns no rule fired on. */
  abstained: number;
  /** Turns the rules disagreed on. */
  conflicted: number;
  byLabel: Array<{ label: OutcomeLabel; count: number }>;
  byRule: Array<{
    rule: string;
    label: OutcomeLabel;
    meaning: string;
    /** Turns this rule fired on. */
    fired: number;
    /** Of those, turns it decided alone or in agreement — a rule with a large
     *  gap between the two is mostly being cancelled by another. */
    decided: number;
  }>;
  byProject: Array<{ project: string; turns: number; labeled: number; negative: number }>;
}

/** The corpus, counted. Takes the labels rather than recomputing them so a
 *  report and the eval it describes can never disagree about what fired. */
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

// ── Scoring a rater against the corpus ───────────────────────────

/** One rater's verdicts, and how they line up with the rules. */
export interface RaterScore {
  name: string;
  /** Turns the rater returned a usable verdict for. */
  answered: number;
  /** Turns it errored or answered unusably on. Reported rather than treated as
   *  an abstention — an outage is not a finding. */
  failed: number;
  /** The rater against the rules, over the turns both settled. */
  kappa: KappaEstimate | null;
  /** Its error profile on the negative class, through the same estimator the
   *  calibration flow uses. Conditional on a rule having fired — see the
   *  module note. */
  accuracy: ClassifierAccuracy | null;
  confusion: Array<{ rater: OutcomeLabel; behavior: OutcomeLabel; count: number }>;
  /** Where the rater and each rule part company. A rule the rater never agrees
   *  with is either a bad rule or a rater blind spot, and the report cannot
   *  tell which — but it can show which rule it is. */
  byRule: Array<{ rule: string; n: number; agreed: number }>;
}

/** One rater's answer for one turn, paired with the rule's. */
interface RatedTurn {
  turnId: string;
  behavior: OutcomeLabel;
  rater: OutcomeLabel;
  rules: ReadonlyArray<string>;
}

/**
 * The corpus is a census of its own labeled turns, not a stratified draw from a
 * larger ledger, so every estimator here runs over ONE stratum weighted by
 * itself. That is the design-weighted estimator's degenerate case and gives the
 * plain, unweighted quantity — which is the right one: there is no population
 * behind these turns to re-weight them back to.
 */
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

/** What one rater's pass cost, measured at the LLM seam. */
export interface RaterCost {
  name: string;
  usage: LLMUsage;
  /** Characters in and out converted at a fixed ratio — an ESTIMATE, and
   *  labeled as one everywhere it is printed. The `LLM` seam reports no token
   *  counts, and inventing a tokenizer per provider to get a number that only
   *  sizes a bill would be worse than a stated approximation. */
  estimatedTokens: number;
  estimatedUsd: number;
}

function raterCost(name: string, usage: LLMUsage): RaterCost {
  const estimatedTokens = estimateTokens(usage.promptChars + usage.responseChars);
  return { name, usage, estimatedTokens, estimatedUsd: estimateUsdCost(estimatedTokens) };
}

export interface CorpusEvalReport {
  stats: CorpusStats;
  /** The outcome classifier, if one was run. */
  classifier: RaterScore | null;
  /** The panel's unanimous verdict, if judges were given. */
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
  /** The turn-outcome classifier under test, on whatever model production
   *  would run it on. Null skips it. */
  classifier: { name: string; llm: LLM } | null;
  /** The judge panel. Fewer than two is not a panel and is scored per member
   *  only — the same refusal ensemble.ts makes. */
  judges: ReadonlyArray<EnsembleJudge>;
}

/**
 * Run every rater over the labeled turns and score them against the rules.
 *
 * Only turns a rule DECIDED are put to a rater: an abstention is not a
 * question, and paying a model to answer one would spend the budget on turns
 * whose answer nothing can be checked against. `--limit` at the call site
 * therefore bounds real spend directly — one classifier call plus one call per
 * judge per labeled turn.
 *
 * A rater that fails on a turn simply has no verdict for it, counted rather
 * than scored as a disagreement.
 *
 * The classifier and the panel see the same turns but not the same amount of
 * them — the classifier gets the evidence budgets production gives it, the
 * panel the tighter clip a human file shows. That asymmetry is the same one
 * ensemble.ts already carries, deliberately: each rater is measured as it
 * actually runs. It is worth remembering before reading one κ against the
 * other.
 */
export async function runCorpusEval(input: CorpusEvalInput): Promise<CorpusEvalReport> {
  const byId = new Map(input.turns.map((turn) => [turn.item.outcomeId, turn]));
  const decided = input.labels.filter(
    (label): label is WeakLabel & { label: OutcomeLabel } => label.label !== null,
  );

  // Metered here rather than by the caller: this is the code making the calls,
  // and a wrapper applied outside it could not tell the classifier's spend from
  // the panel's. Scripted LLMs meter too, which is what lets a test assert the
  // telemetry without a model.
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
    // A judge that missed this turn leaves a hole; the panel has no verdict for
    // it, exactly as in ensemble.ts.
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

// ── The report ───────────────────────────────────────────────────

/** Printed on every report, because every number above it is conditional on
 *  the two things this says. */
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
  '> (`proteus label export`). This is a second, free, independent read — not a',
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

/**
 * The whole report as markdown — the corpus's composition first, then each
 * rater against it. The mining half is printed even when no rater ran, because
 * `proteus label mine` produces exactly that half and it costs nothing.
 */
export function renderCorpusReport(
  report: CorpusEvalReport,
  opts: {
    title: string;
    /** Where the turns came from and what the reader could not read, in the
     *  miner's own words. This module does not know the transcript format, so
     *  it cannot produce these — but a report without them would hide an
     *  unread half of the corpus. */
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
