/**
 * FIRST RUN: a subagent is confined to the workspace that made it.
 *
 * THE ASK. Subordinates are "other agents confined to the workspace itself"
 * (the owner, 2026-07-13): made in one workspace, listed on its strip, chatted
 * with there, and reachable from no other workspace of the same account. The
 * account's other workspaces are peers; a workspace's subagents are not.
 *
 * WHY NO OTHER ROW GUARDS THIS. Every subagent row works inside the one
 * workspace that made the agent, so a roster, a pager or a hosted room that
 * answered an agent of another workspace would pass all of them.
 *
 * NO MODEL. Nothing here needs an answer, so both workspaces open without a
 * genesis turn and the row is measured at zero model calls.
 */
import { afterAll, describe, test } from 'vitest';
import * as v from 'valibot';

import { hostedActorSocketPath, ORCHESTRATOR_AGENT_SLUG } from '../../packages/core/src/index';
import type { EvalObservation, EvalSubgoal } from '@kinu.run/test-utils';
import type { KinuPublicSession } from '../evals/public-session';
import { webHeaders } from '../evals/public-session';
import {
  FIRST_RUN_DEFECTS, firstRunCasePlan, publishFirstRunRecord, runFirstRunCase,
} from './first-run';
import { ask, openPublicSocket, rpcDetail, type PublicSocket } from './public-socket';

const SUITE = 'First-run · agent-confined';

const CASE = 'agent-confined' as const;

const PLAN = firstRunCasePlan(SUITE, CASE);

const liveTest = test.skipIf(PLAN === null);

const observations: EvalObservation[] = [];

function announce(subgoals: readonly EvalSubgoal[]): readonly EvalSubgoal[] {
  for (const subgoal of subgoals) {
    console.warn(`    [${CASE}] ${subgoal.what}: ${subgoal.reached ? 'ok' : 'MISSED'} — ${subgoal.detail}`);
  }

  return subgoals;
}

afterAll(() => { publishFirstRunRecord(SUITE, PLAN?.llm.model, [CASE], observations); });

const CreatedSchema = v.object({
  name: v.string(),
  subordinate: v.object({ actorReference: v.object({ actorId: v.string() }) }),
});

const RosterSchema = v.array(v.object({ name: v.string() }));

const roomOf = (workspace: string): string => `/agents/${ORCHESTRATOR_AGENT_SLUG}/${encodeURIComponent(workspace)}`;

async function listed(socket: PublicSocket): Promise<{ readonly names: readonly string[] | null; readonly detail: string }> {
  const answer = await ask(socket, 'listSubordinates', []);
  const parsed = answer.ok ? v.safeParse(RosterSchema, answer.value) : null;

  return parsed !== null && parsed.success
    ? { names: parsed.output.map((row) => row.name), detail: `listSubordinates answered ${JSON.stringify(parsed.output.map((row) => row.name))}` }
    : { names: null, detail: rpcDetail({ rpc: 'listSubordinates', answer, refusal: 'never answered', said: null }) };
}

describe(SUITE, () => {
  liveTest(`MEASURED: ${CASE}`, { timeout: 12 * 60_000 }, async () => {
    if (PLAN === null) throw new Error('unreachable: this arm is gated on a resolved plan');

    await runFirstRunCase(PLAN, {
      id: CASE,
      modelCalls: 'none',
      genesis: false,
      purpose: 'A subagent made in one workspace, looked for from another.',
      budgetMs: 10 * 60_000,
      async run({ session, plan, budget }) {
        const subgoals: EvalSubgoal[] = [];
        const open = (path: string): PublicSocket => openPublicSocket(plan.origin, plan.identity, path, budget);
        const live: PublicSocket[] = [];
        let other: KinuPublicSession | null = null;

        try {
          // ── An agent made in this workspace, the way "+" makes one. ─────
          const home = open(roomOf(session.workspace));
          live.push(home);

          if (!(await home.opened)) {
            subgoals.push({ what: 'agent-created', reached: false, detail: `${home.path} refused the upgrade` });

            return announce(subgoals);
          }

          const answer = await ask(home, 'createSubordinateAgent', []);
          const created = answer.ok ? v.safeParse(CreatedSchema, answer.value) : null;

          if (created === null || !created.success) {
            subgoals.push({
              what: 'agent-created', reached: false,
              detail: rpcDetail({ rpc: 'createSubordinateAgent', answer, refusal: 'refused', said: null }),
            });

            return announce(subgoals);
          }

          const { name } = created.output;
          const { actorId } = created.output.subordinate.actorReference;
          subgoals.push({ what: 'agent-created', reached: true, detail: `createSubordinateAgent answered ${name} (${actorId})` });

          const here = await listed(home);
          subgoals.push({ what: 'listed-where-made', reached: here.names?.includes(name) === true, detail: here.detail });

          // ── A second workspace of the same owner looks for it. ──────────
          other = await plan.open({ subject: 'confined2', purpose: 'The same owner, a second workspace; no model task.', genesis: false });
          const away = open(roomOf(other.workspace));
          live.push(away);

          if (!(await away.opened)) {
            subgoals.push({ what: 'unlisted-elsewhere', reached: false, detail: `${away.path} refused the upgrade` });

            return announce(subgoals);
          }

          const there = await listed(away);
          subgoals.push({
            what: 'unlisted-elsewhere',
            reached: there.names !== null && !there.names.includes(name),
            detail: there.detail,
          });

          // Its conversation, asked for by its actor id on the other workspace's socket.
          const page = await ask(away, 'getChatHistoryPage', [{ actor: actorId, limit: 10 }]);
          subgoals.push({
            what: 'unreadable-elsewhere',
            reached: !page.ok,
            detail: page.ok
              ? `the other workspace answered its pager: ${JSON.stringify(page.value).slice(0, 200)}`
              : `the other workspace refused its pager: ${page.failure.slice(0, 200)}`,
          });

          // Its room, addressed under the other workspace.
          const path = `${roomOf(other.workspace)}/${hostedActorSocketPath(name)}/get-messages`;
          const seed = await fetch(new URL(path, plan.origin), { headers: webHeaders(plan.identity) });
          subgoals.push({
            what: 'unreachable-elsewhere',
            reached: seed.status === 404,
            detail: `${path} answered ${String(seed.status)}`,
          });

          return announce(subgoals);
        } finally {
          for (const socket of live) socket.close('the row is done');

          if (other !== null) await other.teardown();
        }
      },
    }, observations);
  });
});

/** The defect this case is red on, re-exported so `wiring.test.ts` can hold the
 *  corpus and the defect register equal without importing the case modules. */
export const DEFECT = FIRST_RUN_DEFECTS[CASE];
