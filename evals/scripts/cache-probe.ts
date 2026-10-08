#!/usr/bin/env bun
/**
 * ONE MODEL'S PROMPT CACHE ON A DEPLOYMENT, by hand. Claude and ChatGPT spend the owner's plan, so no gate runs them
 * (`CACHE_TARGET`, src/comparison.ts); this does, when asked. Each session is a fresh workspace pinned to the model, as
 * eval-service, given five turns of file work; every request's usage is then read back from its run events. It prints
 * each session's requests and the steady cache share over them all, every actor's first request aside, and exits 1 below
 * the target.
 *   KINU_EVAL_ORIGIN=<origin> KINU_EVAL_STAGING_WEB_IDENTITY=… bun evals/scripts/cache-probe.ts <model spec> [sessions]
 */
import { CACHE_TARGET } from '../src/comparison';
import { measurePromptUsage, steadyCacheShare, type StepUsage } from '../src/results';
import { openWorkspace, resolveEvalTarget } from '../src/target';
import { answered, settle, TurnWatch } from '../src/workspace-completion';

const TURNS = [
  'Write notes/offsite.md: a heading and five numbered steps for planning a team offsite. Then read it back and tell me step three.',
  'Add a sixth step about the budget to notes/offsite.md, and write notes/budget.md with a three-row table of costs.',
  'List what is in notes/ and tell me which file is longer, by reading both.',
  'Rewrite step two in notes/offsite.md to name a venue, then read the file again and quote the changed line.',
  'Without opening any file, what did the first thing I asked you to write contain?',
];

const [model, sessions = '3'] = process.argv.slice(2);

if (model === undefined) throw new Error('usage: bun evals/scripts/cache-probe.ts <model spec> [sessions]');

const target = resolveEvalTarget(process.env);

const runs: StepUsage[][] = [];

for (let index = 0; index < Number(sessions); index += 1) {
  const session = await openWorkspace(target, { subject: `cache-${String(index)}`, mission: 'Help plan an offsite with notes in files.', model });

  try {
    for (const text of TURNS) {
      const watch = new TurnWatch(session);

      await answered(watch, session.prompt(text));
      await settle(watch);
    }

    const { metadata: { steps } } = measurePromptUsage(await session.actorLedgers(await session.runEvents()));

    runs.push(steps);
    console.log(`session ${String(index)}: ${steps.map((step) => `${String(step.cacheReadTokens)}/${String(step.inputTokens)}`).join(' ')}`);
  } finally {
    await session.teardown();
  }
}

const share = steadyCacheShare(runs);

console.log(`${model} on ${target.origin}: steady cache ${share === null ? 'unreported' : `${(share * 100).toFixed(1)}%`}, target ${String(CACHE_TARGET * 100)}%`);

process.exitCode = share !== null && share >= CACHE_TARGET ? 0 : 1;
