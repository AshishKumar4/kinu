import * as v from 'valibot';
import { safeJsonParse, type JsonValue } from '@kinu.run/core';
import type { SlateView, WorkspaceBrowser } from '../src/browser';
import { sightEvidence, type Sight } from '../src/sight';
import type { EvalCheckOutcome, EvalVerifier } from '../src/verifier';

// What every task that expects an ephemeral answer checks the same way: that the chat draws the answer's
// `<slate-ui>` blocks, that no file slate was made for a one-off view, and how each block reads once drawn.

/** The chat ids of the answer's ephemeral slates (`EvalVerifier.answerSlates`); a block whose message has no id has none. */
export function answerIds(verifier: EvalVerifier): string[] {
  return verifier.answerSlates.flatMap((slate) => slate.id === null ? [] : [slate.id]);
}

/**
 * The answer holds at least `least` ephemeral slates, and a fresh chat page draws every one its text holds: a view, not
 * only words. Only this answer's blocks are looked for, by the ids the chat draws them under, so an earlier answer's
 * slates in the same chat never stand in for them.
 */
export async function answersWithSlates(verifier: EvalVerifier, least: number): Promise<void> {
  await verifier.check('answers-with-ephemeral-slates', async () => {
    const blocks = verifier.answerSlates.map((slate) => slate.name);
    const ids = answerIds(verifier);

    if (blocks.length < least || ids.length < blocks.length) return { pass: false, evidence: { blocks, addressed: ids.length, drawn: 0, least } };
    const drawn = (await verifier.browse(async (browser) => browser.answerSlates(await browser.open(), ids))).length;

    return { pass: drawn === blocks.length, evidence: { blocks, addressed: ids.length, drawn, least } };
  });
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

/** A program or command opening a browser on a page: the agent looking at what it built. A call, not a word: a comment
 *  saying "screenshot" looks at nothing (dashboards trial 3, rc22). */
const LOOK = /\bscreenshot\s*\(|--screenshot\b|\b(?:openBrowser|connectBrowser)\s*\(/u;

/** A `web` call's operation. */
const WebOp = v.looseObject({ op: v.string() });

/** Every string in a call's recorded arguments, as the agent wrote it: a program's code reads as code, not JSON. */
function written(args: string): string {
  const strings = (value: JsonValue): string[] => {
    if (typeof value === 'string') return [value];

    return value !== null && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
  };

  return strings(safeJsonParse(args)).join('\n');
}

/** A tool call as a trial recorded it: the tool's name and its arguments as JSON. */
type RecordedCall = { readonly name: string; readonly args: string };

/** The slates a call's code names, and whether it previews each there. */
function namedIn(args: string): { readonly id: string; readonly previews: boolean }[] {
  return [...args.matchAll(NAMED)].map((found) => ({ id: found[1] ?? found[2] ?? '', previews: found[3] !== undefined }));
}

/** Whether a call previews an asked-for slate: by name (`slates.chess.$preview()`), or through a name of its own for
 *  one it names (`const s = workspace.slates.chess; await s.$preview()`, chess trial 3, rc22) previewing no other. */
function previewsAsked(args: string, asked: ReadonlySet<string>): boolean {
  const named = namedIn(args);

  if (named.some(({ id, previews }) => previews && asked.has(id))) return true;

  return /\$preview\s*\(/u.test(args) && named.some(({ id }) => asked.has(id)) && !named.some(({ id, previews }) => previews && !asked.has(id));
}

/**
 * The calls of a turn that stand in for the slates it was asked for, `slates` (none for an answer drawn in the chat):
 * a server of its own; a page written outside `/slates/<id>/` of an asked-for slate; a preview of any other slate; and a
 * browser on a page before any asked-for slate was previewed, in this turn or one `before` it, so not on the real one.
 * Checking the real slate as it renders, its `$preview()` and a screenshot of the URL that answers, is what the slates
 * skill asks for, and passes; the preview stays up for the turns after (chess trial 4, dashboards 1-3, rc22).
 */
export function prototypeSteps(calls: readonly RecordedCall[], slates: readonly string[], before: readonly RecordedCall[] = []): string[] {
  const asked = new Set(slates);
  const executes = (name: string) => ['eval', 'shell', 'file', 'web'].includes(name);
  let previewed = before.some(({ name, args }) => executes(name) && previewsAsked(written(args), asked));

  return calls.flatMap(({ name, args: recorded }) => {
    // Plans, memories and reports describe work; only these tools execute a page, write one, or look at one.
    if (!executes(name)) return [];
    const args = written(recorded);
    const named = namedIn(args);
    const pages = [...args.matchAll(PAGE)].map(([path]) => path).filter((path) => ![...asked].some((id) => path.includes(`/slates/${id}/`)));
    const others = named.filter(({ id, previews }) => previews && !asked.has(id));
    const bare = /\$preview\s*\(/u.test(args) && !named.some(({ previews }) => previews) && !named.some(({ id }) => asked.has(id));

    previewed ||= previewsAsked(args, asked);
    const web = v.safeParse(WebOp, safeJsonParse(recorded));
    const looked = (name === 'web' ? web.success && web.output.op === 'screenshot' : LOOK.test(args)) && !previewed;

    return SERVER.test(args) || pages.length > 0 || others.length > 0 || bare || looked ? [`${name}: ${recorded.slice(0, 240)}`] : [];
  });
}

/** No prototype stood in for what the turn was asked to build: `slates`, or none for an answer drawn in the chat. */
export async function madeNoPrototype(verifier: EvalVerifier, slates: readonly string[] = []): Promise<void> {
  await verifier.check('built-no-prototype', async () => {
    const [calls, before] = await Promise.all([verifier.turnToolCalls(), verifier.earlierToolCalls()]);
    const steps = prototypeSteps(calls, slates, before);

    return { pass: steps.length === 0, evidence: { steps, slates: [...slates] } };
  });
}

/** One of the answer's slates as the chat drew it: the reading, whether `done` held of it, and what failed in it. */
export type Reading = { readonly view: SlateView; readonly sight: Sight; readonly held: boolean; readonly errors: readonly string[] };

/**
 * The answer's slates `ids` (`answerIds`) as a fresh chat page draws them from the stored message: each read once it
 * has drawn (`SlateView.drawn`), and judged by `done` at once. A frame drawn with an uncaught error or a script that
 * failed to load holds nothing.
 */
export async function readAnswer(browser: WorkspaceBrowser, ids: readonly string[], names: readonly string[], done: (sight: Sight) => boolean): Promise<Reading[]> {
  const views = await browser.answerSlates(await browser.open(), ids);

  return Promise.all(views.map(async (view) => {
    const sight = await view.drawn(names);
    const held = done(sight);
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
    const readings = await readAnswer(browser, answerIds(verifier), names, done);

    return { pass: readings.some((reading) => reading.held), evidence: readings.map(readingEvidence) };
  });
}
