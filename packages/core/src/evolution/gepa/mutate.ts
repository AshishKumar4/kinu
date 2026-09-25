/** Reflective mutation: roll the parent out on a minibatch and have the reflection LM rewrite it from the failure trajectories. */

import * as v from 'valibot';
import { MetricOutcomeSchema } from './types';
import type {
  EvalInstance, GepaCandidate, GepaMetric, MetricOutcome, ReflectionLM,
} from './types';
import { renderInput, truncate } from './text';
import { stripMarkdownFences } from '../../providers/structured';
import { EVIDENCE_BUDGETS, evidenceWindow } from '../../utils/evidence-window';
import { DELEGATION_RUBRIC } from '../delegation-features';

export interface MutationContext<I = unknown, E = unknown> {
  parent: GepaCandidate;
  minibatch: ReadonlyArray<EvalInstance<I, E>>;
  /** Missing judge evidence must fail before reflection. */
  rollout: MutationRollout;
  reflectionLm: ReflectionLM;
}

export interface MutationRollout {
  outcomes: Array<{ instanceId: string; outcome: MetricOutcome }>;
  /** Equals minibatch.length. */
  metricCalls: number;
}

export async function rolloutMinibatch<I, E>(
  candidate: string,
  minibatch: ReadonlyArray<EvalInstance<I, E>>,
  metric: GepaMetric<I, E>,
): Promise<MutationRollout> {
  const outcomes: MutationRollout['outcomes'] = [];

  for (const inst of minibatch) {
    const o = v.parse(MetricOutcomeSchema, await metric(candidate, inst));
    outcomes.push({ instanceId: inst.id, outcome: o });
  }

  return { outcomes, metricCalls: minibatch.length };
}

/** The full per-instance trace is never shortened: GEPA's result is that natural-language
 *  feedback over whole trajectories beats a scalar reward (arXiv:2507.19457). */
export function renderReflectionPrompt<I, E>(opts: {
  parent: GepaCandidate;
  minibatch: ReadonlyArray<EvalInstance<I, E>>;
  rollout: MutationRollout;
  artifactDescription?: string;
}): string {
  const desc = opts.artifactDescription ?? 'candidate artifact';
  const processRubric = desc === 'scaffold source' ? `\n\n${DELEGATION_RUBRIC}` : '';

  const outcomeById = new Map(opts.rollout.outcomes.map(o => [o.instanceId, o.outcome]));
  const traceLines: string[] = [];

  for (const inst of opts.minibatch) {
    const o = outcomeById.get(inst.id);

    if (!o) continue;
    const inputStr = renderInput(inst);
    traceLines.push(
      `--- instance ${inst.id} (score ${o.score.toFixed(2)}) ---`,
      // Windows, not head truncations: a rollout's decisive step is usually its last.
      `input: ${evidenceWindow(inputStr, EVIDENCE_BUDGETS.gepaInstanceInput)}`,
      ...(inst.evidence ? [`evidence: ${evidenceWindow(inst.evidence, EVIDENCE_BUDGETS.gepaInstanceEvidence)}`] : []),
      `feedback: ${evidenceWindow(o.feedback, EVIDENCE_BUDGETS.gepaInstanceFeedback)}`,
      '',
    );
  }

  return `You are improving a ${desc}. The current version scored sub-optimally on the following instances.

Read each instance's input + evidence + feedback. Identify a SPECIFIC defect that explains the failures, then propose a revised ${desc} that fixes it without regressing on other axes. Keep the revision tightly scoped — large rewrites get rejected by downstream gates.

Specific and tightly scoped, by contrast:
  Good: "i2 and i5 both stop as soon as a tool result comes back empty — treat an empty result as a step to continue from rather than a reason to finish." One defect, one edit, named instances.
  Bad: "it is too rigid; restructure it and add error handling." No instance named, no defect named, and a rewrite the downstream gate rejects on size alone.

You are shown only the instances that scored badly. The rest of the eval set is scored too, and you cannot see it — so do not remove or weaken anything the failures above do not implicate. A revision that trades one instance for another scores worse, not better.${processRubric}

Current ${desc}:
\`\`\`
${truncate(opts.parent.source, EVIDENCE_BUDGETS.gepaParentSource)}
\`\`\`

Aggregate score on the full eval set: ${opts.parent.aggregateScore.toFixed(3)}

Recent rollouts on minibatch:
${traceLines.join('\n')}

Return ONLY the revised ${desc} source — no commentary, no markdown fences. If you cannot improve on the current version, return the source unchanged.`;
}

export async function proposeMutation<I, E>(
  ctx: MutationContext<I, E>,
  artifactDescription?: string,
): Promise<{ source: string; rollout: MutationRollout }> {
  const { rollout } = ctx;

  const prompt = renderReflectionPrompt({
    parent: ctx.parent, minibatch: ctx.minibatch, rollout, artifactDescription,
  });

  const raw = await ctx.reflectionLm(prompt);
  const source = stripMarkdownFences(raw);

  return { source, rollout };
}
