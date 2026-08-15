/**
 * Reflective mutation operator — the heart of GEPA's leverage over random
 * search. The parent candidate is rolled out on a small minibatch of eval
 * instances, the per-instance score + feedback is collected, and the
 * reflection LM is asked to rewrite the candidate using the failure
 * trajectories as evidence. One LM call per mutation; cost is bounded.
 */

import type {
  EvalInstance, GepaCandidate, GepaMetric, MetricOutcome, ReflectionLM,
} from './types.js';
import { renderInput, truncate } from './text.js';
import { stripMarkdownFences } from '../../prompts/structured.js';
import { EVIDENCE_BUDGETS, evidenceWindow } from '../../prompts/evidence-window.js';

export { stripMarkdownFences } from '../../prompts/structured.js';

export interface MutationContext<I = unknown, E = unknown> {
  parent: GepaCandidate;
  /** The minibatch the parent will be rolled out on. */
  minibatch: ReadonlyArray<EvalInstance<I, E>>;
  metric: GepaMetric<I, E>;
  reflectionLm: ReflectionLM;
}

export interface MutationRollout {
  /** Per-instance score + feedback collected from rolling parent on minibatch. */
  outcomes: Array<{ instanceId: string; outcome: MetricOutcome }>;
  /** Total metric calls made — equals minibatch.length. */
  metricCalls: number;
}

/** Roll out a candidate over a minibatch — score each, collect feedback. */
export async function rolloutMinibatch<I, E>(
  candidate: string,
  minibatch: ReadonlyArray<EvalInstance<I, E>>,
  metric: GepaMetric<I, E>,
): Promise<MutationRollout> {
  const outcomes: MutationRollout['outcomes'] = [];
  for (const inst of minibatch) {
    const o = await metric(candidate, inst);
    outcomes.push({ instanceId: inst.id, outcome: o });
  }
  return { outcomes, metricCalls: minibatch.length };
}

/** Render the reflection prompt the LM uses to propose a new candidate.
 *  Exposed for testing + so callers can override format if needed. */
export function renderReflectionPrompt<I, E>(opts: {
  parent: GepaCandidate;
  minibatch: ReadonlyArray<EvalInstance<I, E>>;
  rollout: MutationRollout;
  /** Optional context describing what the candidate IS (e.g., "scaffold source"). */
  artifactDescription?: string;
}): string {
  const desc = opts.artifactDescription ?? 'candidate artifact';
  const processRubric = desc === 'scaffold source'
    ? '\n\nProcess rubric: For corrected/frustrated requests with 2+ independent parts, consider long zero-team/think linear grinds for decomposition and staffing/heads; reinforce effective team/think on accepted turns; treat non-contributing spawns as delegation overhead.'
    : '';

  const outcomeById = new Map(opts.rollout.outcomes.map(o => [o.instanceId, o.outcome]));
  const traceLines: string[] = [];
  for (const inst of opts.minibatch) {
    const o = outcomeById.get(inst.id);
    if (!o) continue;
    const inputStr = renderInput(inst.input);
    traceLines.push(
      `--- instance ${inst.id} (score ${o.score.toFixed(2)}) ---`,
      // Windows, not head truncations: a rollout's decisive step is usually
      // its last, and 400 characters of a twelve-step trajectory is a reflector
      // reasoning about the opening move.
      `input: ${evidenceWindow(inputStr, EVIDENCE_BUDGETS.gepaInstanceInput)}`,
      ...(inst.evidence ? [`evidence: ${evidenceWindow(inst.evidence, EVIDENCE_BUDGETS.gepaInstanceEvidence)}`] : []),
      `feedback: ${evidenceWindow(o.feedback, EVIDENCE_BUDGETS.gepaInstanceFeedback)}`,
      '',
    );
  }

  return `You are improving a ${desc}. The current version scored sub-optimally on the following instances.

Read each instance's input + evidence + feedback. Identify a SPECIFIC defect that explains the failures, then propose a revised ${desc} that fixes it without regressing on other axes. Keep the revision tightly scoped — large rewrites get rejected by downstream gates.${processRubric}

Current ${desc}:
\`\`\`
${truncate(opts.parent.source, EVIDENCE_BUDGETS.gepaParentSource)}
\`\`\`

Aggregate score on the full eval set: ${opts.parent.aggregateScore.toFixed(3)}

Recent rollouts on minibatch:
${traceLines.join('\n')}

Return ONLY the revised ${desc} source — no commentary, no markdown fences. If you cannot improve on the current version, return the source unchanged.`;
}

/** Roll out + reflect + extract — produces the next candidate's source. */
export async function proposeMutation<I, E>(
  ctx: MutationContext<I, E>,
  artifactDescription?: string,
): Promise<{ source: string; rollout: MutationRollout }> {
  const rollout = await rolloutMinibatch(ctx.parent.source, ctx.minibatch, ctx.metric);
  const prompt = renderReflectionPrompt({
    parent: ctx.parent, minibatch: ctx.minibatch, rollout, artifactDescription,
  });
  const raw = await ctx.reflectionLm(prompt);
  const source = stripMarkdownFences(raw);
  return { source, rollout };
}
