/**
 * FIRST RUN: a free account's limits, on the deployment that sets them.
 *
 * THE ASK. kinu.run holds a free account to 3 workspaces, 20 computer hours a month, one small computer running, 2 GB
 * stored and 500,000 tokens a day on its own models (core limits/, `ACCOUNT_LIMITS` in wrangler.jsonc). Settings reads
 * each limit from the account's object, and a new workspace past the third is refused in the limit's own words, which
 * the page knows its dialog by (`refusedFor`). Nothing the account already has is refused: the workspaces it holds keep
 * answering, and removing one makes room again.
 *
 * ITS OWN ACCOUNT. It runs as `limits`, the one eval account the free tier binds (`LIMITED_EVAL_ACCOUNT`); every other
 * eval account is exempt, so no other row meets a limit. Workspaces this account holds from a run cut off before its
 * teardown are removed first, so the count starts at the case's own.
 *
 * WHY NO OTHER ROW GUARDS THIS. Unit tests prove each admission and the page's dialogs on fixed words; only a deployed
 * row proves the refusal crosses the account's object, the create route and the error mapping with its words intact,
 * and that the deployment's free tier is set at all.
 *
 * NO MODEL. The workspaces open without their genesis turn.
 */
import { afterAll, describe, test } from 'vitest';
import * as v from 'valibot';

import { LimitsReportSchema, refusedFor, type LimitsReport } from '../../packages/core/src/index';
import type { EvalSubgoal, EvalObservation } from '@kinu.run/test-utils';
import { firstRunCaseId, firstRunCasePlan, type FirstRunDefect, publishFirstRunRecord, runFirstRunCase } from './first-run';
import { createWorkspace, deleteWorkspace, listWorkspaces, webHeaders, type PublicWebIdentity } from '../../evals/src/workspace-roster';

const SUITE = 'First-run · account-limits';

const CASE = firstRunCaseId(import.meta.url);

/** What this case found, and what a red here means (`FirstRunDefect`). */
const DEFECT: FirstRunDefect = {
  found: "kinu.run holds a free account to its limits, and no deployed row met one: the refusal's words, which the page "
    + 'knows its dialog by, crossed no deployed route.',
  missedBecause: "unit tests read each admission and the page's dialogs on fixed words, so a create route or error "
    + 'mapping that lost the words, or a deployment with no free tier set, passed them all.',
  provedRedAt: null,
  redDirection: 'Planted on a loopback `vite dev` build of this tree with ACCOUNT_LIMITS unset: `limits-read` misses '
    + 'on a report with no readings, and `fourth-refused` misses on a 201.',
};

const PLAN = firstRunCasePlan(SUITE, 'limits', 'limits');

const liveTest = test.skipIf(PLAN === null);

const observations: EvalObservation[] = [];

afterAll(async () => { await publishFirstRunRecord(SUITE, PLAN?.llm.model, [CASE], observations); });

/** The workspace limit's reading, or null when the report carries none. */
function workspacesOf(report: LimitsReport | null) {
  return report?.limits.find((reading) => reading.id === 'workspaces') ?? null;
}

/** Settings' read of the account's limits: the report, or null with what answered. */
async function readLimits(origin: string, identity: PublicWebIdentity, signal: AbortSignal): Promise<{ readonly report: LimitsReport | null; readonly detail: string }> {
  const answer = await fetch(`${origin}/api/user/limits`, { headers: webHeaders(identity), signal });
  const text = await answer.text();
  const parsed = answer.ok ? v.safeParse(LimitsReportSchema, JSON.parse(text)) : null;

  return parsed?.success === true ? { report: parsed.output, detail: text.slice(0, 400) } : { report: null, detail: `${String(answer.status)} ${text.slice(0, 300)}` };
}

/** A create as the sidebar asks it, answered raw: its status and body. */
async function askToCreate(origin: string, identity: PublicWebIdentity, name: string, signal: AbortSignal) {
  const answer = await fetch(`${origin}/api/user/workspaces`, {
    method: 'POST', headers: { ...webHeaders(identity), 'content-type': 'application/json' }, body: JSON.stringify({ name }), signal,
  });

  return { status: answer.status, body: (await answer.text()).slice(0, 600) };
}

const RefusalSchema = v.object({ error: v.string(), code: v.string() });

describe(SUITE, () => {
  liveTest(`MEASURED: ${CASE}`, async () => {
    if (PLAN === null) throw new Error('unreachable: this arm is gated on a resolved plan');

    await runFirstRunCase(PLAN, {
      id: CASE, defect: DEFECT, modelCalls: 'none', budgetMs: 5 * 60_000, genesis: false,
      purpose: "Disposable probe of a free account's workspace limit; no model task.",
      async run({ session, plan, budget }) {
        const subgoals: EvalSubgoal[] = [];
        const { origin, identity } = plan;
        const made: string[] = [];

        try {
          // A run cut off before its teardown left workspaces behind: removed, so the count starts at this case's own.
          for (const row of await listWorkspaces(origin, identity)) {
            if (row.name !== session.workspace) await deleteWorkspace(origin, identity, row.name);
          }

          const first = await readLimits(origin, identity, budget);
          const reading = workspacesOf(first.report);

          subgoals.push({
            what: 'limits-read',
            reached: first.report?.class === 'free' && first.report.freeTier && reading?.used === 1 && reading.limit === 3
              && first.report.computerSizeCap === 'small' && first.report.limits.length === 5,
            detail: first.detail,
          });

          const stamp = String(Date.now());

          for (const index of [2, 3]) made.push(await createWorkspace(origin, identity, { name: `limits-probe-${stamp}-${String(index)}` }));

          const full = await readLimits(origin, identity, budget);
          const fourth = await askToCreate(origin, identity, `limits-probe-${stamp}-4`, budget);
          const refusal = v.safeParse(RefusalSchema, JSON.parse(fourth.body === '' ? 'null' : fourth.body));

          subgoals.push({
            what: 'at-the-limit',
            reached: workspacesOf(full.report)?.used === 3 && workspacesOf(full.report)?.reached === true,
            detail: full.detail,
          });
          subgoals.push({
            what: 'fourth-refused',
            reached: fourth.status === 413 && refusal.success && refusal.output.code === 'budget' && refusedFor(refusal.output.error) === 'workspaces',
            detail: `POST /api/user/workspaces answered ${String(fourth.status)} ${fourth.body}`,
          });

          // What the account has keeps answering at its limit, and removing one makes room again.
          const listed = (await listWorkspaces(origin, identity)).map((row) => row.name);
          const removed = made.pop();

          if (removed !== undefined) await deleteWorkspace(origin, identity, removed);
          const after = await readLimits(origin, identity, budget);

          subgoals.push({
            what: 'held-ones-answer',
            reached: [session.workspace, ...made].every((name) => listed.includes(name)),
            detail: `the roster lists ${listed.join(', ')}`,
          });
          subgoals.push({
            what: 'room-after-removal',
            reached: workspacesOf(after.report)?.used === 2 && workspacesOf(after.report)?.reached === false,
            detail: after.detail,
          });

          return subgoals;
        } finally {
          for (const name of made) await deleteWorkspace(origin, identity, name);
        }
      },
    }, observations);
  });
});
