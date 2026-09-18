/**
 * The Cloudflare door, as a person with no Kinu account reaches it on the
 * deployed build: `/deploy` answers without a session, `/api/deploy/options`
 * parses as the door's own contract, and the authorize handoff carries the
 * PKCE parameters it must.
 *
 * NO SIGN-IN HAPPENS HERE. The row reads the 302 and stops; it never follows
 * it to Cloudflare, never exchanges a code and never spends a scope. What it
 * measures is the shape of the URL a person is sent to — the one part of the
 * flow that a deployment can get wrong silently, because an authorize URL with
 * an empty `client_id` or no `code_challenge_method` looks like a working
 * button and fails on Cloudflare's page.
 *
 * The unconfigured deployment is measured too, and is the expected state until
 * the owner registers the client: the door must say so and refuse the handoff
 * rather than mint a URL with nothing in it.
 */
import { afterAll, describe, test } from 'vitest';
import * as v from 'valibot';
import type { EvalObservation, EvalSubgoal } from '@kinu.run/test-utils';
import {
  CLOUDFLARE_DEPLOY_SCOPES, DeployOptionsSchema, DeployTicketSchema,
} from '@kinu.run/core/deploy';
import { FIRST_RUN_DEFECTS, firstRunCasePlan, publishFirstRunRecord, runFirstRunCase } from './first-run';

const SUITE = 'First-run · deploy-door';

const CASE = 'deploy-door' as const;

const PLAN = firstRunCasePlan(SUITE, CASE);

const liveTest = test.skipIf(PLAN === null);

const observations: EvalObservation[] = [];

afterAll(() => { publishFirstRunRecord(SUITE, PLAN?.llm.model, [CASE], observations); });

/** base64url of a SHA-256 digest: 32 bytes, unpadded. */
const CHALLENGE = /^[A-Za-z0-9_-]{43}$/u;

describe(SUITE, () => {
  liveTest(`MEASURED: ${CASE}`, async () => {
    if (PLAN === null) throw new Error('unreachable: this arm is gated on a resolved plan');
    await runFirstRunCase(PLAN, {
      id: CASE, modelCalls: 'none', genesis: false,
      purpose: 'Disposable deploy-door reachability and authorize-shape probe; no model task.',
      async run({ plan }) {
        const goals: EvalSubgoal[] = [];
        const page = await fetch(`${plan.origin}/deploy`, { redirect: 'manual' });
        const html = await page.text();

        goals.push({
          what: 'door-reachable-without-a-session',
          reached: page.status === 200 && html.includes('<div id="root">'),
          detail: JSON.stringify({ status: page.status, length: html.length }),
        });

        const offered = await fetch(`${plan.origin}/api/deploy/options`);
        const options = v.parse(DeployOptionsSchema, await offered.json());

        goals.push({
          what: 'options-answer-the-door-contract',
          reached: offered.status === 200 && (options.cloudflare
            ? options.clientId !== '' && options.version !== ''
            : options.clientId === '' && options.reason !== ''),
          detail: JSON.stringify({ status: offered.status, ...options }),
        });

        const minted = await fetch(`${plan.origin}/api/deploy/runs`, { method: 'POST' });
        const ticket = v.parse(DeployTicketSchema, await minted.json());

        const handoff = await fetch(
          `${plan.origin}/deploy/authorize?run=${encodeURIComponent(ticket.runId)}`
            + `&key=${encodeURIComponent(ticket.runKey)}`,
          { redirect: 'manual' },
        );

        goals.push(options.cloudflare
          ? authorizeHandoff(handoff, plan.origin, options.clientId)
          : {
            what: 'unconfigured-door-refuses-the-handoff',
            reached: handoff.status === 503 && handoff.headers.get('location') === null,
            detail: JSON.stringify({ status: handoff.status, location: handoff.headers.get('location') }),
          });

        return goals;
      },
      // The three fetches this row makes outside any workspace ledger, plus
      // the run it mints on the door.
      calls: () => 4,
    }, observations);
  });
});

/** The 302's URL, parameter by parameter. Read, never followed. */
function authorizeHandoff(handoff: Response, origin: string, clientId: string): EvalSubgoal {
  const location = handoff.headers.get('location') ?? '';
  const sent = v.safeParse(v.pipe(v.string(), v.url()), location);
  const url = sent.success ? new URL(location) : null;
  const query = url?.searchParams;
  const scopes = (query?.get('scope') ?? '').split(' ');

  const carried = {
    status: handoff.status,
    endpoint: url === null ? '' : `${url.origin}${url.pathname}`,
    responseType: query?.get('response_type') ?? '',
    clientId: query?.get('client_id') ?? '',
    redirectUri: query?.get('redirect_uri') ?? '',
    method: query?.get('code_challenge_method') ?? '',
    challenge: query?.get('code_challenge') ?? '',
    state: query?.get('state') ?? '',
    scopes: scopes.length,
    referrerPolicy: handoff.headers.get('referrer-policy') ?? '',
  };

  return {
    what: 'authorize-url-carries-the-pkce-handoff',
    reached: handoff.status === 302
      && carried.endpoint === 'https://dash.cloudflare.com/oauth2/auth'
      && carried.responseType === 'code'
      && carried.clientId === clientId
      && carried.redirectUri === `${origin}/deploy/callback`
      && carried.method === 'S256'
      && CHALLENGE.test(carried.challenge)
      && carried.state !== ''
      && CLOUDFLARE_DEPLOY_SCOPES.every((scope) => scopes.includes(scope))
      && carried.referrerPolicy === 'no-referrer',
    detail: JSON.stringify(carried),
  };
}

export const DEFECT = FIRST_RUN_DEFECTS[CASE];
