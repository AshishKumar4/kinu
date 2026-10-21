/**
 * FIRST RUN: dismiss a subagent, keep its conversation, and read it back.
 *
 * THE ASK. The Dismiss dialog promises "Its conversation is kept, not
 * deleted": after a subagent is dismissed with its history kept, its tab stays
 * on the strip and its pane still reads what was said in it, over the
 * workspace's own socket, because the dismissed agent no longer executes and
 * its own room is shut.
 *
 * WHY `agent-chats-persist` DID NOT GUARD THIS. That row proves two EMPLOYED
 * agents keep their chats across navigation and never dismisses one. Run
 * against 2eba2c1e5, the parent of the fix (e21207492), it passes; this row
 * fails there, on the page read.
 *
 * NO WALL CLOCK. Every wait is settled by the product or by the case's own
 * BUDGET abort, so each verdict is "answered" or "never answered before the
 * budget".
 */
import { afterAll, describe, test } from 'vitest';
import * as v from 'valibot';

import {
  ChatHistoryEntrySchema, hostedActorSocketPath, ORCHESTRATOR_AGENT_SLUG, type JsonValue,
} from '../../packages/core/src/index';
import type { EvalObservation, EvalSubgoal } from '@kinu.run/test-utils';
import { firstRunCaseId, firstRunCasePlan, type FirstRunDefect, publishFirstRunRecord, runFirstRunCase } from './first-run';
import { ask, openPublicSocket, rpcDetail, type PublicSocket } from './public-socket';
import { webHeaders } from '../../evals/src/workspace-roster';
import { rowText } from '@kinu.run/core';

const SUITE = 'First-run · agent-dismissed-chat';

const CASE = firstRunCaseId(import.meta.url);

/** What this case found, and what a red here means (`FirstRunDefect`). */
const DEFECT: FirstRunDefect = {
  found: 'A subagent dismissed with its conversation kept, the Dismiss dialog\'s default, kept '
    + 'its tab but its chat never loaded: the pager refused the dismissed agent with "The actor '
    + 'is not registered in this workspace.", while the dialog promises "Its conversation is '
    + 'kept, not deleted".',
  missedBecause: '`agent-chats-persist` proves EMPLOYED agents keep their chats and never '
    + 'dismisses one, so it passes with the fix (e21207492) reverted. The pre-deploy half '
    + 'arrived with the fix, in packages/cf-backend/tests/workerd/wide/public-surface.test.ts; no '
    + 'deployed row read a dismissed agent\'s kept chat the way its pane reads it.',
  provedRedAt: '2eba2c1e5',
  redDirection: 'Run against 2eba2c1e5, the parent of e21207492, served by `vite dev` on '
    + 'loopback (the Worker the deploy ships, with local state): `kept-chat-reads` misses on '
    + 'the refusal above. Green on e21207492 served the same way.',
};

/** What the subagent is told, one word so the readback is unambiguous. */
const SAID = 'Reply with only the word CHARLIE.';

const PLAN = firstRunCasePlan(SUITE, 'kept');

const liveTest = test.skipIf(PLAN === null);

const observations: EvalObservation[] = [];

function announce(subgoals: readonly EvalSubgoal[]): readonly EvalSubgoal[] {
  for (const subgoal of subgoals) {
    console.warn(`    [${CASE}] ${subgoal.what}: ${subgoal.reached ? 'ok' : 'MISSED'} — ${subgoal.detail}`);
  }

  return subgoals;
}

afterAll(async () => { await publishFirstRunRecord(SUITE, PLAN?.llm.model, [CASE], observations); });

const CreatedSchema = v.object({
  name: v.string(),
  subagent: v.object({ actorReference: v.object({ actorId: v.string() }) }),
});

/** A roster row as the tab strip reads it. `actorId` is optional so a build
 *  whose roster omits it reads as a missed subgoal rather than foreign bytes. */
const RowSchema = v.object({
  name: v.string(), actorId: v.optional(v.nullable(v.string())), displayName: v.string(), status: v.string(),
});

const RosterSchema = v.array(RowSchema);

const HistoryPageSchema = v.object({ items: v.array(ChatHistoryEntrySchema) });

/** One page as the pane's pager reads it: the words said, and the answers. */
function historyEntries(value: JsonValue) {
  const parsed = v.safeParse(HistoryPageSchema, value);
  const items = parsed.success ? parsed.output.items : [];
  const of = (role: string): string => items.filter((entry) => entry.role === role).map((entry) => rowText(entry)).join(' ');

  return { said: of('user'), answered: of('assistant') };
}

async function roster(socket: PublicSocket): Promise<{ readonly rows: v.InferOutput<typeof RosterSchema> | null; readonly detail: string }> {
  const answer = await ask(socket, 'listSubagents', []);
  const parsed = answer.ok ? v.safeParse(RosterSchema, answer.value) : null;

  return parsed !== null && parsed.success
    ? { rows: parsed.output, detail: `listSubagents answered ${JSON.stringify(parsed.output).slice(0, 300)}` }
    : { rows: null, detail: rpcDetail({ rpc: 'listSubagents', answer, refusal: 'never answered', said: null }) };
}

describe(SUITE, () => {
  liveTest(`MEASURED: ${CASE}`, { timeout: 12 * 60_000 }, async () => {
    if (PLAN === null) throw new Error('unreachable: this arm is gated on a resolved plan');

    await runFirstRunCase(PLAN, {
      id: CASE,
      defect: DEFECT,
      modelCalls: 'expected',
      purpose: 'A dismissed subagent whose kept conversation still reads.',
      budgetMs: 10 * 60_000,
      async run({ session, plan, budget }) {
        const subgoals: EvalSubgoal[] = [];
        const room = `/agents/${ORCHESTRATOR_AGENT_SLUG}/${encodeURIComponent(session.workspace)}`;
        const open = (path: string): PublicSocket => openPublicSocket(plan.origin, plan.identity, path, budget);
        const live: PublicSocket[] = [];

        try {
          // ── One agent, created the way "+" creates one. ─────────────────
          const workspace = open(room);
          live.push(workspace);

          if (!(await workspace.opened)) {
            subgoals.push({ what: 'agent-created', reached: false, detail: `the workspace room ${room} refused the upgrade` });

            return announce(subgoals);
          }

          const answer = await ask(workspace, 'createSubagentAgent', []);
          const created = answer.ok ? v.safeParse(CreatedSchema, answer.value) : null;

          if (created === null || !created.success) {
            subgoals.push({
              what: 'agent-created',
              reached: false,
              detail: rpcDetail({ rpc: 'createSubagentAgent', answer, refusal: 'refused', said: null }),
            });

            return announce(subgoals);
          }

          const { name } = created.output;
          const { actorId } = created.output.subagent.actorReference;
          subgoals.push({ what: 'agent-created', reached: true, detail: `createSubagentAgent answered ${name} (${actorId})` });

          // ── Something said in its own room. ─────────────────────────────
          const ownPath = `${room}/${hostedActorSocketPath(name)}`;
          const own = open(ownPath);
          live.push(own);

          if (!(await own.opened)) {
            subgoals.push({ what: 'chat-answered', reached: false, detail: `${ownPath} refused the upgrade` });

            return announce(subgoals);
          }

          let relay = '';

          try {
            const result = await own.chat(SAID);
            relay = result.landed === 'turn' && result.hadError ? ' (the relay reported an error mid-stream)' : '';
          } catch (error) {
            subgoals.push({
              what: 'chat-answered',
              reached: false,
              detail: `${name} never answered: ${(error instanceof Error ? error.message : String(error)).slice(0, 240)}`,
            });

            return announce(subgoals);
          }

          // `chat` resolved on the DO's `done` frame, sent once the answer is
          // durable, so the dismissal lands on a settled conversation — the one
          // the dialog promises to keep — and its own pager already holds it.
          const ownPage = await ask(own, 'getChatHistoryPage', [{ actor: actorId, limit: 50 }]);
          const { answered } = ownPage.ok ? historyEntries(ownPage.value) : { answered: '' };
          subgoals.push({
            what: 'chat-answered',
            reached: answered.length > 0,
            detail: answered.length > 0
              ? `its own pager holds the answer ${JSON.stringify(answered.slice(0, 120))}${relay}`
              : `its own pager holds no answer${ownPage.ok ? '' : `: ${ownPage.failure.slice(0, 200)}`}${relay}`,
          });

          if (answered.length === 0) return announce(subgoals);

          own.close('the chat is done');

          const employed = await roster(workspace);
          const employedRow = employed.rows?.find((row) => row.name === name);

          // ── Dismissed the way the dialog dismisses: history kept. ───────
          const dismissal = await ask(workspace, 'dismissSubagent', [name]);
          const kept = dismissal.ok ? v.safeParse(v.object({ historyKept: v.literal(true) }), dismissal.value) : null;
          subgoals.push({
            what: 'dismissed-kept',
            reached: kept !== null && kept.success,
            detail: rpcDetail({
              rpc: 'dismissSubagent', answer: dismissal, refusal: 'refused',
              said: kept !== null && kept.success ? 'dismissSubagent answered historyKept: true' : null,
            }),
          });

          // ── Navigate away and back: every socket dropped, a fresh room. ─
          for (const socket of live.splice(0)) socket.close('navigated away');
          const back = open(room);
          live.push(back);

          if (!(await back.opened)) {
            subgoals.push({ what: 'roster-keeps-row', reached: false, detail: `${room} refused the upgrade on the way back` });

            return announce(subgoals);
          }

          // The tab survives with its identity: the dismissed row keeps the
          // actor id its pane pages by and the title it had while employed.
          const after = await roster(back);
          const row = after.rows?.find((entry) => entry.name === name);
          subgoals.push({
            what: 'roster-keeps-row',
            reached: row !== undefined && row.status === 'dismissed' && row.actorId === actorId
              && employedRow !== undefined && row.displayName === employedRow.displayName,
            detail: `${after.detail}; employed as ${JSON.stringify(employedRow ?? null)}`,
          });

          // ── The kept chat reads, on the workspace socket, by actor id:
          //    what was said in it and what the agent answered. ─────────────
          const page = await ask(back, 'getChatHistoryPage', [{ actor: actorId, limit: 50 }]);
          const exchange = page.ok ? historyEntries(page.value) : { said: '', answered: '' };
          const whole = exchange.said.includes(SAID) && exchange.answered.includes(answered);
          subgoals.push({
            what: 'kept-chat-reads',
            reached: whole,
            detail: page.ok
              ? `the page ${whole ? 'holds' : 'lacks'} the exchange: said ${JSON.stringify(exchange.said.slice(0, 120))}, `
                + `answered ${JSON.stringify(exchange.answered.slice(0, 120))}`
              : `getChatHistoryPage refused: ${page.failure.slice(0, 300)}`,
          });

          // ── And the agent no longer executes: its own room is shut. ─────
          const seed = await fetch(new URL(`${ownPath}/get-messages`, plan.origin), { headers: webHeaders(plan.identity) });
          subgoals.push({
            what: 'own-room-shut',
            reached: seed.status === 404,
            detail: `${ownPath}/get-messages answered ${String(seed.status)}`,
          });

          return announce(subgoals);
        } finally {
          for (const socket of live) socket.close('the row is done');
        }
      },
    }, observations);
  });
});

/** The defect this case is red on, re-exported so `wiring.test.ts` can hold the
 *  corpus and the defect register equal without importing the case modules. */
