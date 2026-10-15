/**
 * FIRST RUN: one live slate, used by its owner and a person they add, on the deployed product.
 *
 * The owner's workspace builds a slate and calls it, which publishes it to its room. The slate is not shared yet: the
 * second eval account cannot open it. The owner adds them (Edit) over the room's socket; they open the room, enter the
 * slate's own host through the ticket their view carries, see its page, and call it, writing to the same state the
 * owner's call wrote. The owner removes them: their open session is told it ended, and their next call is refused.
 * No model call.
 */
import { afterAll, describe, test } from 'vitest';
import * as v from 'valibot';
import {
  roomEntryPath, roomSocketPath, RoomEntrySchema, RoomServerFrameSchema, type RoomCall, type RoomServerFrame, type RoomView,
} from '@kinu.run/core';
import type { EvalObservation, EvalSubgoal } from '@kinu.run/test-utils';
import { firstRunCaseId, firstRunCasePlan, type FirstRunDefect, publishFirstRunRecord, runFirstRunCase } from './first-run';
import { webHeaders } from '../../evals/src/workspace-roster';
import { HEADER_WEBSOCKET } from '../../evals/src/session-protocol';

const SUITE = 'First-run · slate-room';

const CASE = firstRunCaseId(import.meta.url);

/** What this case found, and what a red here means (`FirstRunDefect`). */
const DEFECT: FirstRunDefect = {
  found: 'A shared slate ran every visitor\'s call as its owner (S2): whoever held the link reached the owner\'s connections through the slate, bounded only by a rate and a daily spend.',
  missedBecause: 'Every share proof asserted the share\'s own bounds; none asked whether a visitor\'s call should run with the owner\'s authority at all.',
  provedRedAt: null,
  redDirection: 'Green requires the slate to answer its owner\'s call, an unshared second account to be refused, the owner\'s add to let it open the room and the slate\'s host as itself and to write the same state, and the owner\'s removal to end its session and refuse its next call.',
};

const PLAN = firstRunCasePlan(SUITE, 'room');

const liveTest = test.skipIf(PLAN === null);

const observations: EvalObservation[] = [];

afterAll(async () => { await publishFirstRunRecord(SUITE, PLAN?.llm.model, [CASE], observations); });

const Exec = v.object({ stdout: v.optional(v.string()), exitCode: v.optional(v.number()), error: v.optional(v.string()) });

const Profile = v.object({ email: v.string() });

const Called = v.object({ ok: v.literal(true), value: v.object({ value: v.unknown() }) });

const SLATE = 'roomprobe';

const BODY = 'room-probe-ok';

/** A room socket: calls answered by id, and every view the room pushed. */
interface RoomSocket {
  call(call: RoomCall): Promise<RoomServerFrame>;
  /** The first view the room pushed that `holds`; the case's own deadline bounds the wait. */
  view(holds: (view: RoomView) => boolean): Promise<RoomView>;
  close(): void;
}

function openRoom(origin: string, headers: Readonly<Record<string, string>>, path: string): Promise<RoomSocket> {
  const url = new URL(path, origin);

  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new HEADER_WEBSOCKET(url.toString(), { headers: { ...headers } });
  const views: RoomView[] = [];
  const answers = new Map<number, (frame: RoomServerFrame) => void>();
  const waiting = new Set<() => void>();
  let next = 0;

  socket.addEventListener('message', (event: MessageEvent) => {
    const frame = v.parse(RoomServerFrameSchema, JSON.parse(String(event.data)));

    if ('view' in frame) views.push(frame.view);
    else answers.get(frame.id)?.(frame);

    for (const wake of waiting) wake();
  });

  const opened = Promise.withResolvers<RoomSocket>();

  socket.addEventListener('error', () => { opened.reject(new Error(`The room socket at ${path} failed`)); });
  socket.addEventListener('open', () => {
    opened.resolve({
      call: async (call) => {
        const answered = Promise.withResolvers<RoomServerFrame>();
        const id = next++;

        answers.set(id, answered.resolve);
        socket.send(JSON.stringify({ id, call }));

        return await answered.promise;
      },
      view: async (holds) => {
        for (;;) {
          const found = views.find(holds);

          if (found !== undefined) return found;
          // The next frame the room pushes.
          const woken = Promise.withResolvers<void>();
          const done = () => { waiting.delete(done); woken.resolve(); };

          waiting.add(done);
          await woken.promise;
        }
      },
      close: () => { socket.close(); },
    });
  });

  return opened.promise;
}

const PROBE_SOURCE = `mkdir -p /slates/${SLATE}
cat > /slates/${SLATE}/package.json <<'END'
{"main":"server.ts","slate":{"title":"Room probe"}}
END
cat > /slates/${SLATE}/server.ts <<'END'
import { SlateObject } from "kinu:slate";
export class Slate extends SlateObject {
  async add(who) {
    const people = (await this.storage.get("people")) ?? [];
    people.push(who);
    await this.storage.put("people", people);
    return people.length;
  }
  async fetch() { return new Response("${BODY}"); }
}
END`;

/** The room as its pieces are reached from the app's origin. */
interface Room {
  readonly origin: string;
  readonly workspace: string;
  entry(headers: Record<string, string>): Promise<Response>;
  socket(headers: Record<string, string>): Promise<RoomSocket>;
}

/** A session on the slate's own host: entered through its view's ticket, its calls under the cookie that sets. */
interface HostSession {
  readonly entered: number | null;
  readonly page: number | null;
  readonly body: string | null;
  call(method: string, args: unknown[]): Promise<Response | null>;
}

async function enterHost(view: RoomView): Promise<HostSession> {
  const frame = view.session.frame;
  const entered = frame === '' ? null : await fetch(frame, { redirect: 'manual' });
  const cookie = entered?.headers.get('set-cookie')?.split(';')[0] ?? null;
  const host = frame === '' ? '' : new URL(frame).origin;
  const page = cookie === null ? null : await fetch(`${host}/`, { headers: { cookie } });

  return {
    entered: entered?.status ?? null, page: page?.status ?? null, body: page === null ? null : await page.text(),
    call: async (method, args) => cookie === null ? null : await fetch(`${host}/__kinu/call`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ method, args }),
    }),
  };
}

/** The added person uses the slate, then the owner removes them: what each saw. */
async function usedThenRemoved(room: Room, owner: RoomSocket, people: { recipient: Record<string, string>; email: string }): Promise<EvalSubgoal[]> {
  const member = await room.socket(people.recipient);

  try {
    const host = await enterHost(await member.view((each) => each.session.frame !== ''));
    const call = await host.call('add', ['member']);
    const called = call === null ? null : v.safeParse(Called, await call.json());

    const used: EvalSubgoal = {
      what: 'added-person-uses-the-same-slate',
      reached: host.page === 200 && host.body === BODY && called?.success === true && called.output.value.value === 2,
      detail: JSON.stringify({ entered: host.entered, page: host.page, body: host.body?.slice(0, 80) ?? null, call: call?.status ?? null }),
    };

    await owner.call({ op: 'remove', email: people.email });
    const ended = await member.view((each) => each.ended !== null);
    const after = await host.call('add', ['again']);
    const afterEntry = await room.entry(people.recipient);

    return [used, {
      what: 'removed-person-is-ended', reached: ended.ended?.kind === 'removed' && after?.status === 403 && afterEntry.status === 403,
      detail: JSON.stringify({ ended: ended.ended, call: after?.status ?? null, entry: afterEntry.status }),
    }];
  } finally {
    member.close();
  }
}

async function sharedAndUsed(room: Room, headers: { owner: Record<string, string>; recipient: Record<string, string> }, email: string): Promise<EvalSubgoal[]> {
  const owner = await room.socket(headers.owner);

  try {
    const added = await owner.call({ op: 'invite', email, role: 'edit' });
    const memberEntry = await room.entry(headers.recipient);
    const opened = memberEntry.ok ? v.parse(RoomEntrySchema, await memberEntry.json()) : null;

    const admitted: EvalSubgoal = {
      what: 'added-person-opens', reached: 'id' in added && added.refusal === null && opened?.access === 'edit',
      detail: JSON.stringify({ added, entry: memberEntry.status, access: opened?.access ?? null }),
    };

    return [admitted, ...await usedThenRemoved(room, owner, { recipient: headers.recipient, email })];
  } finally {
    await owner.call({ op: 'remove', email });
    owner.close();
  }
}

describe(SUITE, () => {
  liveTest(`MEASURED: ${CASE}`, async () => {
    if (PLAN === null) throw new Error('unreachable: this arm is gated on a resolved plan');
    await runFirstRunCase(PLAN, {
      id: CASE, defect: DEFECT, modelCalls: 'none', genesis: false,
      purpose: 'A slate shared with a second account in its room, used together, then the person removed; no model task.',
      async run({ session, plan }) {
        const owner = webHeaders(plan.identity);
        const recipient = webHeaders({ ...plan.identity, account: 'devices' });

        const room: Room = {
          origin: plan.origin, workspace: session.workspace,
          entry: async (headers) => await fetch(`${plan.origin}${roomEntryPath(session.workspace, SLATE)}`, { headers }),
          socket: async (headers) => await openRoom(plan.origin, headers, roomSocketPath(session.workspace, SLATE)),
        };

        const setup = v.parse(Exec, await session.execute('workspace', PROBE_SOURCE));

        if ((setup.exitCode ?? 1) !== 0) throw new Error('Could not author the probe slate: ' + (setup.error ?? setup.stdout ?? ''));
        const { email } = v.parse(Profile, await (await fetch(`${plan.origin}/api/user/profile`, { headers: recipient })).json());
        const first = await session.slateOp({ op: 'call', id: SLATE, method: 'add', args: ['owner'] });
        const ownerEntry = await room.entry(owner);
        const ownerOpened = ownerEntry.ok ? v.parse(RoomEntrySchema, await ownerEntry.json()) : null;
        const strangerEntry = await room.entry(recipient);

        return [
          { what: 'owner-call-publishes', reached: JSON.stringify(first) === JSON.stringify(1), detail: JSON.stringify(first).slice(0, 200) },
          {
            what: 'unshared-is-refused', reached: ownerOpened?.access === 'owner' && strangerEntry.status === 403,
            detail: JSON.stringify({ owner: ownerEntry.status, access: ownerOpened?.access ?? null, recipient: strangerEntry.status }),
          },
          ...await sharedAndUsed(room, { owner, recipient }, email),
        ];
      },
    }, observations);
  });
});
