/** What an MCTS branch is asked and how its answer is read back, shared by every substrate so branches stay comparable. */

import { diversityDirective } from './diversity';
import { EVIDENCE_BUDGETS, evidenceWindow } from '../prompts/evidence-window';
import type { WorkMode } from '../types/turn';

/** A crafted tool as a branch is told about it; a branch reasons, it does not call tools. */
export interface ExploreToolHint {
  readonly name: string;
  readonly description: string;
}

export interface ExplorePromptInput {
  readonly mode: WorkMode;
  readonly context: string;
  readonly craftedTools: readonly ExploreToolHint[];
  readonly siblings: readonly string[];
  readonly languages: readonly [string, ...string[]];
}

export interface ExplorePrompt {
  readonly system: string;
  readonly user: string;
}

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
 * The failure post-mortem a branch writes about its own attempt. Lines for an empty
 * `attempt` or absent `outcome` are dropped rather than shown empty or guessed.
 */
export function reflectionPrompt(task: string, attempt: string, outcome?: string): string {
  const bounded = evidenceWindow(attempt, EVIDENCE_BUDGETS.reflection);

  return `Task: ${evidenceWindow(task, EVIDENCE_BUDGETS.reflection)}\n`
    + (bounded ? `Attempt: ${bounded}\n` : '')
    + (outcome ? `Outcome: ${outcome}\n` : '')
    + `\nWhat specifically went wrong? One sentence.`;
}
