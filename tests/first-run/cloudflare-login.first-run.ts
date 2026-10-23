/**
 * FIRST RUN: a Cloudflare login Cloudflare refuses to refresh asks for a new sign-in, and only then.
 *
 * THE ASK. MA-022: one Cloudflare login serves Kinu and Workers AI, refreshing is the normal path, and signing in again
 * is the fallback for a login that can no longer refresh (docs/PRODUCT-SPEC.md). This row acts as the
 * `cloudflare-login` eval account and stores the row a sign-in stores, expired and holding a refresh token Cloudflare
 * never issued; storing it lists the account's AI Gateways, a call the login carries, so the refresh is tried at once.
 * Where the deployment has a Cloudflare client of its own (production), Cloudflare refuses the refresh: the refresh
 * token is retired, so the account's Cloudflare read says the sign-in expired (Settings then offers signing in again)
 * and the gateway listing answers signed out without spending it again. Where it has none (staging), the refresh cannot
 * be asked at all: the listing must say so, and the refresh token stays for when it can. Workers AI chat rides the
 * deployment's binding (`WORKERS_AI_VIA_BINDING`), so the dead login must not take it down. The row deletes the login.
 *
 * NOT HERE. A refresh that succeeds needs a refresh token a person consented to; it is an owner item (MA-022).
 */
import { afterAll, describe, test } from 'vitest';
import * as v from 'valibot';
import type { EvalObservation, EvalSubgoal } from '@kinu.run/test-utils';
import { CLOUDFLARE_OAUTH_CRED_KEY, CLOUDFLARE_WORKERS_AI_SCOPES, DEFAULT_WORKERS_AI_MODEL_SPEC } from '@kinu.run/core';
import { accountRoute as call } from './account-route';
import { firstRunCaseId, firstRunCasePlan, type FirstRunDefect, publishFirstRunRecord, runFirstRunCase } from './first-run';

const SUITE = 'First-run · cloudflare-login';

const CASE = firstRunCaseId(import.meta.url);

/** What this case found, and what a red here means (`FirstRunDefect`). */
const DEFECT: FirstRunDefect = {
  found: 'MA-022, 2026-10-23: a login Cloudflare refused to refresh kept its row, so Settings went on showing Cloudflare '
    + 'connected and offered no sign-in, while its AI Gateway and web-search billing quietly stopped. No deployed row had ever '
    + 'expired a login: every refresh test stubs the token endpoint or the credential store.',
  missedBecause: 'packages/cf-backend/tests/unit-workers-ai-auth.test.ts and unit-subscription-login.test.ts answer the refresh '
    + 'from a stub and read no account status, so nothing asked what Settings says after a refused refresh.',
  provedRedAt: null,
  redDirection: 'RED on a build before `signInExpired` (production cc81545a0): the account read carries no expired sign-in, so '
    + '`refused-refresh-asks-sign-in` is missed. Green requires, with a Cloudflare client, the refused refresh to read as an '
    + 'expired sign-in and the gateway listing to answer signed out twice; without one, the listing to name the missing '
    + 'client and no sign-in to be asked; the binding\'s Workers AI to answer; and the login to be deleted.',
};

const PLAN = firstRunCasePlan(SUITE, 'cflogin', 'cloudflare-login');

const liveTest = test.skipIf(PLAN === null);

const observations: EvalObservation[] = [];

afterAll(async () => { await publishFirstRunRecord(SUITE, PLAN?.llm.model, [CASE], observations); });

/** An account id of the shape Cloudflare issues; no account answers to it, and no call reaches it. */
const ACCOUNT_ID = 'f1257f1257f1257f1257f1257f1257f1';

const AccountsSchema = v.looseObject({ connected: v.boolean(), selectedId: v.nullable(v.string()), signInExpired: v.boolean() });

const GatewaysSchema = v.looseObject({ connected: v.boolean(), gateways: v.array(v.unknown()), error: v.nullable(v.string()) });

const OkSchema = v.looseObject({ ok: v.boolean() });

const ModelTestSchema = v.looseObject({ ok: v.boolean(), message: v.optional(v.string()) });

/** The words a deployment with no Cloudflare client of its own refuses a refresh in (`requestCloudflareOAuthToken`). */
const NO_CLIENT = /client id is not configured/u;

const LOGIN_PATH = `/credentials/${encodeURIComponent(CLOUDFLARE_OAUTH_CRED_KEY)}`;

describe(SUITE, () => {
  liveTest(`MEASURED: ${CASE}`, async () => {
    if (PLAN === null) throw new Error('unreachable: this arm is gated on a resolved plan');

    // Awaited however the case ends, its budget spent included: the race the runner makes does not wait for the case's
    // own `finally`.
    try {
      await runFirstRunCase(PLAN, {
        // The binding's one model call is the account's test route, outside the workspace's ledger, which holds none.
        id: CASE, defect: DEFECT, modelCalls: 'none', budgetMs: 5 * 60_000, genesis: false,
        purpose: 'Disposable Cloudflare-login probe; no model task.',
        async run({ plan, budget }) {
          const subgoals: EvalSubgoal[] = [];

          // A login a run before this one left behind would answer for this one.
          await call(plan, { schema: OkSchema, method: 'DELETE', path: LOGIN_PATH });

          try {
            const stored = await call(plan, { schema: OkSchema, method: 'POST', path: LOGIN_PATH, signal: budget, body: {
              kind: 'oauth',
              accessToken: 'first-run-expired-access',
              refreshToken: `first-run-never-issued-${String(Date.now())}`,
              expiresAt: Date.now() - 3_600_000,
              metadata: { accountId: ACCOUNT_ID, accounts: [{ id: ACCOUNT_ID, name: 'First-run' }], scopes: CLOUDFLARE_WORKERS_AI_SCOPES },
            } });

            const first = await call(plan, { schema: GatewaysSchema, method: 'GET', path: '/cloudflare/gateways', signal: budget });
            const accounts = await call(plan, { schema: AccountsSchema, method: 'GET', path: '/cloudflare/accounts', signal: budget });
            const again = await call(plan, { schema: GatewaysSchema, method: 'GET', path: '/cloudflare/gateways', signal: budget });

            subgoals.push({
              what: 'login-stored',
              reached: stored.value?.ok === true && accounts.value?.connected === true && accounts.value.selectedId === ACCOUNT_ID,
              detail: `${stored.detail}; then ${accounts.detail}`,
            });

            if (NO_CLIENT.test(first.value?.error ?? '')) {
              // No client: the refresh was never asked, so its token stays and nobody is told to sign in again.
              subgoals.push({
                what: 'no-client-said',
                reached: first.value?.gateways.length === 0 && NO_CLIENT.test(again.value?.error ?? '') && accounts.value?.signInExpired === false,
                detail: `${first.detail}; then ${accounts.detail}; then ${again.detail}`,
              });
            } else {
              // Refused: only a refused refresh retires the token, and only a retired token reads as an expired sign-in.
              subgoals.push({
                what: 'refused-refresh-asks-sign-in',
                reached: accounts.value?.signInExpired === true,
                detail: `${first.detail}; then ${accounts.detail}`,
              });
              subgoals.push({
                what: 'stays-signed-out',
                reached: [first.value, again.value].every((answer) => answer?.connected === false && answer.gateways.length === 0),
                detail: `${first.detail}; then ${again.detail}`,
              });
            }

            const binding = await call(plan, { schema: ModelTestSchema, method: 'POST', path: '/models/test', signal: budget, body: { spec: DEFAULT_WORKERS_AI_MODEL_SPEC } });

            subgoals.push({ what: 'binding-answers', reached: binding.value?.ok === true, detail: binding.detail });
          } finally {
            // Not under the budget: a case out of time still takes its login away.
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
    } finally {
      await call(PLAN, { schema: OkSchema, method: 'DELETE', path: LOGIN_PATH });
    }
  });
});
