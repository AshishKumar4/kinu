/**
 * The Cloudflare door, as a person with no Kinu account reaches it on the
 * deployed build: `/deploy` answers without a session, `/api/deploy/options`
 * parses as the door's own contract, and the authorize handoff carries the
 * PKCE parameters it must — with the key in a header and the leg bound to this
 * caller by a cookie.
 *
 * NO SIGN-IN HAPPENS HERE. The row reads the handoff and stops; it never opens
 * the URL, never exchanges a code and never spends a scope. What it measures is
 * the shape of the URL a person is sent to — the one part of the flow a
 * deployment can get wrong silently, because an authorize URL with an empty
 * `client_id` or no `code_challenge_method` looks like a working button and
 * fails on Cloudflare's page — and the two things a deployment can get wrong
 * dangerously: the run key in that URL, and no binding cookie on the answer.
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

        // The leg is a POST with the key in a header, and the answer is where
        // the browser is sent — so the key is in no URL the product ever
        // navigates to, and this row reads the URL it would have navigated to.
        const handoff = await fetch(`${plan.origin}/api/deploy/runs/${ticket.runId}/authorize`, {
          method: 'POST',
          headers: { authorization: `Bearer ${ticket.runKey}` },
        });

        const said = await handoff.text();

        goals.push(options.cloudflare
          ? authorizeHandoff(handoff, said, plan.origin, options.clientId)
          : {
            what: 'unconfigured-door-refuses-the-handoff',
            reached: handoff.status === 503 && !said.includes('dash.cloudflare.com'),
            detail: JSON.stringify({ status: handoff.status, said: said.slice(0, 200) }),
          });

        return goals;
      },
      // The three fetches this row makes outside any workspace ledger, plus
      // the run it mints on the door.
      calls: () => 4,
    }, observations);
  });
});

/**
 * The handoff the door answered, parameter by parameter, plus the binding it
 * set on the browser. Read, never followed: nothing here consents to anything.
 *
 * The cookie is half of what this row measures. Without it a callback URL is
 * bearer authority over whichever run its `state` names, so a deployment that
 * answered a handoff and set no `__Host-kinu_deploy_state` is the B1 shape
 * back, on the product, and this row is what says so.
 */
function authorizeHandoff(handoff: Response, body: string, origin: string, clientId: string): EvalSubgoal {
  const said = v.safeParse(v.object({ location: v.pipe(v.string(), v.url()) }), JSON.parse(body));
  const url = said.success ? new URL(said.output.location) : null;
  const query = url?.searchParams;
  const scopes = (query?.get('scope') ?? '').split(' ');
  const binding = handoff.headers.get('set-cookie') ?? '';

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
    bound: binding.includes('__Host-kinu_deploy_state=')
      && binding.includes('HttpOnly')
      && binding.includes('Secure'),
    // The key authorized the POST in a header; a deployment that put it back
    // in the URL it hands the browser is the H1 shape back.
    keyInHandoff: said.success && said.output.location.includes('key='),
  };

  return {
    what: 'authorize-answer-carries-the-pkce-handoff-and-binds-the-browser',
    reached: handoff.status === 200
      && carried.endpoint === 'https://dash.cloudflare.com/oauth2/auth'
      && carried.responseType === 'code'
      && carried.clientId === clientId
      && carried.redirectUri === `${origin}/deploy/callback`
      && carried.method === 'S256'
      && CHALLENGE.test(carried.challenge)
      && carried.state !== ''
      && CLOUDFLARE_DEPLOY_SCOPES.every((scope) => scopes.includes(scope))
      && carried.bound
      && !carried.keyInHandoff,
    detail: JSON.stringify(carried),
  };
}

export const DEFECT = FIRST_RUN_DEFECTS[CASE];
