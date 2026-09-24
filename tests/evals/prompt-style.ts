/**
 * The prompt an arm hands the agent in place of a task as written (`EvalArmState.prompt`).
 *
 * `caveman` is the terse style a parent agent sometimes writes subagent missions in (m790): articles,
 * copulas, filler and the addressee dropped. Everything a task's ground truth depends on is kept
 * byte-for-byte: code spans, indented and fenced lines, and every token carrying a digit, a path or an
 * identifier character. Deterministic, so both arms of an A/B read the same mission in two styles.
 *
 * `use-swarm` is the task as written plus an explicit instruction to search with the swarm (m138: "test
 * MCTS for solving real tasks, agent explicitly told to use it").
 */
import type { EvalPromptStyle } from '@kinu.run/test-utils';

/** Only bare alphabetic words are dropped; negations, quantifiers and verbs are never on this list. */
const CAVEMAN_DROPPED: ReadonlySet<string> = new Set([
  'a', 'an', 'the', 'is', 'are', 'am', 'was', 'were', 'be', 'been', 'being',
  'please', 'just', 'really', 'very', 'simply', 'actually', 'basically', 'kindly', 'you', 'your',
]);

export const SWARM_DIRECTIVE = 'Use a swarm for this task: call the `agents` tool with action `swarm` to search for '
  + 'the solution before you settle on one.';

function cavemanLine(line: string): string {
  const indent = /^ */.exec(line)?.[0] ?? '';
  // Code spans are kept whole; only the prose between them loses words.
  const parts = line.slice(indent.length).split(/(`[^`]*`)/);

  const kept = parts.map((part) => (part.startsWith('`')
    ? part
    : part.split(' ').filter((word) => !CAVEMAN_DROPPED.has(word.toLowerCase())).join(' ')));

  return indent + kept.join('').replace(/ {2,}/g, ' ').trim();
}

export function cavemanPrompt(task: string): string {
  let fenced = false;

  return task.split('\n').map((line) => {
    if (line.trimStart().startsWith('```')) {
      fenced = !fenced;

      return line;
    }

    // Fenced and indented lines are code or data: a signature, an input shape, an oracle contract.
    return fenced || /^( {4}|\t)/.test(line) ? line : cavemanLine(line);
  }).join('\n');
}

export function promptFor(task: string, style: EvalPromptStyle | undefined): string {
  if (style === 'caveman') return cavemanPrompt(task);

  if (style === 'use-swarm') return `${task}\n\n${SWARM_DIRECTIVE}`;

  return task;
}
