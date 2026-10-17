/**
 * A slate's personal part, run as its owner in their own preview of it on the deployed product
 * (docs/SLATE-SHARING-NIMBUS.md §3): the slate's page frames the app's part frame, the part draws there in Kinu's sealed
 * frame with none of its author's script or images, its own control runs it again with the press, and what it proposes
 * to show everyone reaches the slate's server only once its viewer confirms it in the app page at the top. No model and
 * no connections: the part's answer is the slate's own.
 */
import { afterAll, describe, test } from 'vitest';
import * as v from 'valibot';
import type { Frame, Page } from 'puppeteer';
import type { EvalObservation, EvalSubgoal } from '@kinu.run/test-utils';
import { safeJsonParse, slatePartFramePath } from '@kinu.run/core';
import { firstRunCaseId, firstRunCasePlan, type FirstRunDefect, publishFirstRunRecord, runFirstRunCase } from './first-run';
import { openBrowser, signedInPage } from '../../evals/src/browser';
import { webHeaders, type PublicWebIdentity } from '../../evals/src/workspace-roster';
import type { KinuPublicSession, PublicSessionPlan } from '../../evals/src/session';

const SUITE = 'First-run · slate-parts';

const CASE = firstRunCaseId(import.meta.url);

const DEFECT: FirstRunDefect = {
  found: 'A slate\'s personal parts never drew for their viewer: the part frame named only preview hosts as its ancestors, '
    + 'so the browser refused it under the app page at the top, and a slate previewed in an answer hosted no parts at all.',
  missedBecause: 'Every proof of a part ran its frame in the gallery, where the app page, the slate\'s page and the part frame '
    + 'share one origin and no header is served, or called the part routes with no browser; none framed a part from a '
    + 'deployed preview host under the deployed app.',
  provedRedAt: null,
  redDirection: 'RED on any build without personal parts: its package.json reader refuses `slate.parts` ("Invalid key"), so '
    + 'the slate never builds, as staging answered on 2026-10-17. RED on c4015d141, whose part frame the browser refuses '
    + 'under the app page. Green requires the slate to build with its part, the part '
    + 'to draw in its sealed frame with its own words and none of its script or image, its Again control to run it again '
    + 'with that press, and Show to everyone, confirmed at the top, to reach the slate\'s server as exactly its value, from '
    + 'the signed-in account.',
};

const PLAN = firstRunCasePlan(SUITE, 'parts');

const liveTest = test.skipIf(PLAN === null);

const observations: EvalObservation[] = [];

afterAll(async () => { await publishFirstRunRecord(SUITE, PLAN?.llm.model, [CASE], observations); });

const SLATE = 'parts';

const Exec = v.object({ stdout: v.optional(v.string()), exitCode: v.optional(v.number()), error: v.optional(v.string()) });

const Answered = v.object({ ok: v.literal(true), value: v.unknown() });

const Profile = v.object({ email: v.string() });

const Board = v.object({ value: v.string(), by: v.string() });

const Preview = v.object({ url: v.string(), broken: v.optional(v.string()) });

/**
 * The slate: a part whose markup carries a script and an image Kinu must cut, a control that runs it again, and a note
 * it proposes to show everyone, which its server keeps with who showed it. Its page frames the part where its host says
 * the app is.
 */
function slateFiles(workspace: string): string {
  const part = slatePartFramePath(workspace, SLATE, 'mine', []);

  return `mkdir -p /slates/${SLATE}
cat > /slates/${SLATE}/package.json <<'END'
{"main":"server.ts","browser":"page.tsx","slate":{"title":"Parts probe","parts":{"mine":{"fn":"mine","show":"showed"}}}}
END
cat > /slates/${SLATE}/server.ts <<'END'
import { SlateObject } from "kinu:slate";
export class Slate extends SlateObject {
  async mine(pressed) {
    const again = pressed?.id === "again" ? '<p>drawn again</p>' : '';
    return {
      html: '<p data-drawn>drawn for you</p>' + again + '<script>steal()</script><img src="https://example.com/x.png">',
      actions: [{ id: "again", label: "Again" }],
      show: { label: "My note", value: "note-42" },
    };
  }
  async showed(value, from) { await this.storage.put("board", { value, by: from.email }); }
  async board() { return (await this.storage.get("board")) ?? null; }
}
END
cat > /slates/${SLATE}/page.tsx <<'END'
import { useHostContext } from "kinu:slate";
const PART = ${JSON.stringify(part)};
export default function App() {
  const { origin } = useHostContext();
  return <iframe title="My part" src={origin + PART} style={{ border: 0, width: "100%", height: 260 }} />;
}
END`;
}

/** What the owner's preview showed of the part, step by step; `stopped` names the step it never got past. */
interface PartSeen {
  readonly drawn: { readonly sandbox: string | null; readonly text: string; readonly scripts: number; readonly images: number } | null;
  readonly again: boolean;
  readonly payload: string | null;
  readonly confirmed: boolean;
  readonly stopped: string;
}

/** `wait`, handed the case's budget to end on: null once the budget is spent, the step recorded as never reached. */
async function untilBudget<T>(budget: AbortSignal, wait: (signal: AbortSignal) => Promise<T>): Promise<T | null> {
  try {
    return await wait(budget);
  } catch (cause) {
    if (budget.aborted) return null;
    throw cause;
  }
}

/** The part's sealed frame as its viewer's browser drew it: its words, and any script or image left in it. */
async function sealedPart(part: Frame): Promise<NonNullable<PartSeen['drawn']>> {
  const content = await part.waitForSelector('[data-part-content]');
  const sandbox = await content?.evaluate((node) => node.getAttribute('sandbox')) ?? null;
  const sealed = await content?.contentFrame();

  const inside = await sealed?.evaluate(() => ({
    text: document.body.textContent,
    scripts: document.querySelectorAll('script').length,
    images: document.querySelectorAll('img').length,
  }));

  return { sandbox, text: inside?.text ?? '', scripts: inside?.scripts ?? 0, images: inside?.images ?? 0 };
}

/**
 * The part's frame inside the slate's page, or the error page the browser put in its place when it refused to load it
 * there: a frame two below the app page.
 */
function partFrameOf(page: Page, partPath: string): (frame: Frame) => boolean {
  return (frame) => (URL.canParse(frame.url()) && new URL(frame.url()).pathname === partPath)
    || (frame.url().startsWith('chrome-error:') && frame.parentFrame()?.parentFrame() === page.mainFrame());
}

const NOT_YET = { drawn: null, again: false, payload: null, confirmed: false } as const;

/** The owner opens the slate in their workspace and walks its part: drawn, run again, and its note shown to everyone. */
async function walkPart(page: Page, origin: string, workspace: string, budget: AbortSignal): Promise<PartSeen> {
  await page.goto(`${origin}/workspace/${encodeURIComponent(workspace)}?slate=${SLATE}`, { waitUntil: 'domcontentloaded' });

  const part = await untilBudget(budget, (signal) => page.waitForFrame(partFrameOf(page, new URL(slatePartFramePath(workspace, SLATE, 'mine', []), origin).pathname), { signal }));

  if (part === null) return { ...NOT_YET, stopped: 'the slate\'s page framed no part' };

  if (part.url().startsWith('chrome-error:')) return { ...NOT_YET, stopped: 'the browser refused the part frame inside the slate\'s page' };
  const state = await untilBudget(budget, (signal) => part.waitForSelector('[data-part-frame], [role="alert"]', { signal }));
  const said = await state?.evaluate((node) => node.getAttribute('data-part-frame') ?? `failed: ${node.textContent ?? ''}`) ?? 'nothing';

  if (said !== 'shown') return { ...NOT_YET, stopped: `the part answered ${said}` };
  const drawn = await sealedPart(part);

  await part.click('[data-part-action="again"]');
  const again = await untilBudget(budget, (signal) => part.waitForFunction(() => document.querySelector('[data-part-content]')?.getAttribute('srcdoc')?.includes('drawn again') === true, { signal })) !== null;

  if (!again) return { ...NOT_YET, drawn, stopped: 'Again never drew the part again' };

  await part.click('[data-part-show]');
  const confirm = await untilBudget(budget, (signal) => page.waitForSelector('[data-show-confirm]', { signal }));

  if (confirm === null) return { ...NOT_YET, drawn, again, stopped: 'Show to everyone opened no decision at the top' };
  const payload = await page.$eval('[data-show-payload]', (node) => node.textContent);

  await confirm.click();
  const confirmed = await untilBudget(budget, (signal) => page.waitForFunction(() => document.querySelector('[data-show-confirm]') === null, { signal })) !== null;

  return { drawn, again, payload, confirmed, stopped: confirmed ? '' : 'the decision never closed once confirmed' };
}

/** Why the slate's own files do not build, its part with them; null when they do. */
async function brokenSlate(session: KinuPublicSession): Promise<string | null> {
  const answered = await session.slateOp({ op: 'preview', id: SLATE });
  const preview = v.safeParse(Answered, answered);
  const shown = preview.success ? v.safeParse(Preview, preview.output.value) : null;

  return shown?.success === true ? shown.output.broken ?? null : JSON.stringify(answered);
}

/** The walk in a signed-in Chrome of its own, closed after. */
async function ownersWalk(plan: PublicSessionPlan, workspace: string, budget: AbortSignal): Promise<PartSeen> {
  const chrome = await openBrowser();

  try {
    return await walkPart(await signedInPage(chrome.browser, plan), plan.origin, workspace, budget);
  } finally {
    await chrome.close();
  }
}

async function accountEmail(origin: string, identity: PublicWebIdentity): Promise<string> {
  return v.parse(Profile, await (await fetch(`${origin}/api/user/profile`, { headers: webHeaders(identity) })).json()).email;
}

describe(SUITE, () => {
  liveTest(`MEASURED: ${CASE}`, async () => {
    if (PLAN === null) throw new Error('unreachable: this arm is gated on a resolved plan');
    await runFirstRunCase(PLAN, {
      id: CASE, defect: DEFECT, modelCalls: 'none', budgetMs: 5 * 60_000, genesis: false,
      purpose: 'Disposable slate with one personal part, walked in its owner\'s preview; no model task.',
      async run({ session, plan, budget }) {
        const setup = v.parse(Exec, await session.execute('workspace', slateFiles(session.workspace)));

        if ((setup.exitCode ?? 1) !== 0) throw new Error('Could not author the parts slate: ' + (setup.error ?? setup.stdout ?? ''));

        const email = await accountEmail(plan.origin, plan.identity);
        // A build that cannot read the part's declaration has no page to walk: it says why at once.
        const broken = await brokenSlate(session);
        const seen = broken === null ? await ownersWalk(plan, session.workspace, budget) : { ...NOT_YET, stopped: `the slate does not build: ${broken}` };
        const answered = await session.slateOp({ op: 'call', id: SLATE, method: 'board', args: [] });
        const called = v.safeParse(Answered, answered);
        const board = called.success ? v.safeParse(Board, called.output.value) : null;
        const { drawn } = seen;

        const goals: EvalSubgoal[] = [
          { what: 'the-slate-builds-with-its-part', reached: broken === null, detail: broken ?? 'builds' },
          {
            what: 'the-part-draws-sealed-in-the-slates-page',
            reached: drawn !== null && drawn.sandbox === '' && drawn.text.includes('drawn for you'),
            detail: drawn === null ? seen.stopped : JSON.stringify(drawn),
          },
          {
            what: 'none-of-its-script-or-images-reach-the-viewer',
            reached: drawn !== null && drawn.scripts === 0 && drawn.images === 0,
            detail: drawn === null ? seen.stopped : JSON.stringify(drawn),
          },
          { what: 'its-own-control-runs-it-again', reached: seen.again, detail: seen.again ? 'drawn again' : seen.stopped },
          {
            what: 'show-to-everyone-confirms-exactly-its-value-at-the-top',
            reached: seen.confirmed && safeJsonParse(seen.payload ?? '') === 'note-42',
            detail: seen.confirmed ? String(seen.payload) : seen.stopped,
          },
          {
            what: 'the-slates-server-receives-it-from-its-viewer',
            reached: board?.success === true && board.output.value === 'note-42' && board.output.by === email,
            detail: JSON.stringify(answered),
          },
        ];

        return goals;
      },
    }, observations);
  });
});
