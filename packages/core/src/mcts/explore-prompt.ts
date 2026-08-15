/**
 * What an MCTS branch is asked, and how its answer is read back.
 *
 * A branch runs on whichever substrate the backend has — a Cloudflare facet, a
 * local subprocess, or an inline closure when facets are unavailable — and the
 * substrate is genuinely different in each case. The QUESTION is not: the
 * prompt and diversity directive make branches comparable. The executor's
 * declared languages keep the prompt aligned with the evaluator that will run
 * the fenced implementation.
 *
 * Written per substrate, it drifted — and drifted invisibly, because each copy
 * was only ever compared against itself. The inline fallback carried a comment
 * claiming it "match[ed] the Facet's explore() exactly" while asking a
 * materially weaker question: no known-patterns hints, "Propose ONE approach"
 * instead of "ONE specific concrete approach", and a reflection prompt that
 * never mentioned the attempt it was reflecting on. Branches from the fallback
 * path were therefore scored against branches asked something else.
 */

import { diversityDirective } from './diversity.js';
import { EVIDENCE_BUDGETS, evidenceWindow } from '../prompts/evidence-window.js';
import type { WorkMode } from '../prompting/surface.js';

/** A crafted tool as a branch is told about it — name and description only. A
 *  branch reasons, it does not call tools. */
export interface ExploreToolHint {
  readonly name: string;
  readonly description: string;
}

export interface ExplorePromptInput {
  readonly mode: WorkMode;
  /** The parent conversation, already bounded (formatInheritedContext). */
  readonly context: string;
  /** Patterns this agent has already crafted, offered as prior art. */
  readonly craftedTools: readonly ExploreToolHint[];
  /** The angles this branch's parallel siblings were handed (siblingAngles). */
  readonly siblings: readonly string[];
  /** Languages the executor that will score this proposal can run. */
  readonly languages: readonly [string, ...string[]];
}

export interface ExplorePrompt {
  readonly system: string;
  readonly user: string;
}

/** The one question every branch is asked. */
export function explorePrompt({ mode, context, craftedTools, siblings, languages }: ExplorePromptInput): ExplorePrompt {
  const toolHints = craftedTools.length > 0
    ? `\nKnown patterns:\n${craftedTools.map((t) => `- ${t.name}: ${t.description}`).join('\n')}`
    : '';
  if (mode === 'plan') {
    return {
      system: 'You are an expert agent exploring one read-only planning approach.' + toolHints
        + '\n\nInspect and reason about the task, but do not author runnable implementation code or change any system state.',
      user: `Prior context:\n${context}\n\n`
        + 'Propose ONE specific planning approach. Ground it in relevant components, risks, and verification. Do not implement it.'
        + diversityDirective(siblings),
    };
  }
  const alternatives = languages.slice(1);
  return {
    system: 'You are an expert agent exploring one approach to solve a task.' + toolHints
      + `\n\nIf your approach involves code, include it in a \`\`\`${languages[0]} code block`
      + (alternatives.length > 0 ? ` (or ${alternatives.join('/')}, which also run here)` : '')
      + '. Code in any other language cannot be run here and remains unverified.',
    user: `Prior context:\n${context}\n\n`
      + `Propose ONE specific concrete approach. Include a code implementation if applicable.`
      + diversityDirective(siblings),
  };
}

/**
 * The failure post-mortem a branch writes about its own attempt.
 *
 * Both ends of the attempt are kept under the shared evidence budget: a
 * reflection is about how the attempt ENDED, and the unbounded version put a
 * whole trace into a prompt asking for one sentence. `attempt` is empty on a
 * substrate with no trace table, which drops the line rather than showing the
 * model an empty heading.
 */
export function reflectionPrompt(task: string, attempt: string): string {
  const bounded = evidenceWindow(attempt, EVIDENCE_BUDGETS.reflection);
  return `Task: ${evidenceWindow(task, EVIDENCE_BUDGETS.reflection)}\n`
    + (bounded ? `Attempt: ${bounded}\n` : '')
    + `\nWhat specifically went wrong? One sentence.`;
}
