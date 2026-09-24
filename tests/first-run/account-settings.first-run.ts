/**
 * FIRST RUN: the account's own pages answer on the deployed product.
 *
 * THE ASK. Every user-facing surface has a deployed row. The welcome flow and
 * the account settings page read and write the account itself: the welcome
 * page names the person and stamps onboarding done, and the settings page
 * reads the profile, renames it and shows the CLI's install and sign-in lines.
 * This row drives those reads and writes over the same `/api/user` routes the
 * pages call, as the eval account.
 *
 * WHY NO OTHER ROW GUARDS THIS. Every other row opens a workspace; none reads
 * or writes the account, so a profile route that stopped answering, a rename
 * that did not persist or an onboarding stamp that did not stick — each of
 * which strands a person on /welcome or shows a stale name — passed them all.
 *
 * THE RENAME IS UNDONE. The account is shared by every case, so the row
 * restores the name it found and checks that the restore landed. An account
 * found unnamed is left with {@link UNNAMED_RESTORE}: the route refuses an
 * empty name, so no request can put an unnamed account back as it was.
 */
import { afterAll, describe, test } from 'vitest';
import * as v from 'valibot';
import { EVAL_DEPLOYMENT_ORIGIN, type EvalObservation, type EvalSubgoal } from '@kinu.run/test-utils';
import { webHeaders, type PublicSessionPlan } from '../evals/public-session';
import { FIRST_RUN_DEFECTS, firstRunCasePlan, publishFirstRunRecord, runFirstRunCase } from './first-run';

const SUITE = 'First-run · account-settings';

const CASE = 'account-settings' as const;

const PLAN = firstRunCasePlan(SUITE, CASE);

const liveTest = test.skipIf(PLAN === null);

const observations: EvalObservation[] = [];

afterAll(() => { publishFirstRunRecord(SUITE, PLAN?.llm.model, [CASE], observations); });

const ProfileSchema = v.looseObject({
  email: v.string(), displayName: v.nullable(v.string()), onboardedAt: v.nullable(v.number()),
});

const CliSetupSchema = v.looseObject({ publicOrigin: v.string(), installCommand: v.string(), authCommand: v.string() });

/** The name an account found unnamed is left with. */
const UNNAMED_RESTORE = 'Kinu first-run';

interface Answer<T> {
  readonly value: T | null;
  readonly detail: string;
}

/** One `/api/user` route, as its page calls it. */
interface UserRoute<S extends v.GenericSchema> {
  readonly schema: S;
  readonly method: 'GET' | 'PATCH' | 'POST';
  readonly path: string;
  readonly body?: Readonly<Record<string, string>>;
}

/** One `/api/user` route as its page calls it, parsed as the page parses it. */
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
    ? { value: parsed.output, detail: `${method} ${path} answered ${text.slice(0, 200)}` }
    : { value: null, detail: `${method} ${path} answered ${String(response.status)}: ${text.slice(0, 200)}` };
}

describe(SUITE, () => {
  liveTest(`MEASURED: ${CASE}`, async () => {
    if (PLAN === null) throw new Error('unreachable: this arm is gated on a resolved plan');

    await runFirstRunCase(PLAN, {
      id: CASE, modelCalls: 'none', genesis: false,
      purpose: 'Disposable account-page probe; no model task.',
      async run({ plan }) {
        const subgoals: EvalSubgoal[] = [];
        const found = await call(plan, { schema: ProfileSchema, method: 'GET', path: '/profile' });

        subgoals.push({ what: 'profile-read', reached: found.value !== null, detail: found.detail });

        if (found.value === null) return subgoals;
        const restoreTo = found.value.displayName ?? UNNAMED_RESTORE;
        const renamed = `First-run ${String(Date.now())}`;

        try {
          const written = await call(plan, { schema: ProfileSchema, method: 'PATCH', path: '/profile', body: { displayName: renamed } });
          const reread = await call(plan, { schema: ProfileSchema, method: 'GET', path: '/profile' });

          subgoals.push({
            what: 'rename-persisted',
            reached: written.value?.displayName === renamed && reread.value?.displayName === renamed,
            detail: `${written.detail}; then ${reread.detail}`,
          });
        } finally {
          const restored = await call(plan, { schema: ProfileSchema, method: 'PATCH', path: '/profile', body: { displayName: restoreTo } });

          subgoals.push({
            what: 'rename-restored',
            reached: restored.value?.displayName === restoreTo,
            detail: found.value.displayName === null ? `the account had no name; ${restored.detail}` : restored.detail,
          });
        }

        const stamped = await call(plan, { schema: v.object({ onboardedAt: v.number() }), method: 'POST', path: '/onboarding/complete' });
        const after = await call(plan, { schema: ProfileSchema, method: 'GET', path: '/profile' });

        subgoals.push({
          what: 'onboarding-stamped',
          reached: stamped.value !== null && after.value?.onboardedAt === stamped.value.onboardedAt,
          detail: `${stamped.detail}; then ${after.detail}`,
        });

        // The deployment's public origin is configured, not the address this
        // row reached it by (`CLI_PUBLIC_ORIGIN`, which tests pin to this constant).
        const cli = await call(plan, { schema: CliSetupSchema, method: 'GET', path: '/cli' });

        subgoals.push({
          what: 'cli-lines-name-the-deployment',
          reached: cli.value !== null && cli.value.publicOrigin === EVAL_DEPLOYMENT_ORIGIN
            && cli.value.installCommand.includes(EVAL_DEPLOYMENT_ORIGIN) && cli.value.authCommand.includes(EVAL_DEPLOYMENT_ORIGIN),
          detail: cli.detail,
        });

        return subgoals;
      },
    }, observations);
  });
});

/** The defect this case is red on, re-exported so `wiring.test.ts` can hold the
 *  corpus and the defect register equal without importing the case modules. */
export const DEFECT = FIRST_RUN_DEFECTS[CASE];
