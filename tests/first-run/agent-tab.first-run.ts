/**
 * FIRST RUN: the agent tab the web UI's "+" opens answers its own reads.
 *
 * THE ASK. Create a subagent exactly the way the tab strip's "+" does —
 * `createSubordinateAgent`, the call `WorkspacePage`'s `createAndOpenAgent`
 * makes through `useKinu`'s `createSubordinate` — then open that actor's OWN
 * chat path and ask over it the two RPCs the tab makes on mount:
 * `getActorSnapshot` (the read `loadSubordinateData` depends on) and
 * `listAgentTasks` (the read the tab's task surface depends on). Then send one
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

import {
  hostedActorSocketPath, ORCHESTRATOR_AGENT_SLUG, type JsonValue,
} from '../../packages/core/src/index';
import type { EvalObservation, EvalSubgoal } from '@kinu.run/test-utils';
import {
  FIRST_RUN_DEFECTS, firstRunCasePlan, publishFirstRunRecord, runFirstRunCase,
} from './first-run';
import {
  decodeFrame, encodeChatRequest, encodeRpcRequest, HEADER_WEBSOCKET, recordPublicTurn, webHeaders,
  type PublicSendResult, type PublicTurnRecorder, type PublicWebIdentity,
} from '../evals/public-session';

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

/** One RPC in flight on a public socket. */
interface PendingRpc {
  readonly resolve: (value: JsonValue) => void;
  readonly reject: (error: Error) => void;
}

/** One chat send in flight on a public socket. */
interface PendingTurn {
  readonly recorder: PublicTurnRecorder;
  readonly resolve: (value: PublicSendResult) => void;
  readonly reject: (error: Error) => void;
}

/** One public socket, and the two frame kinds a browser sends over it. */
interface PublicSocket {
  readonly path: string;
  /** True when the upgrade succeeded; false when the deployment refused it. */
  readonly opened: Promise<boolean>;
  rpc(method: string, args: readonly JsonValue[]): Promise<JsonValue>;
  chat(text: string): Promise<PublicSendResult>;
  close(reason: string): void;
}

/**
 * Open one of the browser's own sockets and speak its frames.
 *
 * `budget` is the case's: every wait here is settled by the product or by that
 * abort, so a read the deployment never answers becomes a verdict rather than
 * a hang, and nothing in this row reads a clock.
 */
function openPublicSocket(
  origin: string, identity: PublicWebIdentity, path: string, budget: AbortSignal,
): PublicSocket {
  const url = new URL(path, origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';

  const socket = new HEADER_WEBSOCKET(url.toString(), { headers: webHeaders(identity) });
  const rpcs = new Map<string, PendingRpc>();
  const turns = new Map<string, PendingTurn>();
  let nextId = 0;

  const failInFlight = (reason: string): void => {
    const waiting = [...rpcs.values()];
    const sending = [...turns.values()];
    rpcs.clear();
    turns.clear();

    for (const pending of waiting) pending.reject(new Error(reason));

    for (const turn of sending) turn.reject(new Error(reason));
  };

  budget.addEventListener('abort', () => {
    failInFlight(`the case budget was spent with ${url.pathname} still owing an answer`);
  });

  socket.addEventListener('message', (event: MessageEvent) => {
    // SAFETY: `MessageEvent.data` is `any` on the DOM lib; the agents-SDK
    // transport sends only text or binary payloads, which are exactly the
    // three shapes the codec takes, and it answers null for anything else.
    const frame = decodeFrame(event.data as string | ArrayBuffer | Uint8Array);

    if (frame === null) return;

    if (frame.kind === 'rpc') {
      const pending = rpcs.get(frame.id);

      if (pending === undefined) return;
      rpcs.delete(frame.id);

      if (frame.error === null) pending.resolve(frame.result);
      else pending.reject(new Error(frame.error));

      return;
    }

    if (frame.kind !== 'response') return;
    const turn = turns.get(frame.frame.id);

    if (turn === undefined) return;
    turn.recorder.apply(frame.frame);
    const settled = turn.recorder.settled();

    if (settled === null) return;
    turns.delete(frame.frame.id);
    // The recorder settles on the wire's own word. A mid-turn landing carries
    // no absorbing run id here: this row sends one message per socket, so
    // there is no second send whose close would name one.
    turn.resolve(settled.landed === 'mid-turn' ? { landed: 'mid-turn', absorbedBy: null } : settled);
  });

  socket.addEventListener('close', () => failInFlight(`${url.pathname} closed`));

  const opened = new Promise<boolean>((resolve) => {
    socket.addEventListener('open', () => resolve(true), { once: true });
    socket.addEventListener('error', () => resolve(false), { once: true });
    socket.addEventListener('close', () => resolve(false), { once: true });
    budget.addEventListener('abort', () => resolve(false));
  });

  const mint = (kind: string): string => {
    nextId += 1;

    return `${kind}-${String(nextId)}-${Math.random().toString(36).slice(2, 8)}`;
  };

  return {
    path: url.pathname,
    opened,
    rpc(method, args) {
      return new Promise<JsonValue>((resolve, reject) => {
        const requestId = mint('rpc');
        rpcs.set(requestId, { resolve, reject });
        socket.send(encodeRpcRequest({ requestId, method, args }));
      });
    },
    chat(text) {
      return new Promise<PublicSendResult>((resolve, reject) => {
        const requestId = mint('turn');
        turns.set(requestId, { recorder: recordPublicTurn(), resolve, reject });
        socket.send(encodeChatRequest({ requestId, text }));
      });
    },
    close(reason) {
      failInFlight(reason);
      socket.close();
    },
  };
}

/** One read the tab makes, as the answer it got or the reason it got none. */
type Answer =
  | { readonly ok: true; readonly value: JsonValue }
  | { readonly ok: false; readonly failure: string };

async function ask(socket: PublicSocket, method: string, args: readonly JsonValue[]): Promise<Answer> {
  try {
    return { ok: true, value: await socket.rpc(method, args) };
  } catch (error) {
    return { ok: false, failure: error instanceof Error ? error.message : String(error) };
  }
}

function excerpt(value: JsonValue, length = 240): string {
  return JSON.stringify(value).slice(0, length);
}

const CreatedSchema = v.object({ name: v.string() });

const SnapshotSchema = v.object({
  name: v.string(),
  displayName: v.optional(v.string()),
  role: v.optional(v.string()),
  mission: v.optional(v.string()),
  pendingSteers: v.optional(v.array(v.unknown())),
});

const TasksSchema = v.array(v.unknown());

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
            detail: !createdAnswer.ok
              ? `createSubordinateAgent refused: ${createdAnswer.failure.slice(0, 300)}`
              : created !== null && created.success
                ? `createSubordinateAgent answered with ${JSON.stringify(created.output.name)}`
                : `createSubordinateAgent answered foreign bytes: ${excerpt(createdAnswer.value)}`,
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
            detail: !snapshotAnswer.ok
              ? `getActorSnapshot never answered: ${snapshotAnswer.failure.slice(0, 300)}`
              : snapshot !== null && snapshot.success
                ? `getActorSnapshot answered for ${JSON.stringify(snapshot.output.name)} (role `
                  + `${JSON.stringify(snapshot.output.role ?? '')})`
                : `getActorSnapshot answered foreign bytes: ${excerpt(snapshotAnswer.value)}`,
          });

          const tasksAnswer = await ask(tabSocket, 'listAgentTasks', []);
          const tasks = tasksAnswer.ok ? v.safeParse(TasksSchema, tasksAnswer.value) : null;

          subgoals.push({
            what: 'tasks-answer',
            reached: tasks !== null && tasks.success,
            detail: !tasksAnswer.ok
              ? `listAgentTasks never answered: ${tasksAnswer.failure.slice(0, 300)}`
              : tasks !== null && tasks.success
                ? `listAgentTasks answered a list of ${String(tasks.output.length)}`
                : `listAgentTasks answered foreign bytes: ${excerpt(tasksAnswer.value)}`,
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
