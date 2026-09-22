/**
 * FIRST RUN: two subagents, navigate away and back, both chats still there.
 *
 * THE ASK (issue #13). Create two subagents the way the tab strip's "+" does,
 * say one thing to each over its own chat socket, then DROP every socket — the
 * navigation the owner made, to another workspace and back — and re-open the
 * rooms from nothing. The workspace's roster must still name both children and
 * each child's own room must still serve back the words that were said in it.
 *
 * WHY EVERY GATE STAYED GREEN. The roster read a chat surface makes was
 * `SubordinateRosterStore.list()`, which filters `status != 'dismissed'`, so
 * reachability was derived from employability and a dismissed child's tab went
 * with its employment — while the dismiss copy promises "Its conversation is
 * kept, not deleted". The second half is `conversation_heads`: `newestId()`
 * returned a stored head without asking whether it still named a row, so a head
 * that did not resolve took every read down an anonymous ancestry failure and
 * handed `record` a parent that re-roots the next message. Both are unit-tested
 * now (`packages/cf-backend/tests/unit-subordinates.test.ts`,
 * `packages/core/tests/unit-transcript-head.test.ts`), and neither unit can see
 * what a DEPLOYED workspace serves a browser that comes back to it.
 *
 * WHAT MAKES THIS ROW DIFFERENT from `agent-tab`. That row proves a tab the
 * client just opened answers its mount reads, on sockets it never let go of.
 * This one proves PERSISTENCE: every socket is closed and re-opened, so the
 * answers come from durable rows rather than from anything an activation still
 * held. A workspace that answers only while the tab stays open is the exact
 * shape of the report.
 *
 * NO WALL CLOCK. A read that never answers is bounded by the case's own BUDGET
 * (the `budgetMs` the harness aborts on), so each verdict is "answered" or
 * "never answered before the budget" — never a duration this row compares.
 */
import { afterAll, describe, test } from 'vitest';
import * as v from 'valibot';

import {
  ChatHistoryEntrySchema, hostedActorSocketPath, ORCHESTRATOR_AGENT_SLUG, type JsonValue,
} from '../../packages/core/src/index';
import type { EvalObservation, EvalSubgoal } from '@kinu.run/test-utils';
import {
  FIRST_RUN_DEFECTS, firstRunCasePlan, publishFirstRunRecord, runFirstRunCase,
} from './first-run';
import { ask, openPublicSocket, rpcDetail, type PublicSocket } from './public-socket';
import { webHeaders } from '../evals/public-session';

const SUITE = 'First-run · agent-chats-persist';

const CASE = 'agent-chats-persist' as const;

/** What each subagent is told, one word apiece so the readback is unambiguous. */
const SAID = ['Reply with only the word ALPHA.', 'Reply with only the word BRAVO.'] as const;

const PLAN = firstRunCasePlan(SUITE, CASE);

const liveTest = test.skipIf(PLAN === null);

const observations: EvalObservation[] = [];

/**
 * Say what each subgoal measured, from inside the case.
 *
 * `runFirstRunCase` prints the same lines AFTER it collects the episode's
 * evidence, and that collection can refuse first — the reason `agent-tab`
 * carries this too: a deployment that never opens a chat room produces no
 * model call, and the model-call contract then fails with one line that names
 * no subgoal at all.
 */
function announce(subgoals: readonly EvalSubgoal[]): readonly EvalSubgoal[] {
  for (const subgoal of subgoals) {
    console.warn(`    [${CASE}] ${subgoal.what}: ${subgoal.reached ? 'ok' : 'MISSED'} — ${subgoal.detail}`);
  }

  return subgoals;
}

afterAll(() => { publishFirstRunRecord(SUITE, PLAN?.llm.model, [CASE], observations); });

/** What `createSubordinateAgent` answers with, read for the two identities
 *  the pane uses: the name its socket is addressed by, the actor id its
 *  history is paged by. */
const CreatedSchema = v.object({
  name: v.string(),
  subordinate: v.object({ actorReference: v.object({ actorId: v.string() }) }),
});

const RosterSchema = v.array(v.object({ name: v.string(), status: v.optional(v.string()) }));

/** The page `getChatHistoryPage` answers, read as the chat pane's own pager
 *  reads it — the product's row schema, not a second copy of it. */
const HistoryPageSchema = v.object({ items: v.array(ChatHistoryEntrySchema) });

function historyText(value: JsonValue): string {
  const parsed = v.safeParse(HistoryPageSchema, value);

  return parsed.success ? parsed.output.items.map((entry) => entry.content).join(' ') : '';
}

describe(SUITE, () => {
  // THE ROW MUST TERMINATE: the tier runs with testTimeout 0, so a read the
  // product never answers would hold the tier open with it. The case BUDGET
  // ends it — every wait below is settled by the product or by that abort.
  liveTest(`MEASURED: ${CASE}`, { timeout: 12 * 60_000 }, async () => {
    if (PLAN === null) throw new Error('unreachable: this arm is gated on a resolved plan');

    await runFirstRunCase(PLAN, {
      id: CASE,
      modelCalls: 'expected',
      purpose: 'Two subagents whose chats survive leaving the workspace and coming back.',
      budgetMs: 10 * 60_000,
      async run({ session, plan, budget }) {
        const subgoals: EvalSubgoal[] = [];
        const room = `/agents/${ORCHESTRATOR_AGENT_SLUG}/${encodeURIComponent(session.workspace)}`;
        const open = (path: string): PublicSocket => openPublicSocket(plan.origin, plan.identity, path, budget);
        const live: PublicSocket[] = [];

        try {
          // ── Two agents, created the way "+" creates one. ────────────────
          const first = open(room);
          live.push(first);

          if (!(await first.opened)) {
            subgoals.push({
              what: 'agents-created',
              reached: false,
              detail: `the workspace room ${first.path} refused the upgrade, so nothing could be created`,
            });

            return announce(subgoals);
          }

          const names: string[] = [];
          const actorIds: string[] = [];

          for (let index = 0; index < SAID.length; index += 1) {
            const answer = await ask(first, 'createSubordinateAgent', []);
            const created = answer.ok ? v.safeParse(CreatedSchema, answer.value) : null;

            if (created === null || !created.success) {
              subgoals.push({
                what: 'agents-created',
                reached: false,
                detail: rpcDetail({ rpc: 'createSubordinateAgent', answer, refusal: 'refused', said: null }),
              });

              return announce(subgoals);
            }

            names.push(created.output.name);
            actorIds.push(created.output.subordinate.actorReference.actorId);
          }

          subgoals.push({
            what: 'agents-created',
            reached: names.length === SAID.length,
            detail: `createSubordinateAgent answered twice: ${JSON.stringify(names)}`,
          });

          // ── One thing said in each child's own room. ────────────────────
          const said: string[] = [];

          for (const [index, name] of names.entries()) {
            const child = open(`${room}/${hostedActorSocketPath(name)}`);
            live.push(child);

            if (!(await child.opened)) {
              subgoals.push({
                what: 'chats-opened',
                reached: false,
                detail: `${child.path} refused the upgrade, so ${name} was never spoken to`,
              });

              return announce(subgoals);
            }

            const text = SAID[index] ?? '';

            try {
              const result = await child.chat(text);
              said.push(result.landed === 'turn' ? text : '');
            } catch (error) {
              said.push('');
              subgoals.push({
                what: 'chats-opened',
                reached: false,
                detail: `${name} never answered: ${(error instanceof Error ? error.message : String(error)).slice(0, 240)}`,
              });
            }
          }

          if (said.some((text) => text === '')) return announce(subgoals);
          subgoals.push({
            what: 'chats-opened',
            reached: true,
            detail: `both agents answered a message on their own room`,
          });

          // ── NAVIGATE AWAY. Every socket dropped, so nothing that follows
          //    can be served out of an activation this row kept alive. ─────
          for (const socket of live.splice(0)) socket.close('navigated away');

          // ── AND BACK. A fresh workspace room, and the roster read the tab
          //    strip makes on mount. ─────────────────────────────────────
          const back = open(room);
          live.push(back);

          if (!(await back.opened)) {
            subgoals.push({
              what: 'roster-survives',
              reached: false,
              detail: `${back.path} refused the upgrade on the way back`,
            });

            return announce(subgoals);
          }

          const rosterAnswer = await ask(back, 'listSubordinates', []);
          const roster = rosterAnswer.ok ? v.safeParse(RosterSchema, rosterAnswer.value) : null;
          const listed = roster !== null && roster.success ? roster.output.map((entry) => entry.name) : [];

          subgoals.push({
            what: 'roster-survives',
            reached: names.every((name) => listed.includes(name)),
            detail: rpcDetail({
              rpc: 'listSubordinates', answer: rosterAnswer, refusal: 'never answered',
              said: roster !== null && roster.success
                ? `listSubordinates answered ${JSON.stringify(listed)} for created ${JSON.stringify(names)}`
                : null,
            }),
          });

          // ── Each chat, re-opened from nothing, still holding its words. ─
          const reachable: string[] = [];
          const lost: string[] = [];

          // The pane's two reads, exactly as the client makes them: the SDK's
          // own `get-messages` seed on the actor's socket path (use-kinu.ts,
          // `hostedActorSocketPath`), and its pager, `getChatHistoryPage`
          // with the pane's actor id (use-chat-thread.ts). A page request
          // WITHOUT the actor id answers the workspace's own rows by
          // contract, so a row that omitted it read an empty workspace chat
          // as a lost conversation — measured 2026-09-22 on 78f345bf1.
          for (const [index, name] of names.entries()) {
            const path = `${room}/${hostedActorSocketPath(name)}`;
            const wanted = SAID[index] ?? '';
            const seed = await fetch(new URL(`${path}/get-messages`, plan.origin), { headers: webHeaders(plan.identity) });
            const seeded = seed.ok ? JSON.stringify(await seed.json()) : '';

            if (!seeded.includes(wanted)) {
              lost.push(`${name}: the seed on its own path (${String(seed.status)}) came back without the words said in it`);
              continue;
            }

            const child = open(path);
            live.push(child);

            if (!(await child.opened)) {
              lost.push(`${name}: its room refused the upgrade on the way back`);
              continue;
            }

            const historyAnswer = await ask(child, 'getChatHistoryPage', [{ actor: actorIds[index] ?? '', limit: 50 }]);
            const text = historyAnswer.ok ? historyText(historyAnswer.value) : '';

            if (text.includes(wanted)) reachable.push(name);
            else if (!historyAnswer.ok) lost.push(`${name}: ${historyAnswer.failure.slice(0, 160)}`);
            else lost.push(`${name}: its pager came back without the words said in it`);
          }

          subgoals.push({
            what: 'chats-reachable',
            reached: reachable.length === names.length,
            // The report, in the shape it would take here: the roster answers
            // and the rooms open, but a conversation comes back short.
            detail: lost.length === 0
              ? `both conversations came back holding what was said in them: ${JSON.stringify(reachable)}`
              : `conversations that did not come back whole — ${lost.join('; ').slice(0, 400)}`,
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
 *  corpus and the defect register equal without importing the case modules
 *  (each of which resolves a live plan at import). */
export const DEFECT = FIRST_RUN_DEFECTS[CASE];
