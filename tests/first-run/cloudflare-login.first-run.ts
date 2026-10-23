/**
 * FIRST RUN: a Cloudflare login whose refresh fails asks for a new sign-in, and only then.
 *
 * THE ASK. MA-022: one Cloudflare login serves Kinu and Workers AI, refreshing is the normal path, and signing in again
 * is the fallback for a login that can no longer refresh (docs/PRODUCT-SPEC.md). This row acts as the
 * `cloudflare-login` eval account and stores the row a sign-in stores, expired and holding a refresh token Cloudflare
 * never issued. Listing the account's AI Gateways is a call the login carries: it must try the refresh, and on its
 * refusal answer as signed out (`connected: false`), so Settings asks for a sign-in, and keep answering so without
 * spending another refresh. A deployment with no Cloudflare client of its own (staging) cannot refresh at all, and must
 * say why rather than list anything. Workers AI chat rides the deployment's binding (`WORKERS_AI_VIA_BINDING`), so the
 * dead login must not take it down. The row deletes the login it stored.
 *
 * NOT HERE. A refresh that succeeds needs a refresh token a person consented to; it is an owner item (MA-022).
 */
import { afterAll, describe, test } from 'vitest';
import * as v from 'valibot';
import type { EvalObservation, EvalSubgoal } from '@kinu.run/test-utils';
import { CLOUDFLARE_OAUTH_CRED_KEY, CLOUDFLARE_WORKERS_AI_SCOPES, DEFAULT_WORKERS_AI_MODEL_SPEC, type JsonObject } from '@kinu.run/core';
import { type PublicSessionPlan } from '../../evals/src/session';
import { webHeaders } from '../../evals/src/workspace-roster';
import { firstRunCaseId, firstRunCasePlan, type FirstRunDefect, publishFirstRunRecord, runFirstRunCase } from './first-run';

const SUITE = 'First-run · cloudflare-login';

const CASE = firstRunCaseId(import.meta.url);

/** What this case found, and what a red here means (`FirstRunDefect`). */
const DEFECT: FirstRunDefect = {
  found: 'MA-022 asked for a recorded run of one Cloudflare login shared by Kinu and Workers AI, with signing in again only '
    + 'as the fallback, and no deployed row ever expired a login: every refresh test stubs the token endpoint or the '
    + 'credential store.',
  missedBecause: 'packages/cf-backend/tests/unit-workers-ai-auth.test.ts and unit-subscription-login.test.ts answer the refresh '
    + 'from a stub, so a deployment whose refusal left the login listed as connected, or retried a spent refresh token on '
    + 'every read, passed them all.',
  provedRedAt: null,
  redDirection: 'Green requires the expired login to be stored, the gateway listing to answer signed out after the '
    + 'refused refresh (or, with no Cloudflare client on the deployment, to name that and list nothing), to answer the '
    + 'same again, the binding\'s Workers AI to answer, and the login to be deleted.',
};

const PLAN = firstRunCasePlan(SUITE, 'cflogin', 'cloudflare-login');

const liveTest = test.skipIf(PLAN === null);

const observations: EvalObservation[] = [];

afterAll(async () => { await publishFirstRunRecord(SUITE, PLAN?.llm.model, [CASE], observations); });

/** An account id of the shape Cloudflare issues; no account answers to it, and no call reaches it. */
const ACCOUNT_ID = 'f1257f1257f1257f1257f1257f1257f1';

const AccountsSchema = v.looseObject({ connected: v.boolean(), selectedId: v.nullable(v.string()) });

const GatewaysSchema = v.looseObject({ connected: v.boolean(), gateways: v.array(v.unknown()), error: v.nullable(v.string()) });

const OkSchema = v.looseObject({ ok: v.boolean() });

const ModelTestSchema = v.looseObject({ ok: v.boolean(), message: v.optional(v.string()) });

interface Answer<T> {
  readonly value: T | null;
  readonly detail: string;
}

/** One `/api/user` route as Settings calls it. */
interface UserRoute<S extends v.GenericSchema> {
  readonly schema: S;
  readonly method: 'GET' | 'POST' | 'DELETE';
  readonly path: string;
  readonly body?: JsonObject;
}

/** One `/api/user` route as Settings calls it, parsed as Settings parses it. */
async function call<S extends v.GenericSchema>(plan: PublicSessionPlan, route: UserRoute<S>): Promise<Answer<v.InferOutput<S>>> {
  const { schema, method, path, body } = route;

  const response = await fetch(new URL(`/api/user${path}`, plan.origin), {
    method,
    headers: { ...webHeaders(plan.identity), 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  const parsed = response.ok ? v.safeParse(schema, JSON.parse(text)) : null;

  return parsed !== null && parsed.success
    ? { value: parsed.output, detail: `${method} ${path} answered ${text.slice(0, 300)}` }
    : { value: null, detail: `${method} ${path} answered ${String(response.status)}: ${text.slice(0, 300)}` };
}

/** Signed out after a refused refresh, or, on a deployment with no Cloudflare client, the reason it cannot refresh. */
function refusedAsSignedOut(answer: v.InferOutput<typeof GatewaysSchema> | null): boolean {
  if (answer === null || answer.gateways.length > 0) return false;

  return !answer.connected || /client id is not configured/u.test(answer.error ?? '');
}

const LOGIN_PATH = `/credentials/${encodeURIComponent(CLOUDFLARE_OAUTH_CRED_KEY)}`;

describe(SUITE, () => {
  liveTest(`MEASURED: ${CASE}`, async () => {
    if (PLAN === null) throw new Error('unreachable: this arm is gated on a resolved plan');

    await runFirstRunCase(PLAN, {
      // The binding's one model call is the account's test route, outside the workspace's ledger, which holds none.
      id: CASE, defect: DEFECT, modelCalls: 'none', budgetMs: 5 * 60_000, genesis: false,
      purpose: 'Disposable Cloudflare-login probe; no model task.',
      async run({ plan }) {
        const subgoals: EvalSubgoal[] = [];

        // A login a run before this one left behind would answer for this one.
        await call(plan, { schema: OkSchema, method: 'DELETE', path: LOGIN_PATH });

        try {
          const stored = await call(plan, { schema: OkSchema, method: 'POST', path: LOGIN_PATH, body: {
            kind: 'oauth',
            accessToken: 'first-run-expired-access',
            refreshToken: `first-run-never-issued-${String(Date.now())}`,
            expiresAt: Date.now() - 3_600_000,
            metadata: { accountId: ACCOUNT_ID, accounts: [{ id: ACCOUNT_ID, name: 'First-run' }], scopes: CLOUDFLARE_WORKERS_AI_SCOPES },
          } });

          const accounts = await call(plan, { schema: AccountsSchema, method: 'GET', path: '/cloudflare/accounts' });

          subgoals.push({
            what: 'login-stored',
            reached: stored.value?.ok === true && accounts.value?.connected === true && accounts.value.selectedId === ACCOUNT_ID,
            detail: `${stored.detail}; then ${accounts.detail}`,
          });

          const first = await call(plan, { schema: GatewaysSchema, method: 'GET', path: '/cloudflare/gateways' });

          subgoals.push({ what: 'refused-refresh-asks-sign-in', reached: refusedAsSignedOut(first.value), detail: first.detail });

          const again = await call(plan, { schema: GatewaysSchema, method: 'GET', path: '/cloudflare/gateways' });

          subgoals.push({
            what: 'stays-signed-out',
            reached: refusedAsSignedOut(again.value) && again.value?.connected === first.value?.connected,
            detail: again.detail,
          });

          const binding = await call(plan, { schema: ModelTestSchema, method: 'POST', path: '/models/test', body: { spec: DEFAULT_WORKERS_AI_MODEL_SPEC } });

          subgoals.push({ what: 'binding-answers', reached: binding.value?.ok === true, detail: binding.detail });
        } finally {
          const deleted = await call(plan, { schema: OkSchema, method: 'DELETE', path: LOGIN_PATH });
          const after = await call(plan, { schema: AccountsSchema, method: 'GET', path: '/cloudflare/accounts' });

          subgoals.push({
            what: 'login-deleted',
            reached: deleted.value?.ok === true && after.value?.connected === false,
            detail: `${deleted.detail}; then ${after.detail}`,
          });
        }

        return subgoals;
      },
    }, observations);
  });
});
