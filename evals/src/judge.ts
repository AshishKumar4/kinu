/**
 * A model's judgement of what a check cannot compute, asked the way the diagnosis asks one (`scripts/diagnose.ts`): a
 * workspace of its own on the deployment, on the eval's default model, the pictures written into it, one yes-or-no
 * question, one word back. `evals/scripts/calibrate-judge.ts` measures how often it agrees with renders whose answer
 * is known; a check that asks it cites that agreement.
 */
import { DEFAULT_MODELS } from './config';
import { openWorkspace, type EvalTarget } from './target';
import { answered, repliesTo, settle, TurnWatch } from './workspace-completion';

const PICTURES = '/home/user/judge';

/** Whether pictures of one table are different designs of it, which `calibrate-judge.ts` measures the judge on. */
export const DIFFERENT_DESIGNS = 'Does each of these pictures show a visibly different design of the same pricing table: a '
  + 'different layout or presentation, not only a different colour, font or wording, so that no two of them are the same design?';

/** The judge's answer: yes, no, or null when it said anything else, with what it said. */
export type Judgement = { readonly verdict: boolean | null; readonly reply: string };

export async function judge(target: EvalTarget, question: string, pictures: readonly Uint8Array<ArrayBuffer>[]): Promise<Judgement> {
  const session = await openWorkspace(target, {
    subject: 'judge', mission: 'Looks at pictures it is given and answers one question about them.', model: DEFAULT_MODELS[0],
  });

  try {
    const files = pictures.map((picture, index) => ({ path: `${PICTURES}/${String(index + 1)}.png`, picture }));

    for (const { path, picture } of files) await session.writeFile(path, picture);

    const prompt = `Open each of these pictures with the file tool and look at it: ${files.map(({ path }) => path).join(', ')}. ${question} `
      + 'Reply with one word, yes or no.';

    const watch = new TurnWatch(session);

    await answered(watch, session.prompt(prompt));
    await settle(watch);
    const reply = repliesTo(await session.history(), prompt).at(-1)?.trim() ?? '';
    const word = /^\W*(yes|no)\W*$/i.exec(reply)?.[1]?.toLowerCase();

    return { verdict: word === undefined ? null : word === 'yes', reply: reply.slice(0, 300) };
  } finally {
    await session.teardown();
  }
}
