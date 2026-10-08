import { safeJsonParse, slateUiSegments, type JsonValue } from '@kinu.run/core';
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

/** A server of its own: no slate needs one, so one stands in for a page. */
const SERVER = /http\.server|npx (?:serve|http-server)|\bvite\b/u;

/** A page file, by its path. */
const PAGE = /[\w./-]*\.html?\b/gu;

/** A slate the code names, `slates.<id>` or `slates["<id>"]`, and whether the code previews it there. */
const NAMED = /slates(?:\.([A-Za-z_$][\w$]*)|\[\s*["'`]([^"'`]+)["'`]\s*\])(\s*\.\s*\$preview\s*\()?/gu;

/** A browser on a page: the agent looking at what it built. */
const LOOK = /\bscreenshot\b|openBrowser|connectBrowser/u;

/** Every string in a call's recorded arguments, as the agent wrote it: a program's code reads as code, not JSON. */
function written(args: string): string {
  const strings = (value: JsonValue): string[] => {
    if (typeof value === 'string') return [value];

    return value !== null && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
  };

  return strings(safeJsonParse(args)).join('\n');
}

/**
 * The calls of a turn that stand in for the slates it was asked for, `slates` (none for an answer drawn in the chat):
 * a server of its own; a page written outside `/slates/<id>/` of an asked-for slate; a preview of any other slate; and a
 * browser on a page before any asked-for slate was previewed, so not on the real one. Checking the real slate as it
 * renders, its `$preview()` and a screenshot of the URL that answers, is what the slates skill asks for, and passes.
 */
export function prototypeSteps(calls: readonly { readonly name: string; readonly args: string }[], slates: readonly string[]): string[] {
  const asked = new Set(slates);
  let previewed = false;

  return calls.flatMap(({ name, args: recorded }) => {
    const args = written(recorded);
    const named = [...args.matchAll(NAMED)].map((found) => ({ id: found[1] ?? found[2] ?? '', previews: found[3] !== undefined }));
    const pages = [...args.matchAll(PAGE)].map(([path]) => path).filter((path) => ![...asked].some((id) => path.includes(`/slates/${id}/`)));
    const others = named.filter(({ id, previews }) => previews && !asked.has(id));
    const bare = /\$preview\s*\(/u.test(args) && !named.some(({ previews }) => previews) && !named.some(({ id }) => asked.has(id));

    previewed ||= named.some(({ id, previews }) => previews && asked.has(id));
    const looked = (LOOK.test(name) || LOOK.test(args)) && !previewed;

    return SERVER.test(args) || pages.length > 0 || others.length > 0 || bare || looked ? [`${name}: ${recorded.slice(0, 240)}`] : [];
  });
}

/** No prototype stood in for what the turn was asked to build: `slates`, or none for an answer drawn in the chat. */
export async function madeNoPrototype(verifier: EvalVerifier, slates: readonly string[] = []): Promise<void> {
  await verifier.check('built-no-prototype', async () => {
    const steps = prototypeSteps(await verifier.turnToolCalls(), slates);

    return { pass: steps.length === 0, evidence: { steps, slates: [...slates] } };
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
