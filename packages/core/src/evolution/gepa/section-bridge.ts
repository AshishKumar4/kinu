/**
 * GEPA → prompt-section bridge.
 *
 * The sibling of `scaffold-bridge.ts`, and deliberately the same shape: run
 * GEPA over one addressable artifact under artifact-aware constraints, then
 * hand a strictly-better winner to the gate that owns proposals. Flow:
 *
 *   1. Resolve the target from `PROMPT_SECTION_TARGETS` — the nine sections
 *      `prompting/section-templates.ts` registers. An unknown id is refused
 *      rather than optimised into nothing.
 *   2. Seed from the INCUMBENT: the promoted source if the section has one,
 *      else the template compiled into the bundle. Evolution is cumulative or
 *      it is a treadmill.
 *   3. Run GEPA with section-aware constraints — the slot contract, the fixed
 *      misevolution checklist, and the byte ceiling — so a candidate that
 *      cannot ship never costs a scoring call.
 *   4. Hand the winner to `proposePromptSection`, where it lands PENDING. The
 *      live prompt does not move: `buildSystemPromptSync` reads only
 *      `status='current'` rows, and a pending one is not current. Promotion
 *      needs trials and `decidePromotion` — the scaffold's own calibrated rule.
 *
 * No behavioural promotion happens here, exactly as in the scaffold bridge.
 * GEPA is a proposal generator.
 *
 * What this bridge adds that the scaffold's does not need: THE SIZE RULE
 * (`checkPromptSizeRule`). A scaffold is one file the agent runs; a prompt
 * section is bytes every turn pays for. So a longer candidate has to earn the
 * bytes with a score that clears the incumbent's mean, and the refusal is
 * reported as its own outcome rather than folded into "the gate said no" —
 * anti-bloat working as designed reads differently from a safety veto.
 */

import type { SqlExecutor } from '../../types/primitives';
import { renderThrownChain } from '../../obs/error';
import { checkMisevolution } from '../../scaffold/misevolution';
import { PROMPT_SECTIONS } from '../../prompting/section-templates';
import { templateContract, type PromptSection } from '../../prompting/template';
import {
  incumbentSectionSource, proposePromptSection,
  PROMPT_SECTION_MAX_BYTES,
  type ProposeSectionRefusal,
} from '../../prompting/section-store';
import { formatScoreInterval, scoreInterval, type ScoreInterval } from '../../utils/stats';
import { runGepa } from './engine';
import type {
  EvalInstance, GepaConfig, GepaMetric, GepaResult, ReflectionLM,
} from './types';

/**
 * The prompt sections GEPA may target: all nine, and nothing else.
 *
 * Every one is prose the model reads and the builder emits as one block, which
 * is what makes it scorable end to end. The per-line fragments
 * (`tools/builtin-line`, the executor lines) are deliberately absent: a line
 * evolved on its own would be scored against a prompt it cannot move, and its
 * wording is mapped over typed data rather than authored.
 *
 * Nothing here is a safety exemption. The Execution-environments section
 * carries the approvals doctrine, so it is exactly the section the misevolution
 * `consent-weakening` criterion exists for — the answer is the gate, not a
 * shorter list.
 */
export const PROMPT_SECTION_TARGETS: readonly PromptSection<string>[] = PROMPT_SECTIONS;

export function findPromptSectionTarget(sectionId: string): PromptSection<string> | undefined {
  return PROMPT_SECTION_TARGETS.find((section) => section.id === sectionId);
}

export interface RunSectionGepaOpts<I = unknown, E = unknown> {
  sql: SqlExecutor;
  /** Which registered section to evolve. */
  sectionId: string;
  /** Held-out instances the winner is selected on. */
  evalSet: ReadonlyArray<EvalInstance<I, E>>;
  /** Reflection-minibatch source (the outcome-labeled negatives to fix).
   *  Defaults to evalSet — see GepaConfig.trainSet. */
  trainSet?: ReadonlyArray<EvalInstance<I, E>>;
  /** Scores a candidate SECTION SOURCE against one labeled turn. */
  metric: GepaMetric<I, E>;
  reflectionLm: ReflectionLM;
  budget?: GepaConfig<I, E>['budget'];
  onIteration?: GepaConfig<I, E>['onIteration'];
}

export interface RunSectionGepaResult {
  /** The section this run targeted. */
  sectionId: string;
  /** The raw GEPA output — winner + Pareto front + history. Absent when the
   *  run never started because the target was unknown. */
  gepa: GepaResult | null;
  /** The winner's eval-set score with its 95% interval. */
  winnerScore: ScoreInterval;
  /** The incumbent's eval-set score with its 95% interval. Read the two
   *  intervals against each other before believing the winner is better. */
  incumbentScore: ScoreInterval;
  /** Whether the winner was handed to `proposePromptSection` and accepted. */
  proposed: boolean;
  /** If proposed, the section's new pending version; null otherwise. */
  pendingVersion: number | null;
  /** Why we didn't propose. `size_rule` is its own outcome on purpose: it is
   *  the anti-bloat rule doing its job, not a failure. */
  skipReason?:
    | 'unknown_section'
    | 'winner_equals_incumbent'
    | 'size_rule'
    | 'propose_gate_rejected';
  /** If the gate refused, which bar and why. */
  proposeError?: { code: ProposeSectionRefusal; error: string };
}

const EMPTY_INTERVAL: ScoreInterval = { mean: 0, lo: 0, hi: 0, n: 0 };

export async function runSectionGepa<I = unknown, E = unknown>(
  opts: RunSectionGepaOpts<I, E>,
): Promise<RunSectionGepaResult> {
  const section = findPromptSectionTarget(opts.sectionId);
  if (!section) {
    return {
      sectionId: opts.sectionId, gepa: null,
      winnerScore: EMPTY_INTERVAL, incumbentScore: EMPTY_INTERVAL,
      proposed: false, pendingVersion: null, skipReason: 'unknown_section',
    };
  }

  const seed = incumbentSectionSource(opts.sql, section);
  // The contract the builder will supply values for. A candidate that declares
  // anything else renders a prompt with a hole in it or throws mid-turn, so it
  // is rejected in-loop rather than after it has been scored.
  const wanted = templateContract(section.id, seed);
  const wantedKey = `${wanted.slots.join('|')}//${wanted.flags.join('|')}`;

  const gepa = await runGepa({
    seed,
    evalSet: opts.evalSet,
    trainSet: opts.trainSet,
    metric: opts.metric,
    reflectionLm: opts.reflectionLm,
    budget: opts.budget,
    onIteration: opts.onIteration,
    constraints: {
      maxSizeBytes: PROMPT_SECTION_MAX_BYTES,
      customCheck: (source) => {
        let offered;
        try {
          offered = templateContract(section.id, source);
        } catch (err) {
          return renderThrownChain({ cause: err });
        }
        if (`${offered.slots.join('|')}//${offered.flags.join('|')}` !== wantedKey) {
          return `slot contract changed — expected {slots: ${wanted.slots.join(', ') || '(none)'}; `
            + `flags: ${wanted.flags.join(', ') || '(none)'}}`;
        }
        const misevolution = checkMisevolution(source);
        return misevolution.ok
          ? null
          : `Misevolution veto (${misevolution.criterionId}): ${misevolution.reason}`;
      },
    },
  });

  const winner = gepa.winner;
  const winnerScore = scoreInterval([...winner.scores.values()]);
  const incumbentScore = scoreInterval([...(gepa.history[0]?.scores.values() ?? [])]);
  const scores = { winnerScore, incumbentScore };
  const base = { sectionId: section.id, gepa, ...scores };

  // `bestAggregate` breaks ties by `createdAt` (older wins) and the seed is
  // always the oldest, so any candidate tied with or below the incumbent yields
  // `winner === seed`. Reaching the gate at all means GEPA found a strictly
  // better aggregate; the size rule then asks whether "better" survives the
  // interval, which is a different and higher question.
  if (winner.source === seed) {
    return { ...base, proposed: false, pendingVersion: null, skipReason: 'winner_equals_incumbent' };
  }

  const rationale =
    `GEPA-optimised ${section.id} — ${formatScoreInterval(winnerScore, 3)} over `
    + `${String(gepa.history.length - 1)} mutations (incumbent: ${formatScoreInterval(incumbentScore, 3)}), `
    + `${String(Buffer.byteLength(winner.source, 'utf8'))} bytes against `
    + `${String(Buffer.byteLength(seed, 'utf8'))}.`;

  const proposal = proposePromptSection(opts.sql, {
    section,
    source: winner.source,
    rationale,
    incumbentScore,
    candidateScore: winnerScore,
  });
  if (!proposal.ok) {
    return {
      ...base, proposed: false, pendingVersion: null,
      skipReason: proposal.code === 'size_rule' ? 'size_rule' : 'propose_gate_rejected',
      proposeError: { code: proposal.code, error: proposal.error },
    };
  }
  return { ...base, proposed: true, pendingVersion: proposal.version };
}
