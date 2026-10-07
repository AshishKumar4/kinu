/**
 * A model's judgement of what a check cannot compute, asked as the diagnosis asks one (`askOnce`): a workspace of its
 * own on the deployment, on the reviewer's model, the pictures written into it, one yes-or-no question, one word
 * back. `evals/scripts/calibrate-judge.ts` measures how often it agrees with renders whose answer is known; a check that
 * asks it cites that agreement.
 */
import { WORKSPACE_ROOT } from '@kinu.run/core';
import { REVIEW_MODEL } from './config';
import { askOnce, type EvalTarget } from './target';

const PICTURES = `${WORKSPACE_ROOT}/judge`;

/** Whether pictures of one table are different designs of it, which `calibrate-judge.ts` measures the judge on. */
export const DIFFERENT_DESIGNS = 'Does each of these pictures show a visibly different design of the same pricing table: a '
  + 'different layout or presentation, not only a different colour, font or wording, so that no two of them are the same design?';

/** The judge's answer: yes, no, or null when it said anything else, with what it said. */
export type Judgement = { readonly verdict: boolean | null; readonly reply: string };

export async function judge(target: EvalTarget, question: string, pictures: readonly Uint8Array<ArrayBuffer>[]): Promise<Judgement> {
  const files = pictures.map((content, index) => ({ path: `${PICTURES}/${String(index + 1)}.png`, content }));

  const reply = await askOnce(target, {
    subject: 'judge', mission: 'Looks at pictures it is given and answers one question about them.', model: REVIEW_MODEL, files,
    prompt: `Open each of these pictures with the file tool and look at it: ${files.map(({ path }) => path).join(', ')}. ${question} `
      + 'Reply with one word, yes or no.',
  });

  const word = /^\W*(yes|no)\W*$/i.exec(reply)?.[1]?.toLowerCase();

  return { verdict: word === undefined ? null : word === 'yes', reply: reply.slice(0, 300) };
}
