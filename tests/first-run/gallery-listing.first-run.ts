/**
 * A live share listed in the Gallery from its owner's share sheet. The owner lists it with a line and a category; the
 * Gallery's public index finds it by its line, its own page names the connections a visitor's parts would ask for, and
 * its revoke takes it off. No model.
 */
import { afterAll, describe, test } from 'vitest';
import * as v from 'valibot';
import type { EvalObservation, EvalSubgoal } from '@kinu.run/test-utils';
import {
  galleryPath, GalleryPageSchema, GallerySlateSchema, gallerySlatePath, LIVE_SHARE_LISTING_PATH, LiveShareCreatedSchema, LiveShareRecordSchema,
  type GalleryListing, type LiveShareRecord, type RoomService,
} from '@kinu.run/core';
import { firstRunCaseId, firstRunCasePlan, type FirstRunDefect, publishFirstRunRecord, runFirstRunCase } from './first-run';
import { webHeaders } from '../../evals/src/workspace-roster';

const SUITE = 'First-run · gallery-listing';

const CASE = firstRunCaseId(import.meta.url);

/** What this case found, and what a red here means (`FirstRunDefect`). */
const DEFECT: FirstRunDefect = {
  found: 'Nothing listed a live share in the Gallery once rooms were gone: the Gallery\'s index had no writer, so no deployed slate could be found there.',
  missedBecause: 'The index and its pages were proved over rows a test wrote straight into the control plane; no proof listed a share through the owner\'s own route and read it back off the public index.',
  provedRedAt: null,
  redDirection: 'RED on every deployment before the listing route: POST /api/shared/live/listing answers 404 and the Gallery never shows the line. '
    + 'Green requires the share to answer as listed, the public index to find it by its line with the share\'s own address, its page to name the MCP server its slate reaches, and its revoke to take it off the index.',
};

const PLAN = firstRunCasePlan(SUITE, 'gallery');

const liveTest = test.skipIf(PLAN === null);

const observations: EvalObservation[] = [];

afterAll(async () => { await publishFirstRunRecord(SUITE, PLAN?.llm.model, [CASE], observations); });

const Answered = v.object({ ok: v.literal(true), value: v.unknown() });

const Exec = v.object({ stdout: v.optional(v.string()), exitCode: v.optional(v.number()), error: v.optional(v.string()) });

const SLATE = 'gallerylisted';

/** The public index's listing whose line is `line`, if it holds one: the owner's listing and revoke each answer once the
 *  Gallery has been told, so one read says. */
async function indexed(origin: string, line: string): Promise<GalleryListing | null> {
  const page = await fetch(`${origin}${galleryPath({ q: line, sort: 'new', category: null, page: 0 })}`);

  return page.ok ? v.parse(GalleryPageSchema, await page.json()).listings.find((each) => each.line === line) ?? null : null;
}

/** Its owner lists `share` in the Gallery with `line`, as their share sheet does: the share as it answers after. */
async function listShare(input: { origin: string; headers: Readonly<Record<string, string>>; workspace: string; share: string; line: string }): Promise<LiveShareRecord | null> {
  const listing = await fetch(`${input.origin}${LIVE_SHARE_LISTING_PATH}`, {
    method: 'POST', headers: { ...input.headers, 'content-type': 'application/json' },
    body: JSON.stringify({ workspace: input.workspace, share: input.share, listed: true, line: input.line, category: 'developer' }),
  });

  const listed = listing.ok ? v.safeParse(LiveShareRecordSchema, await listing.json()) : null;

  return listed?.success === true ? listed.output : null;
}

/** What a listed slate's own page names a visitor's parts would ask them to connect; none when it cannot be read. */
async function pageNeeds(origin: string, workspace: string): Promise<{ readonly status: number; readonly needs: readonly RoomService[] }> {
  const page = await fetch(`${origin}${gallerySlatePath(workspace, SLATE)}`);
  const read = page.ok ? v.safeParse(GallerySlateSchema, await page.json()) : null;

  return { status: page.status, needs: read?.success === true ? read.output.needs ?? [] : [] };
}

describe(SUITE, () => {
  liveTest(`MEASURED: ${CASE}`, async () => {
    if (PLAN === null) throw new Error('unreachable: this arm is gated on a resolved plan');
    await runFirstRunCase(PLAN, {
      id: CASE, defect: DEFECT, modelCalls: 'none', budgetMs: 5 * 60_000, genesis: false,
      purpose: 'Disposable live share listed in the Gallery and taken off it; no model task.',
      async run({ session, plan }) {
        const goals: EvalSubgoal[] = [];
        const server = `eval-gallery-${crypto.randomUUID().slice(0, 8)}`;
        const line = `First-run listing ${crypto.randomUUID()}`;

        const setup = v.parse(Exec, await session.execute('workspace', `mkdir -p /slates/${SLATE}
cat > /slates/${SLATE}/package.json <<'END'
{"main":"server.ts","slate":{"title":"Gallery listing probe"}}
END
cat > /slates/${SLATE}/server.ts <<'END'
import { SlateObject } from "kinu:slate";
export class Slate extends SlateObject {
  async look() { return await this.env.workspace.mcp["${server}"].search({ query: "anything" }); }
  async fetch() { return new Response("gallery-listing-probe-ok"); }
}
END`));

        if ((setup.exitCode ?? 1) !== 0) throw new Error('Could not author the probe slate: ' + (setup.error ?? setup.stdout ?? ''));

        // What the slate reaches is what its owner's calls recorded: the MCP call is refused here, and recorded all the same.
        await session.slateOp({ op: 'call', id: SLATE, method: 'look', args: [] });
        const shared = v.safeParse(Answered, await session.slateOp({ op: 'share', id: SLATE, visibility: 'public', approved: [] }));
        const created = shared.success ? v.safeParse(LiveShareCreatedSchema, shared.output.value) : null;
        const share = created?.success === true ? created.output.share : null;
        const url = created?.success === true ? created.output.url : null;

        const listed = await listShare({ origin: plan.origin, headers: webHeaders(plan.identity), workspace: session.workspace, share: share?.id ?? '', line });
        const found = await indexed(plan.origin, line);
        const page = await pageNeeds(plan.origin, session.workspace);

        await session.slateOp({ op: 'unshare', share: share?.id ?? '' });
        const after = await indexed(plan.origin, line);

        goals.push({
          what: 'share-answers-as-listed',
          reached: listed?.gallery?.line === line,
          detail: JSON.stringify(listed?.gallery ?? null),
        });
        goals.push({
          what: 'public-index-finds-it-by-its-line',
          reached: found !== null && found.share === share?.id && found.url === url && found.category === 'developer',
          detail: JSON.stringify(found),
        });
        goals.push({
          what: 'its-page-names-what-a-visitor-connects',
          reached: page.needs.some((each) => each.kind === 'mcp' && each.title === server),
          detail: JSON.stringify(page),
        });
        goals.push({ what: 'revoke-takes-it-off', reached: found !== null && after === null, detail: JSON.stringify(after) });

        return goals;
      },
    }, observations);
  });
});
