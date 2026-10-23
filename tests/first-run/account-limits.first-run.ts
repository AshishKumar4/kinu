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

/** A create as the sidebar asks it, answered raw: its status, body, and the workspace it made if it made one. */
async function askToCreate(origin: string, identity: PublicWebIdentity, name: string, signal: AbortSignal) {
  const answer = await fetch(`${origin}/api/user/workspaces`, {
    method: 'POST', headers: { ...webHeaders(identity), 'content-type': 'application/json' }, body: JSON.stringify({ name }), signal,
  });

  const body = await answer.text();
  const created = answer.ok ? v.safeParse(v.object({ name: v.string() }), JSON.parse(body)) : null;

  return { status: answer.status, body: body.slice(0, 600), made: created?.success === true ? created.output.name : null };
}

const RefusalSchema = v.object({ error: v.string(), code: v.string() });

/**
 * Removes every workspace on the `limits` account but `keep`, before the case opens its own: a run cut off before its
 * teardown left the account at its limit, where opening the case's workspace would be refused. Each request ends with
 * the deployment's answer or the connection's failure, as a teardown's does.
 */
async function sweep(origin: string, identity: PublicWebIdentity, keep: readonly string[]): Promise<void> {
  for (const row of await listWorkspaces(origin, identity)) {
    if (!keep.includes(row.name)) await deleteWorkspace(origin, identity, row.name);
  }
}

/**
 * Deletes each of `made` still there, every one attempted, after the probe settled; the deletes whose request failed,
 * with why. Not on the case's budget, which a probe that ran out has spent: the next run's sweep takes what this left.
 */
async function teardown(origin: string, identity: PublicWebIdentity, made: Set<string>): Promise<string[]> {
  const deleted = await Promise.allSettled([...made].map(async (name) => {
    await deleteWorkspace(origin, identity, name);
    made.delete(name);
  }));

  return deleted.flatMap((outcome) => (outcome.status === 'rejected' ? [String(outcome.reason)] : []));
}

/** The probe: the report, the limit met and refused in its words, the held ones answering, and room again. */
async function probe({ session, origin, identity, budget, made }: {
  session: { readonly workspace: string };
  origin: string;
  identity: PublicWebIdentity;
  budget: AbortSignal;
  made: Set<string>;
}): Promise<EvalSubgoal[]> {
  const subgoals: EvalSubgoal[] = [];
  const first = await readLimits(origin, identity, budget);
  const reading = workspacesOf(first.report);

  subgoals.push({
    what: 'limits-read',
    reached: first.report?.class === 'free' && first.report.freeTier && reading?.used === 1 && reading.limit === 3
      && first.report.computerSizeCap === 'small' && first.report.limits.length === 5,
    detail: first.detail,
  });

  const stamp = String(Date.now());

  for (const index of [2, 3]) made.add(await createWorkspace(origin, identity, { name: `limits-probe-${stamp}-${String(index)}` }, budget));
  const held = [session.workspace, ...made];

  const full = await readLimits(origin, identity, budget);
  const fourth = await askToCreate(origin, identity, `limits-probe-${stamp}-4`, budget);

  // A deployment with no free tier makes it: torn down with the rest.
  if (fourth.made !== null) made.add(fourth.made);
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

  // All three held ones keep answering at the limit, the refused ask taking none of them; removing one makes room.
  const listed = (await listWorkspaces(origin, identity, budget)).map((row) => row.name);

  subgoals.push({
    what: 'held-ones-answer',
    reached: held.length === 3 && held.every((name) => listed.includes(name)),
    detail: `held ${held.join(', ')}; the roster lists ${listed.join(', ')}`,
  });

  const removed = held.at(-1);

  if (removed !== undefined && removed !== session.workspace) {
    await deleteWorkspace(origin, identity, removed, budget);
    made.delete(removed);
  }

  const after = await readLimits(origin, identity, budget);

  subgoals.push({
    what: 'room-after-removal',
    reached: workspacesOf(after.report)?.used === 2 && workspacesOf(after.report)?.reached === false,
    detail: after.detail,
  });

  return subgoals;
}

describe(SUITE, () => {
  liveTest(`MEASURED: ${CASE}`, async () => {
    if (PLAN === null) throw new Error('unreachable: this arm is gated on a resolved plan');

    await sweep(PLAN.origin, PLAN.identity, []);
    await runFirstRunCase(PLAN, {
      id: CASE, defect: DEFECT, modelCalls: 'none', budgetMs: 5 * 60_000, genesis: false,
      purpose: "Disposable probe of a free account's workspace limit; no model task.",
      async run({ session, plan, budget }) {
        const { origin, identity } = plan;

        // Each workspace this case made, until its delete succeeded.
        const made = new Set<string>();
        const probed = await Promise.allSettled([probe({ session, origin, identity, budget, made })]);
        const left = await teardown(origin, identity, made);
        const [outcome] = probed;

        // The case's own failure stands; otherwise a teardown that left workspaces behind is its red.
        if (outcome?.status === 'rejected') throw outcome.reason;

        if (left.length > 0) throw new Error(`the account-limits teardown left workspaces behind: ${left.join('; ')}`);

        return outcome?.status === 'fulfilled' ? outcome.value : [];
      },
    }, observations);
  });
});
