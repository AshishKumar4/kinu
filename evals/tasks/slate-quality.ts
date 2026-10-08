import { PHONE, type SlateView, type WorkspaceBrowser } from '../src/browser';
import { sightEvidence, type Sight } from '../src/sight';
import type { EvalVerifier } from '../src/verifier';
import { madeNoPrototype } from './ephemeral';

// What every slate the owner builds is held to, read as the owner sees it: the real slate drawn in the workspace, in
// the light and the dark theme, and on a phone; built from its own files with nothing broken; and built by the agent
// it was asked of, with no prototype page, server or browser check standing in for it.

/** A slate as its turn asked for it: what it shows once drawn, read by name (`sight.ts`). */
export type DrawnSlate = { readonly id: string; readonly names: readonly string[]; readonly done: (sight: Sight) => boolean };

/** How far the page's background may sit from the workspace's, in light (0 black, 1 white): a dark page on a light
 *  workspace is 0.8 or more apart, one drawn from the theme's own colours a few hundredths. */
const THEME_DISTANCE = 0.3;

/** The share of visible letters drawn at 3:1 or more against what lies under them. */
const READABLE = 0.9;

/** The turn built `slates`, what it was asked to, itself: no helper hired and no swarm, and no prototype standing in
 *  for them (`prototypeSteps`); a preview and a screenshot of the real slate are its check, as the slates skill asks. */
export async function builtItself(verifier: EvalVerifier, slates: readonly string[]): Promise<void> {
  await madeNoPrototype(verifier, slates);

  await verifier.check('hired-no-one', async () => {
    const delegated = (await verifier.turnToolCalls()).filter((call) => call.name === 'agents' && /"op":"(?:hire|swarm)"/u.test(call.args));

    return { pass: delegated.length === 0, evidence: { delegated: delegated.map((call) => call.args.slice(0, 240)) } };
  });
}

/** The slate's latest source built: the workspace shows no broken-build notice over it and nothing failed in its page. */
export async function buildsClean(verifier: EvalVerifier, slate: DrawnSlate): Promise<void> {
  await verifier.check(`${slate.id}-builds-clean`, () => verifier.browse(async (browser) => {
    const view = await browser.workSurface(slate.id);

    await view.until(slate.names, slate.done);
    const [broken, faults] = await Promise.all([view.broken(), view.faults()]);

    return { pass: broken === null && faults.errors.length === 0 && faults.scripts.length === 0, evidence: { broken, faults } };
  }));
}

/** Everything a slate is held to once a turn has built it, besides what its own methods answer; `slates` are every one
 *  the turn was asked for, the slate among them. */
export async function slateQuality(verifier: EvalVerifier, slate: DrawnSlate, slates: readonly string[] = [slate.id]): Promise<void> {
  await builtItself(verifier, slates);
  await buildsClean(verifier, slate);

  await verifier.check(`${slate.id}-follows-the-theme`, () => verifier.browse(async (browser) => {
    const modes = { light: await themed(browser, slate, 'light'), dark: await themed(browser, slate, 'dark') };

    return { pass: Object.values(modes).every((mode) => mode.pass), evidence: modes };
  }));

  await verifier.check(`${slate.id}-fits-a-phone`, () => verifier.browse(async (browser) => {
    const phone = await browser.alone(await browser.workSurface(slate.id), PHONE);
    const { sight, held } = await phone.until(slate.names, slate.done);
    const { overflow } = await phone.appearance();

    return { pass: held && overflow <= 1, evidence: { held, overflow, seen: sightEvidence(sight) } };
  }));
}

/** The slate drawn in the work surface in `mode`: what it shows, against the workspace's background, readably. */
async function themed(browser: WorkspaceBrowser, slate: DrawnSlate, mode: 'light' | 'dark') {
  const view: SlateView = await browser.workSurface(slate.id, mode);
  const { held } = await view.until(slate.names, slate.done);
  const looks = await view.appearance();
  const matches = looks.hostLight !== null && Math.abs(looks.light - looks.hostLight) <= THEME_DISTANCE;

  return { pass: held && matches && looks.letters > 0 && looks.readable >= READABLE, held, ...looks };
}
