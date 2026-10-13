/**
 * The one table of what a turn reaches by whom it answers (design v2 §1.6), asserted against the tools each host's real
 * turn offered: the cloud's workspace agent, a cloud hire and the CLI. A host that decided a gate on its own would
 * disagree with the table on its row.
 */

/** The tools whose offer the turn's lane decides. */
const GATED: readonly string[] = ['ask_owner', 'report', 'submit_plan'];

/** The gated tools among those a turn was offered, sorted. */
export function gatedTools(offered: Iterable<string>): string[] {
  return [...offered].filter((name) => GATED.includes(name)).sort();
}

/** What each kind of turn offers, in Build, on a host that shows the owner the agent's questions and plans. */
export const TURN_REACH = {
  /** The owner's own words: the owner's lane. */
  ownerWords: ['ask_owner', 'submit_plan'],
  /** The turn the owner's answer to a question resumes: the owner's decision, so the owner's lane, hire or not. */
  ownerAnswer: ['ask_owner', 'submit_plan'],
  /** A hire's assignment from its hirer: the hirer's lane, which reports and asks the owner nothing. */
  assignment: ['report'],
} as const satisfies Record<string, readonly string[]>;
