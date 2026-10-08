/**
 * A node's answer as the swarm reads it (*Arbitration*): the text that gets measured, and any branch it proposes on a
 * line of its own. A malformed proposal is named, not dropped.
 */
import { Effect } from 'effect';
import * as v from 'valibot';
import { extractJsonObject } from '../providers/structured';
import { renderIssues } from '../utils/json';
import { renderThrownChain } from '../obs/index';
import { settleSync } from '../obs/effect';
import { SWARM_CONTEXTS, type BranchProposal } from './swarm';

/** Ends an answer to request a branch; a line, not a fence, so code fences cannot match it. */
export const PROPOSAL_MARKER = 'PROPOSE-BRANCH';

/** A branch proposal (*Arbitration*). Strict, and carries no depth: a node never states its own (*Node identity*). */
const BranchProposalSchema = v.strictObject({
  rationale: v.string(),
  branches: v.array(v.strictObject({
    task: v.string(),
    rationale: v.string(),
    context: v.picklist(SWARM_CONTEXTS),
  })),
});

interface ReadAnswer {
  /** The answer with any proposal block removed: what gets measured. */
  readonly text: string;
  readonly proposal: BranchProposal | null;
  readonly proposalError: string | null;
}

/** Split a node's output into its answer and proposed branch; a malformed proposal is named, not dropped. */
export function readAnswer(text: string): ReadAnswer {
  const marker = text.indexOf(PROPOSAL_MARKER);

  if (marker < 0) return { text: text.trim(), proposal: null, proposalError: null };
  const answer = text.slice(0, marker).trim();
  const requested = text.slice(marker + PROPOSAL_MARKER.length);

  return settleSync(Effect.try({ try: () => extractJsonObject(requested), catch: (error) => error }).pipe(
    Effect.map((json): ReadAnswer => {
      const parsed = v.safeParse(BranchProposalSchema, json);

      if (!parsed.success) {
        return {
          text: answer,
          proposal: null,
          proposalError: `the ${PROPOSAL_MARKER} block did not describe a branch proposal, so it could `
            + `not be arbitrated: ${renderIssues(parsed.issues)}`,
        };
      }

      return { text: answer, proposal: parsed.output, proposalError: null };
    }),
    Effect.catch((error) => Effect.succeed<ReadAnswer>({
      text: answer,
      proposal: null,
      proposalError: `the ${PROPOSAL_MARKER} block carried no readable JSON object, so the branch `
        + `could not be arbitrated: ${renderThrownChain({ cause: error })}`,
    })),
  ));
}
