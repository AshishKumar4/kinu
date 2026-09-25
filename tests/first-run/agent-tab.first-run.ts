/**
 * FIRST RUN: the agent tab the web UI's "+" opens answers its own reads.
 *
 * THE ASK. Create a subagent exactly the way the tab strip's "+" does —
 * `createSubordinateAgent`, the call `WorkspacePage`'s `createAndOpenAgent`
 * makes through `useKinu`'s `createSubordinate` — then open that actor's OWN
 * chat path and ask over it the two RPCs the tab makes on mount:
 * `getActorSnapshot` (the read `loadSubordinateData` depends on) and
 * `getChatHistoryPage` naming the actor's id (the read `useChatThread` draws the
 * tab's conversation from). Then send one
 * message to that subagent and read its answer. Every check reads what the
 * product answered — the RPC payload, the chat reply — never a model's account
 * of anything.
 *
 * WHY EVERY GATE STAYED GREEN. The workerd proof drives hosted actors through
 * the object, never through a client-built address; the routing pin proves the
 * server's grammar over string literals the test writes itself. Nothing opened
 * a hosted actor's own socket path the way the browser does and read back what
 * it serves, so a client that builds a dead facet path is invisible to all of
 * it — and the client did build one: `useKinu` opened the tab through the
 * Agents SDK's `sub` facet option, whose address the transport refuses as
 * foreign. The owner's report is the other half: "Disconnected · Untitled
 * agent" over a skeleton, with both mount reads never answering.
 *
 * THIS ROW ASSERTS THE CORRECT BEHAVIOUR, and its address comes from the
 * product's own `hostedActorSocketPath` rather than a literal this file
 * spells, so it tracks whatever the client computes. Green needs the actor
 * path to upgrade, both mount reads to answer, and one message to get one
 * answer — against a DEPLOYED build, which is why a green here and a green in
 * the source tree are different claims.
 *
 * THE SAME PUBLIC SURFACE THE BROWSER USES, and nothing narrower: both sockets
 * are the web client's own transport — a header-carrying WebSocket under
 * `/agents/<slug>/<workspace>`, the root for the create and `…/actor/<name>`
 * for the tab — carrying the same `rpc` and chat frames `KinuPublicSession`
 * speaks, decoded by the same codec. No object handle, no private member, no
 * internal shortcut.
 *
 * NO WALL CLOCK. A read that never answers is bounded by the case's own BUDGET
 * (the `budgetMs` the harness aborts on), so each verdict is "answered" or
 * "never answered before the budget" — never a duration this row compares.
 */
import { afterAll, describe, test } from 'vitest';
import * as v from 'valibot';

import { hostedActorSocketPath, ORCHESTRATOR_AGENT_SLUG } from '../../packages/core/src/index';
import type { EvalObservation, EvalSubgoal } from '@kinu.run/test-utils';
import {
  FIRST_RUN_DEFECTS, firstRunCasePlan, publishFirstRunRecord, runFirstRunCase,
} from './first-run';
import { ask, openPublicSocket, rpcDetail, type PublicSocket } from './public-socket';

const SUITE = 'First-run · agent-tab';

const CASE = 'agent-tab' as const;

/** What the tab says to the agent it just opened. */
const TAB_HELLO = 'Reply with only the word READY.';

const PLAN = firstRunCasePlan(SUITE, CASE);

const liveTest = test.skipIf(PLAN === null);

const observations: EvalObservation[] = [];

/**
 * Say what each subgoal measured, from inside the case.
 *
 * `runFirstRunCase` prints the same lines AFTER it collects the episode's
 * evidence, and that collection can refuse first: this row's reads are RPCs,
 * so a deployment that never opens the tab socket produces no model call and
 * the model-call contract fails with one line that names no subgoal. Measured
 * on the first live drive, which reported only "expected model calls
 * expected, observed 0" over four decided subgoals.
 */
function announce(subgoals: readonly EvalSubgoal[]): readonly EvalSubgoal[] {
  for (const subgoal of subgoals) {
    console.warn(`    [agent-tab] ${subgoal.what}: ${subgoal.reached ? 'ok' : 'MISSED'} — ${subgoal.detail}`);
  }

  return subgoals;
}

afterAll(() => { publishFirstRunRecord(SUITE, PLAN?.llm.model, [CASE], observations); });

const CreatedSchema = v.object({ name: v.string() });

const SnapshotSchema = v.object({
  name: v.string(),
  actorId: v.string(),
  displayName: v.optional(v.string()),
  role: v.optional(v.string()),
  mission: v.optional(v.string()),
  pendingSteers: v.optional(v.array(v.unknown())),
});

const HistoryPageSchema = v.object({ status: v.string(), items: v.array(v.unknown()) });

describe(SUITE, () => {
  // THE ROW MUST TERMINATE: the tier runs with testTimeout 0, so a read the
  // product never answers would hold the tier open with it. The case BUDGET
  // ends it — every wait above is settled by the product or by that abort —
  // and the harness retains the ledger as found, which the verdict reads.
  liveTest(`MEASURED: ${CASE}`, { timeout: 12 * 60_000 }, async () => {
    if (PLAN === null) throw new Error('unreachable: this arm is gated on a resolved plan');

    await runFirstRunCase(PLAN, {
      id: CASE,
      modelCalls: 'expected',
      purpose: 'A workspace whose new agent tab answers its own reads and one message.',
      budgetMs: 8 * 60_000,
      async run({ session, plan, budget }) {
        const subgoals: EvalSubgoal[] = [];
        const room = `/agents/${ORCHESTRATOR_AGENT_SLUG}/${encodeURIComponent(session.workspace)}`;
        const rootSocket = openPublicSocket(plan.origin, plan.identity, room, budget);
        let tabSocket: PublicSocket | null = null;

        try {
          if (!(await rootSocket.opened)) {
            subgoals.push({
              what: 'tab-creates',
              reached: false,
              detail: `the workspace room ${rootSocket.path} refused the upgrade, so the "+" call had no socket`,
            });

            return announce(subgoals);
          }

          // ── The "+" path: one call, identity only, no form. ─────────────
          const createdAnswer = await ask(rootSocket, 'createSubordinateAgent', []);
          const created = createdAnswer.ok ? v.safeParse(CreatedSchema, createdAnswer.value) : null;

          subgoals.push({
            what: 'tab-creates',
            reached: created !== null && created.success,
            detail: rpcDetail({
              rpc: 'createSubordinateAgent', answer: createdAnswer, refusal: 'refused',
              said: created !== null && created.success
                ? `createSubordinateAgent answered with ${JSON.stringify(created.output.name)}`
                : null,
            }),
          });

          if (created === null || !created.success) return announce(subgoals);
          const name = created.output.name;

          // ── The tab's own socket, on the actor's own path. ──────────────
          // The address the CLIENT computes, read from the product's own
          // helper rather than restated here: a row that spelled the segment
          // itself would pass while the browser built something else.
          tabSocket = openPublicSocket(
            plan.origin, plan.identity, `${room}/${hostedActorSocketPath(name)}`, budget,
          );

          const upgraded = await tabSocket.opened;

          subgoals.push({
            what: 'tab-socket-opens',
            reached: upgraded,
            detail: upgraded
              ? `${tabSocket.path} upgraded to a socket`
              : `${tabSocket.path} refused the upgrade — the cba44dcb9 shape: 404 with no 101, `
                + 'after which every RPC on it can only time out',
          });

          if (!upgraded) return announce(subgoals);

          // ── The two reads the tab makes on mount. ──────────────────────
          const snapshotAnswer = await ask(tabSocket, 'getActorSnapshot', [name]);
          const snapshot = snapshotAnswer.ok ? v.safeParse(SnapshotSchema, snapshotAnswer.value) : null;

          subgoals.push({
            what: 'snapshot-answers',
            reached: snapshot !== null && snapshot.success && snapshot.output.name === name,
            detail: rpcDetail({
              rpc: 'getActorSnapshot', answer: snapshotAnswer, refusal: 'never answered',
              said: snapshot !== null && snapshot.success
                ? `getActorSnapshot answered for ${JSON.stringify(snapshot.output.name)} (role `
                  + `${JSON.stringify(snapshot.output.role ?? '')})`
                : null,
            }),
          });

          // The tab pages its conversation by the id the snapshot names; without one there is nothing to page.
          const actorId = snapshot !== null && snapshot.success ? snapshot.output.actorId : null;

          const historyAnswer = actorId === null
            ? { ok: false as const, failure: 'the snapshot named no actor id to page by' }
            : await ask(tabSocket, 'getChatHistoryPage', [{ actor: actorId, limit: 40 }]);

          const history = historyAnswer.ok ? v.safeParse(HistoryPageSchema, historyAnswer.value) : null;

          subgoals.push({
            what: 'history-answers',
            reached: history !== null && history.success,
            detail: rpcDetail({
              rpc: 'getChatHistoryPage', answer: historyAnswer, refusal: 'never answered',
              said: history !== null && history.success
                ? `getChatHistoryPage answered ${String(history.output.items.length)} rows (${history.output.status})`
                : null,
            }),
          });

          // ── One message to the subagent, one answer back. ──────────────
          let reply = '';
          let replyFailure = '';

          try {
            const result = await tabSocket.chat(TAB_HELLO);
            reply = result.landed === 'turn' ? result.text : '';
            replyFailure = result.landed === 'turn' ? '' : 'the send landed mid-turn on the tab socket';
          } catch (error) {
            replyFailure = error instanceof Error ? error.message : String(error);
          }

          subgoals.push({
            what: 'message-answered',
            reached: reply.trim().length > 0,
            detail: reply.trim().length > 0
              ? `the agent answered: ${JSON.stringify(reply.slice(0, 240))}`
              : `no answer on the tab socket: ${replyFailure.slice(0, 300)}`,
          });

          return announce(subgoals);
        } finally {
          tabSocket?.close('the row is done');
          rootSocket.close('the row is done');
        }
      },
    }, observations);
  });
});

/** The defect this case is red on, re-exported so `wiring.test.ts` can hold the
 *  corpus and the defect register equal without importing the case modules
 *  (each of which resolves a live plan at import). */
export const DEFECT = FIRST_RUN_DEFECTS[CASE];
