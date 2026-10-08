import { slateUiSegments, type JsonValue } from '@kinu.run/core';
import type { SlateView, WorkspaceBrowser } from '../src/browser';
import { sightEvidence, type Sight } from '../src/sight';
import type { EvalCheckOutcome, EvalVerifier } from '../src/verifier';

// What every task that expects an ephemeral answer checks the same way: that the chat draws the answer's
// `<slate-ui>` blocks, that no file slate was made for a one-off view, and how each block reads once drawn.

/**
 * The answer holds at least `least` ephemeral slates, and a fresh chat page draws every one its text holds: a view, not
 * only words. The text is the answer's last part (`repliesTo`), so the frames drawn are what count at the least.
 */
export async function answersWithSlates(verifier: EvalVerifier, least: number): Promise<void> {
  await verifier.check('answers-with-ephemeral-slates', () => verifier.browse(async (browser) => {
    const blocks = verifier.replies.flatMap(slateUiSegments).flatMap((segment) => segment.kind === 'slate' ? [segment.name] : []);
    const drawn = (await browser.answerSlates(await browser.open(), Math.max(least, blocks.length))).length;

    return { pass: drawn >= least && drawn >= blocks.length, evidence: { blocks, drawn, least } };
  }));
}

/** A one-off view stays one: the workspace holds no file slate. */
export async function madeNoApp(verifier: EvalVerifier): Promise<void> {
  await verifier.check('made-no-file-slate', async () => {
    const listing = await verifier.slates();

    return { pass: listing.slates.length === 0, evidence: { slates: listing.slates.map((slate) => slate.id) } };
  });
}

/** What a prototype leaves in a turn whose answer is its own page: a page or a server of its own, or a browser on one. */
const PROTOTYPE = /\.html\b|\$preview\(|openBrowser|connectBrowser|screenshot|http\.server|npx serve|\bvite\b/;

/** A one-off view is written straight into the answer: no prototype page, server or browser check comes before it.
 *  `prototype` is what one leaves, where the turn's own work may write a page (`slate-quality.ts`). */
export async function madeNoPrototype(verifier: EvalVerifier, prototype = PROTOTYPE): Promise<void> {
  await verifier.check('built-no-prototype', async () => {
    const steps = (await verifier.turnToolCalls()).filter((call) => prototype.test(call.name) || prototype.test(call.args));

    return { pass: steps.length === 0, evidence: { steps: steps.map((step) => `${step.name}: ${step.args.slice(0, 240)}`) } };
  });
}

/** One of the answer's slates as the chat drew it: the last reading, whether `done` held, and what failed in it. */
export type Reading = { readonly view: SlateView; readonly sight: Sight; readonly held: boolean; readonly errors: readonly string[] };

/**
 * The answer's slates as a fresh chat page draws them from the stored message, once it shows at least `least`: each
 * read until `done` holds for it or the draw budget passes. A frame drawn with an uncaught error or a script that
 * failed to load holds nothing.
 */
export async function readAnswer(browser: WorkspaceBrowser, least: number, names: readonly string[], done: (sight: Sight) => boolean): Promise<Reading[]> {
  const views = await browser.answerSlates(await browser.open(), least);

  return Promise.all(views.map(async (view) => {
    const { sight, held } = await view.until(names, done);
    const faults = await view.faults();
    const errors = [...faults.errors, ...faults.scripts.map((script) => `${script} did not load`)];

    return { view, sight, held: held && errors.length === 0, errors };
  }));
}

/** A reading as a check's evidence. */
export function readingEvidence(reading: Reading): JsonValue {
  return { held: reading.held, errors: [...reading.errors], seen: sightEvidence(reading.sight) };
}

/** A fresh chat page draws one of the answer's slates so that `done` holds, with nothing failing in it. */
export function answerShows(verifier: EvalVerifier, names: readonly string[], done: (sight: Sight) => boolean): Promise<EvalCheckOutcome> {
  return verifier.browse(async (browser) => {
    const readings = await readAnswer(browser, 1, names, done);

    return { pass: readings.some((reading) => reading.held), evidence: readings.map(readingEvidence) };
  });
}
