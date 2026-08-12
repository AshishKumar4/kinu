/**
 * What an MCTS branch is asked, and how its answer is read back.
 *
 * A branch runs on whichever substrate the backend has — a Cloudflare facet, a
 * local subprocess, or an inline closure when facets are unavailable — and the
 * substrate is genuinely different in each case. The QUESTION is not: the
 * prompt, the diversity directive and the ```js extraction are what makes two
 * branches comparable, and the evaluator that grounds a branch by EXECUTING
 * its code only has code to run because the prompt asked for a fenced block.
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

/** A crafted tool as a branch is told about it — name and description only. A
 *  branch reasons, it does not call tools. */
export interface ExploreToolHint {
  readonly name: string;
  readonly description: string;
}

export interface ExplorePromptInput {
  /** The parent conversation, already bounded (formatInheritedContext). */
  readonly context: string;
  /** Patterns this agent has already crafted, offered as prior art. */
  readonly craftedTools: readonly ExploreToolHint[];
  /** The angles this branch's parallel siblings were handed (siblingAngles). */
  readonly siblings: readonly string[];
}

export interface ExplorePrompt {
  readonly system: string;
  readonly user: string;
}

/** The one question every branch is asked. */
export function explorePrompt({ context, craftedTools, siblings }: ExplorePromptInput): ExplorePrompt {
  const toolHints = craftedTools.length > 0
    ? `\nKnown patterns:\n${craftedTools.map((t) => `- ${t.name}: ${t.description}`).join('\n')}`
    : '';
  return {
    system: 'You are an expert agent exploring one approach to solve a task.' + toolHints
      + '\n\nIf your approach involves code, include it in a ```js code block.',
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

/** The fenced implementation a branch was asked for, or null when it answered
 *  in prose. What the grounded evaluator executes, so the fence languages
 *  accepted here are the ones a branch may answer in. */
export function extractCodeBlock(text: string): string | null {
  return text.match(/```(?:js|javascript|typescript|ts)?\n([\s\S]*?)```/)?.[1]?.trim() ?? null;
}
