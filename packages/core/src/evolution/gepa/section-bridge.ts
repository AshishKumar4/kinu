/**
 * GEPA → prompt-section bridge, shaped like `scaffold-bridge.ts`. Seeds from the
 * incumbent, rejects unshippable candidates in-loop (slot contract, misevolution
 * checklist, byte ceiling), and hands a strictly better winner to
 * `proposePromptSection`, where it lands pending; promotion is `decidePromotion`'s.
 * A section is bytes every turn pays for, so a longer candidate must also pass
 * `checkPromptSizeRule`, reported as its own outcome.
 */

import type { SqlExecutor } from '../../types/primitives';
import type { ActorHandle } from '../../identity/actor-handle';
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
  EvalInstance, GepaConfig, GepaMetric, GepaResult, ReflectionLM, GepaProgressHooks,
} from './types';

/**
 * Sections GEPA may target, all under one mutation-size ceiling. Per-line fragments
 * are absent: evolved alone, a line is scored against a prompt it cannot move.
 * None is a safety exemption; the misevolution gate covers the approvals doctrine.
 */
export const PROMPT_SECTION_TARGETS: readonly PromptSection<string>[] = PROMPT_SECTIONS;

export function findPromptSectionTarget(sectionId: string): PromptSection<string> | undefined {
  return PROMPT_SECTION_TARGETS.find((section) => section.id === sectionId);
}

export interface RunSectionGepaOpts<I = unknown, E = unknown> extends GepaProgressHooks {
  sql: SqlExecutor;
  actor: ActorHandle;
  sectionId: string;
  evalSet: ReadonlyArray<EvalInstance<I, E>>;
  /** Reflection-minibatch source; defaults to evalSet. */
  trainSet?: ReadonlyArray<EvalInstance<I, E>>;
  metric: GepaMetric<I, E>;
  reflectionLm: ReflectionLM;
  budget?: GepaConfig<I, E>['budget'];
}

export interface RunSectionGepaResult {
  sectionId: string;
  /** Null when the target was unknown and the run never started. */
  gepa: GepaResult | null;
  winnerScore: ScoreInterval;
  /** Compare both intervals before believing the winner is better. */
  incumbentScore: ScoreInterval;
  proposed: boolean;
  pendingVersion: number | null;
  /** `size_rule` is the anti-bloat rule working, not a failure. */
  skipReason?:
    | 'unknown_section'
    | 'winner_equals_incumbent'
    | 'size_rule'
    | 'propose_gate_rejected';
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

  const seed = incumbentSectionSource(opts.sql, opts.actor, section);
  // A candidate declaring any other slot would leave a hole or throw mid-turn, so it is rejected before scoring.
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
    onCandidate: opts.onCandidate,
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

  // Ties go to the older candidate and the seed is oldest, so reaching the gate means a strictly better aggregate.
  if (winner.source === seed) {
    return { ...base, proposed: false, pendingVersion: null, skipReason: 'winner_equals_incumbent' };
  }

  const rationale =
    `GEPA-optimised ${section.id} — ${formatScoreInterval(winnerScore, 3)} over `
    + `${String(gepa.history.length - 1)} mutations (incumbent: ${formatScoreInterval(incumbentScore, 3)}), `
    + `${String(Buffer.byteLength(winner.source, 'utf8'))} bytes against `
    + `${String(Buffer.byteLength(seed, 'utf8'))}.`;

  const proposal = proposePromptSection(opts.sql, opts.actor, {
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
