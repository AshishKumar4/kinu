/**
 * A second account's personal part inside an owner's live share (docs/SLATE-SHARING-NIMBUS.md §3): the named viewer
 * opens the share's app page signed in, the shared slate frames its part, and Kinu draws the part sealed, with none of
 * its author's script or image. Its Again control runs it again as that viewer. No model and no connections: the
 * part's answer is the slate's own.
 */
import { afterAll, describe, test } from 'vitest';
import * as v from 'valibot';
import type { Frame, Page } from 'puppeteer';
import type { EvalObservation, EvalSubgoal } from '@kinu.run/test-utils';
import { LiveShareCreatedSchema, liveSharePagePath, slatePartFramePath } from '@kinu.run/core';
import { firstRunCaseId, firstRunCasePlan, type FirstRunDefect, publishFirstRunRecord, runFirstRunCase } from './first-run';
import { openBrowser, signedInPage } from '../../evals/src/browser';
import { webHeaders, type PublicWebIdentity } from '../../evals/src/workspace-roster';
import type { KinuPublicSession, PublicSessionPlan } from '../../evals/src/session';

const SUITE = 'First-run · slate-parts-viewer';

const CASE = firstRunCaseId(import.meta.url);

const DEFECT: FirstRunDefect = {
  found: 'A personal part proved in its owner\'s preview says nothing about a second account opening the live share: '
    + 'the share\'s app page must host the part and run it as its signed-in viewer.',
  missedBecause: 'The deployed parts row walks only the owner\'s workspace preview, and the named-share row enters '
    + 'with HTTP requests rather than a signed-in browser hosting a personal part.',
  provedRedAt: null,
  redDirection: 'The viewer direction is unmeasured on a deployed sharing build; staging does not carry sharing yet. '
    + 'Green requires a users share on each viewer\'s own access, the second account opening its app page as itself, '
    + 'and the part inside the shared slate drawing its own words in Kinu\'s sealed frame with no author script or '
    + 'image, then drawing again when that viewer presses Again.',
};

const PLAN = firstRunCasePlan(SUITE, 'viewer');

const liveTest = test.skipIf(PLAN === null);

const observations: EvalObservation[] = [];

afterAll(async () => { await publishFirstRunRecord(SUITE, PLAN?.llm.model, [CASE], observations); });

const SLATE = 'viewerparts';

const Exec = v.object({ stdout: v.optional(v.string()), exitCode: v.optional(v.number()), error: v.optional(v.string()) });

const Profile = v.object({ email: v.string() });

const PreviewAnswer = v.object({ ok: v.literal(true), value: v.object({ url: v.string(), broken: v.optional(v.string()) }) });

/** The shared page frames the app's part; its function tries to return script and an image beside its own words. */
function slateFiles(partPath: string): string {
  return `mkdir -p /slates/${SLATE}
cat > /slates/${SLATE}/package.json <<'END'
{"main":"server.ts","browser":"page.tsx","slate":{"title":"Viewer parts probe","parts":{"mine":{"fn":"mine"}}}}
END
cat > /slates/${SLATE}/server.ts <<'END'
import { SlateObject } from "kinu:slate";
export class Slate extends SlateObject {
  async mine(pressed) {
    const again = pressed?.id === "again" ? '<p>drawn again</p>' : '';
    return {
      html: '<p data-drawn>drawn for you</p>' + again + '<script>steal()</script><img src="https://example.com/x.png">',
      actions: [{ id: "again", label: "Again" }],
    };
  }
}
END
cat > /slates/${SLATE}/page.tsx <<'END'
import { useHostContext } from "kinu:slate";
const PART = ${JSON.stringify(partPath)};
export default function App() {
  const { origin } = useHostContext();
  return <iframe title="My part" src={origin + PART} style={{ border: 0, width: "100%", height: 260 }} />;
}
END`;
}

async function authoredSlate(session: KinuPublicSession, partPath: string): Promise<string | null> {
  const setup = v.parse(Exec, await session.execute('workspace', slateFiles(partPath)));

  if ((setup.exitCode ?? 1) !== 0) throw new Error('Could not author the viewer parts slate: ' + (setup.error ?? setup.stdout ?? ''));
  const answered = await session.slateOp({ op: 'preview', id: SLATE });
  const preview = v.safeParse(PreviewAnswer, answered);

  return preview.success ? preview.output.value.broken ?? null : JSON.stringify(answered);
}

async function accountEmail(origin: string, identity: PublicWebIdentity): Promise<string> {
  const response = await fetch(`${origin}/api/user/profile`, { headers: webHeaders(identity) });

  if (!response.ok) throw new Error(`The account profile answered ${String(response.status)}`);

  return v.parse(Profile, await response.json()).email.trim().toLowerCase();
}

interface ViewerSeen {
  opened: boolean;
  email: string | null;
  nested: boolean;
  drawn: { readonly sandbox: string | null; readonly text: string; readonly scripts: number; readonly images: number } | null;
  again: boolean;
  stopped: string;
}

/** Read the sealed document once its own words have loaded, not merely once its outer frame exists. */
async function sealedDrawing(part: Frame, budget: AbortSignal): Promise<NonNullable<ViewerSeen['drawn']>> {
  const content = await part.waitForSelector('[data-part-content]', { signal: budget });
  const sandbox = await content?.evaluate((node) => node.getAttribute('sandbox')) ?? null;
  const sealed = await content?.contentFrame();

  if (sealed === null || sealed === undefined) throw new Error('The part has no sealed content frame');
  await sealed.waitForFunction(() => document.body.textContent?.includes('drawn for you') === true, { signal: budget });

  const inside = await sealed.evaluate(() => ({
    text: document.body.textContent ?? '',
    scripts: document.querySelectorAll('script').length,
    images: document.querySelectorAll('img').length,
  }));

  return { sandbox, ...inside };
}

/** Only a part inside this share's host counts; an owner's workspace preview cannot satisfy it. */
async function walkViewerPart(page: Page, at: { host: Frame; partUrl: string }, budget: AbortSignal, seen: ViewerSeen): Promise<void> {
  seen.stopped = 'the shared slate framed no part';

  const part = await page.waitForFrame((frame) => frame.parentFrame() === at.host
    && (frame.url() === at.partUrl || frame.url().startsWith('chrome-error:')), { signal: budget });

  if (part.url().startsWith('chrome-error:')) {
    seen.stopped = 'the browser refused the part frame inside the shared slate';

    return;
  }

  seen.nested = at.host.parentFrame() === page.mainFrame();
  seen.stopped = 'the viewer\'s part never answered';

  const state = await part.waitForSelector('[data-part-frame], [role="alert"]', { signal: budget });
  const said = await state?.evaluate((node) => node.getAttribute('data-part-frame') ?? `failed: ${node.textContent ?? ''}`) ?? 'nothing';

  if (said !== 'shown') {
    seen.stopped = `the viewer's part answered ${said}`;

    return;
  }

  seen.stopped = 'the part\'s words never loaded in its sealed frame';
  seen.drawn = await sealedDrawing(part, budget);
  seen.stopped = 'Again never drew the viewer\'s part again';
  await part.click('[data-part-action="again"]');
  await part.waitForFunction(() => document.querySelector('[data-part-content]')?.getAttribute('srcdoc')?.includes('drawn again') === true, { signal: budget });
  seen.again = true;
  seen.stopped = '';
}

/** A browser signed in only as the second account, closed even when the case spends its budget on a missing step. */
async function viewersWalk(plan: PublicSessionPlan, identity: PublicWebIdentity, at: { page: string; part: string }, budget: AbortSignal): Promise<ViewerSeen> {
  const chrome = await openBrowser();
  const seen: ViewerSeen = { opened: false, email: null, nested: false, drawn: null, again: false, stopped: 'the second account never opened the share' };

  try {
    const page = await signedInPage(chrome.browser, { origin: plan.origin, identity });

    await page.goto(at.page, { waitUntil: 'domcontentloaded' });
    seen.email = v.parse(Profile, await page.evaluate(async () => (await fetch('/api/user/profile')).json())).email.trim().toLowerCase();

    const shared = await page.waitForSelector(`[data-shared-slate="${SLATE}"]`, { signal: budget });
    const host = await shared?.contentFrame();

    seen.opened = page.url() === at.page && host !== null && host !== undefined;

    if (host !== null && host !== undefined) await walkViewerPart(page, { host, partUrl: at.part }, budget, seen);

    return seen;
  } catch (cause) {
    if (!budget.aborted) throw cause;

    return seen;
  } finally {
    await chrome.close();
  }
}

function viewerGoals(seen: ViewerSeen, ownerEmail: string, secondEmail: string): EvalSubgoal[] {
  const { drawn } = seen;
  const detail = drawn === null ? seen.stopped : JSON.stringify(drawn);

  return [
    {
      what: 'second-account-opens-the-share', reached: seen.opened && seen.email === secondEmail && secondEmail !== ownerEmail,
      detail: JSON.stringify({ opened: seen.opened, email: seen.email, ownerEmail, secondEmail, stopped: seen.stopped }),
    },
    { what: 'viewer-part-draws-sealed', reached: seen.nested && drawn !== null && drawn.sandbox === '', detail },
    { what: 'part-shows-its-own-words', reached: drawn !== null && drawn.text.includes('drawn for you'), detail },
    { what: 'none-of-its-script-or-images-reach-the-viewer', reached: drawn !== null && drawn.scripts === 0 && drawn.images === 0, detail },
    { what: 'its-own-control-runs-it-again', reached: seen.again, detail: seen.again ? 'drawn again' : seen.stopped },
  ];
}

describe(SUITE, () => {
  liveTest(`MEASURED: ${CASE}`, async () => {
    if (PLAN === null) throw new Error('unreachable: this arm is gated on a resolved plan');
    await runFirstRunCase(PLAN, {
      id: CASE, defect: DEFECT, modelCalls: 'none', budgetMs: 5 * 60_000, genesis: false,
      purpose: 'Disposable users share whose personal part is walked by a second account in signed-in Chrome; no model task.',
      async run({ session, plan, budget }) {
        const identity: PublicWebIdentity = { ...plan.identity, account: 'devices' };
        const owner = webHeaders(plan.identity);
        const [ownerEmail, secondEmail] = await Promise.all([accountEmail(plan.origin, plan.identity), accountEmail(plan.origin, identity)]);
        const partPath = slatePartFramePath(session.workspace, SLATE, 'mine', []);
        const broken = await authoredSlate(session, partPath);
        const goals: EvalSubgoal[] = [{ what: 'the-slate-builds-with-its-part', reached: broken === null, detail: broken ?? 'builds' }];

        if (broken !== null) return goals;

        const made = await fetch(`${plan.origin}/api/shared/live`, {
          method: 'POST', headers: { ...owner, 'content-type': 'application/json' },
          body: JSON.stringify({ workspace: session.workspace, slate: SLATE, visibility: 'users', emails: [secondEmail] }),
        });

        const created = v.safeParse(LiveShareCreatedSchema, await made.json());

        if (!created.success) throw new Error(`The viewer's users share was not made: ${String(made.status)}`);

        const { share } = created.output;

        try {
          goals.push({
            what: 'named-share-uses-viewers-own-access', reached: share.mode === 'own' && share.users.includes(secondEmail),
            detail: JSON.stringify({ mode: share.mode, users: share.users }),
          });

          const seen = await viewersWalk(plan, identity, {
            page: `${plan.origin}${liveSharePagePath(session.workspace, share.id)}`, part: new URL(partPath, plan.origin).href,
          }, budget);

          goals.push(...viewerGoals(seen, ownerEmail, secondEmail));
        } finally {
          await fetch(`${plan.origin}/api/shared/revoke`, {
            method: 'POST', headers: { ...owner, 'content-type': 'application/json' },
            body: JSON.stringify({ workspace: session.workspace, share: share.id }),
          });
        }

        return goals;
      },
    }, observations);
  });
});
