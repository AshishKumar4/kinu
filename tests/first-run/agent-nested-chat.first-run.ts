/**
 * FIRST RUN: a helper hired by a hired agent opens from the task it owns in the Work tab.
 *
 * THE ASK. Such a helper gets no chat tab; the Work tab names it as the owner of its task, and
 * activating that owner opens its chat through its path of names, the way the TUI's Agent Hub
 * does. This row creates a helper the way the "+" does, tells it to hire one of its own that
 * adds an open task, then reads what the Work tab reads (`listWorkspaceWork`) and follows the
 * owner's path exactly as the web pane does: the socket at `hostedActorSocketPath(path)`, then
 * the two mount reads over it. Every check reads what the product answered.
 *
 * WHY EVERY GATE STAYED GREEN. The unit and workerd proofs drive the resolver and the pane on
 * the object; nothing opened a grandchild's socket through the deployed edge, which is where
 * the path becomes an actor id.
 *
 * NO WALL CLOCK. A read that never answers is bounded by the case's BUDGET.
 */
import { afterAll, describe, test } from 'vitest';
import * as v from 'valibot';

import {
  ChatHistoryEntrySchema, hostedActorSocketPath, ORCHESTRATOR_AGENT_SLUG, WorkspaceWorkSchema,
} from '../../packages/core/src/index';
import type { EvalObservation, EvalSubgoal } from '@kinu.run/test-utils';
import {
  FIRST_RUN_DEFECTS, firstRunCasePlan, publishFirstRunRecord, runFirstRunCase,
} from './first-run';
import { NESTED_HIRE_ASK, NESTED_TASK_TITLE, NESTED_WORD } from './asks';
import { ask, openPublicSocket, rpcDetail, type PublicSocket } from './public-socket';

const SUITE = 'First-run · agent-nested-chat';

const CASE = 'agent-nested-chat' as const;

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

const CreatedSchema = v.object({ name: v.string() });

const SnapshotSchema = v.object({ name: v.string(), actorId: v.string() });

const HistoryPageSchema = v.object({ status: v.string(), items: v.array(v.unknown()) });

const AnswersPageSchema = v.object({ items: v.array(ChatHistoryEntrySchema) });

/** Activating the owner, as the pane does: its socket at the owner's path, then its two mount reads. */
async function followOwner(pane: PublicSocket, path: string, ownerName: string, subgoals: EvalSubgoal[]): Promise<void> {
  const upgraded = await pane.opened;

  subgoals.push({
    what: 'nested-socket-opens',
    reached: upgraded,
    detail: upgraded ? `${pane.path} upgraded` : `${pane.path} refused the upgrade`,
  });

  if (!upgraded) return;
  const snapshotAnswer = await ask(pane, 'getActorSnapshot', [path]);
  const snapshot = snapshotAnswer.ok ? v.safeParse(SnapshotSchema, snapshotAnswer.value) : null;

  subgoals.push({
    what: 'nested-snapshot-answers',
    reached: snapshot?.success === true && snapshot.output.name === ownerName,
    detail: rpcDetail({
      rpc: 'getActorSnapshot', answer: snapshotAnswer, refusal: 'never answered',
      said: snapshot?.success === true ? `answered for ${JSON.stringify(snapshot.output.name)}` : null,
    }),
  });

  const historyAnswer = snapshot?.success === true
    ? await ask(pane, 'getChatHistoryPage', [{ actor: snapshot.output.actorId, limit: 40 }])
    : { ok: false as const, failure: 'the snapshot named no actor id to page by' };

  const history = historyAnswer.ok ? v.safeParse(HistoryPageSchema, historyAnswer.value) : null;

  subgoals.push({
    what: 'nested-transcript-shows',
    reached: history?.success === true && history.output.items.length > 0,
    detail: rpcDetail({
      rpc: 'getChatHistoryPage', answer: historyAnswer, refusal: 'never answered',
      said: history?.success === true ? `answered ${String(history.output.items.length)} rows` : null,
    }),
  });
}

/** The actor's newest answer in its own chat, read as its pane reads it. */
async function lastAnswer(pane: PublicSocket, name: string): Promise<string> {
  const snapshotAnswer = await ask(pane, 'getActorSnapshot', [name]);
  const snapshot = snapshotAnswer.ok ? v.safeParse(SnapshotSchema, snapshotAnswer.value) : null;

  if (snapshot?.success !== true) return '';
  const page = await ask(pane, 'getChatHistoryPage', [{ actor: snapshot.output.actorId, limit: 40 }]);
  const answers = page.ok ? v.safeParse(AnswersPageSchema, page.value) : null;

  return answers?.success === true ? answers.output.items.filter((entry) => entry.role === 'assistant').at(-1)?.content ?? '' : '';
}

/** What the Work tab reads, and the path of the owner it names for the grandchild's task. */
function ownedTask(workAnswer: Awaited<ReturnType<typeof ask>>) {
  const work = workAnswer.ok ? v.safeParse(WorkspaceWorkSchema, workAnswer.value) : null;

  if (work?.success !== true) return undefined;

  return work.output.tasks.find(({ owner, tasks }) => (owner.path?.length ?? 0) === 2 && tasks.some((task) => task.title === NESTED_TASK_TITLE));
}

describe(SUITE, () => {
  liveTest(`MEASURED: ${CASE}`, { timeout: 14 * 60_000 }, async () => {
    if (PLAN === null) throw new Error('unreachable: this arm is gated on a resolved plan');

    await runFirstRunCase(PLAN, {
      id: CASE,
      modelCalls: 'expected',
      purpose: 'A grandchild\'s chat opened from the Work-tab owner of its task.',
      budgetMs: 10 * 60_000,
      async run({ session, plan, budget }) {
        const subgoals: EvalSubgoal[] = [];
        const room = `/agents/${ORCHESTRATOR_AGENT_SLUG}/${encodeURIComponent(session.workspace)}`;
        const rootSocket = openPublicSocket(plan.origin, plan.identity, room, budget);
        const opened: PublicSocket[] = [];

        const open = (path: string): PublicSocket => {
          const socket = openPublicSocket(plan.origin, plan.identity, `${room}/${hostedActorSocketPath(path)}`, budget);
          opened.push(socket);

          return socket;
        };

        try {
          if (!(await rootSocket.opened)) {
            subgoals.push({ what: 'helper-created', reached: false, detail: `the workspace room ${rootSocket.path} refused the upgrade` });

            return announce(subgoals);
          }

          const createdAnswer = await ask(rootSocket, 'createSubordinateAgent', []);
          const created = createdAnswer.ok ? v.safeParse(CreatedSchema, createdAnswer.value) : null;

          subgoals.push({
            what: 'helper-created',
            reached: created?.success === true,
            detail: rpcDetail({
              rpc: 'createSubordinateAgent', answer: createdAnswer, refusal: 'refused',
              said: created?.success === true ? `created ${JSON.stringify(created.output.name)}` : null,
            }),
          });

          if (created?.success !== true) return announce(subgoals);
          const helper = open(created.output.name);
          let reply = '';

          // A durable hire answers after the helper's turn: its report opens the helper's next turn, which relays it.
          try {
            const result = (await helper.opened) ? await helper.chat(NESTED_HIRE_ASK) : null;

            if (result?.landed === 'turn' && await helper.turnClosed()) reply = await lastAnswer(helper, created.output.name);
          } catch (error) {
            subgoals.push({ what: 'grandchild-answered', reached: false, detail: `the helper's turn failed: ${String(error).slice(0, 300)}` });

            return announce(subgoals);
          }

          subgoals.push({
            what: 'grandchild-answered',
            reached: reply.includes(NESTED_WORD),
            detail: `the helper relayed: ${JSON.stringify(reply.slice(0, 240))}`,
          });

          // ── What the Work tab reads, and the owner it names. ─────────────
          const workAnswer = await ask(rootSocket, 'listWorkspaceWork', []);
          const owned = ownedTask(workAnswer);

          const path = owned?.owner.path?.join('/') ?? null;

          subgoals.push({
            what: 'work-names-owner',
            reached: path !== null,
            detail: rpcDetail({
              rpc: 'listWorkspaceWork', answer: workAnswer, refusal: 'never answered',
              said: path === null ? `no task titled ${JSON.stringify(NESTED_TASK_TITLE)} under a two-step owner path` : `the task's owner is at ${path}`,
            }),
          });

          if (path === null) return announce(subgoals);

          await followOwner(open(path), path, owned?.owner.name ?? '', subgoals);

          return announce(subgoals);
        } finally {
          for (const socket of opened) socket.close('the row is done');
          rootSocket.close('the row is done');
        }
      },
    }, observations);
  });
});

export const DEFECT = FIRST_RUN_DEFECTS[CASE];
