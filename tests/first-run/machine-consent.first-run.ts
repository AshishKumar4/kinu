/**
 * FIRST RUN: a new cloud workspace reaches for the owner's machine, first with
 * none connected and then with one.
 *
 * THE ASK (MA-041). Both consent branches of a cloud workspace's first use of
 * the owner's machine: with no machine connected, the call prompts the owner to
 * connect one; once one is connected, the workspace asks consent for it, and
 * asks nothing else.
 *
 * WHY NO OTHER ROW GUARDS THIS. device-link drives the Environment pane's RPC
 * against a machine already attached, and approve-clears and two-machines grant
 * consent before their first command. No deployed row let the agent reach for
 * a machine that was not there, or let the agent's own call raise the card.
 *
 * THE SANDBOX SWITCH (unit-device-consent.test.ts, carried here). The card
 * names the exact command it asks for; an answer of `once` binds nothing; the
 * owner's Sandbox switch on Settings → Devices turns off and on and reads back,
 * refuses a tier outside its vocabulary, answers 404 for a machine it does not
 * know, and the per-workspace consent-tier route is gone.
 *
 * NO CLOCK. The card is awaited on the broadcast the chat renders it from, and
 * each turn settles on its own done frame.
 */
import { afterAll, describe, test } from 'vitest';
import * as v from 'valibot';
import { infraBoundary, scratchDir, workerSession, type EvalObservation, type EvalSubgoal } from '@kinu.run/test-utils';
import { webHeaders } from '../../evals/src/session';
import { ORCHESTRATOR_AGENT_SLUG, type JsonValue, type RunEvent } from '../../packages/core/src/index';
import type { DeviceAccount } from './device-session';
import { attachMachine, detachMachine, type AttachedMachine } from './daemon';
import {
  FIRST_RUN_DEFECTS, firstRunCasePlan, publishFirstRunRecord, runFirstRunCase,
} from './first-run';
import { openPublicSocket } from './public-socket';
import { CONSENT_ASK as ASK } from './asks';

const SUITE = 'First-run · machine-consent';

const CASE = 'machine-consent' as const;

/** The machine this case connects halfway through. */
const MACHINE = 'kinu-first-run-consent';

/** The broadcast the chat renders a consent card from (the orchestrator's `consents` announce). */
const CONSENT_REQUESTED = 'device_consent';

/** What the refusal names when no machine is connected: where the owner connects one. */
const CONNECT_PROMPT = 'kinu connect';

const PLAN = firstRunCasePlan(SUITE, CASE);

const liveTest = test.skipIf(PLAN === null);

const observations: EvalObservation[] = [];

afterAll(() => { publishFirstRunRecord(SUITE, PLAN?.llm.model, [CASE], observations); });

type ToolCallEnd = Extract<RunEvent, { type: 'tool_call_end' }>;

function isToolCallEnd(event: RunEvent): event is ToolCallEnd {
  return event.type === 'tool_call_end';
}

/** A result as the text a reader greps: a string as-is, anything else as JSON. */
function textOf(value: JsonValue | undefined): string {
  if (value === undefined) return '';
  const text = v.safeParse(v.string(), value);

  return text.success ? text.output : JSON.stringify(value);
}

/** Every tool call of `events` whose answer asks the owner to connect a machine. */
function connectPrompts(events: readonly RunEvent[]): ToolCallEnd[] {
  return events.filter(isToolCallEnd)
    .filter((call) => `${call.error ?? ''} ${textOf(call.result)}`.includes(CONNECT_PROMPT));
}

/** The first turn's verdict, in the words a reader of the record needs. */
function firstTurnDetail(prompted: readonly ToolCallEnd[], events: readonly RunEvent[], cardWithoutMachine: boolean): string {
  if (cardWithoutMachine) return 'a consent card was raised with no machine connected';
  const [first] = prompted;

  if (first !== undefined) return `${first.name}#${first.toolCallId} answered: ${`${first.error ?? ''} ${textOf(first.result)}`.trim().slice(0, 200)}`;
  const calls = events.filter(isToolCallEnd).map((call) => `${call.name} ${(call.error ?? textOf(call.result)).slice(0, 80)}`);

  return `no call in the first turn named ${CONNECT_PROMPT}: ${calls.join('; ') || 'no tool call'}`;
}

const DeviceTiersSchema = v.array(v.looseObject({ id: v.string(), sandbox: v.looseObject({ tier: v.string() }) }));

const ConsentRowsSchema = v.array(v.looseObject({ agentName: v.string(), deviceId: v.string(), policy: v.string() }));

/** One call of the owner's Settings → Devices routes: its status and its body. */
async function userRoute(account: DeviceAccount, path: string, method = 'GET', body?: JsonValue): Promise<{ status: number; body: string }> {
  return infraBoundary(`${method} ${account.origin}/api/user${path}`, async () => {
    const headers = { ...webHeaders(account.identity), 'content-type': 'application/json' };
    const init: RequestInit = body === undefined ? { method, headers } : { method, headers, body: JSON.stringify(body) };
    const response = await fetch(`${account.origin}/api/user${path}`, init);

    return { status: response.status, body: await response.text() };
  });
}

/** The Sandbox switch of `deviceId` as the Devices page reads it, or what the read answered instead. */
async function sandboxTier(account: DeviceAccount, deviceId: string): Promise<string> {
  const read = await userRoute(account, '/devices');
  const rows = read.status === 200 ? v.safeParse(DeviceTiersSchema, JSON.parse(read.body)) : null;

  return rows?.success === true ? rows.output.find((row) => row.id === deviceId)?.sandbox.tier ?? 'unlisted' : `HTTP ${String(read.status)}`;
}

/** The switch turned off and on and read back each time, a bad tier and an unknown machine refused, the tier route gone. */
async function sandboxSwitch(account: DeviceAccount, deviceId: string, workspace: string): Promise<EvalSubgoal[]> {
  const path = `/devices/${encodeURIComponent(deviceId)}/sandbox`;
  const off = await userRoute(account, path, 'PUT', { tier: 'raw' });
  const readOff = await sandboxTier(account, deviceId);
  const on = await userRoute(account, path, 'PUT', { tier: 'sandboxed' });
  const readOn = await sandboxTier(account, deviceId);
  const refused = await Promise.all(['files_only', 'root_of_everything', ''].map(async (tier) => (await userRoute(account, path, 'PUT', { tier })).status));
  const kept = await sandboxTier(account, deviceId);
  const unknown = await userRoute(account, '/devices/dev-nope/sandbox', 'PUT', { tier: 'raw' });
  const tierRoute = await userRoute(account, `/devices/${encodeURIComponent(deviceId)}/consent`, 'PUT', { agentName: workspace, scope: 'full_filesystem' });

  return [
    {
      what: 'sandbox-switch-reads-back',
      reached: off.status === 200 && readOff === 'raw' && on.status === 200 && readOn === 'sandboxed',
      detail: `off ${String(off.status)} read ${readOff}; on ${String(on.status)} read ${readOn}`,
    },
    {
      what: 'sandbox-switch-refuses-what-it-does-not-know',
      reached: refused.every((status) => status === 400) && kept === 'sandboxed' && unknown.status === 404 && tierRoute.status === 404,
      detail: `bad tiers ${refused.join(',')} kept ${kept}; unknown machine ${String(unknown.status)}; consent-tier route ${String(tierRoute.status)}`,
    },
  ];
}

/** What this case connected and must put away. */
interface CaseState {
  machine: AttachedMachine | null;
}

describe(SUITE, () => {
  liveTest(`MEASURED: ${CASE}`, async () => {
    if (PLAN === null) throw new Error('unreachable: this arm is gated on a resolved plan');

    const account: DeviceAccount = { origin: PLAN.origin, cliToken: workerSession(PLAN.llm).token, identity: PLAN.identity };
    const held: CaseState = { machine: null };

    try {
      await runFirstRunCase(PLAN, {
        id: CASE,
        modelCalls: 'expected',
        genesis: false,
        purpose: 'An assistant that uses the owner\'s own machine when asked to.',
        async run({ session, plan, budget }) {
          const subgoals: EvalSubgoal[] = [];
          const socket = openPublicSocket(plan.origin, plan.identity, `/agents/${ORCHESTRATOR_AGENT_SLUG}/${encodeURIComponent(session.workspace)}`, budget);

          try {
            if (!(await socket.opened)) {
              subgoals.push({ what: 'prompted-to-connect', reached: false, detail: `${socket.path} refused the upgrade` });

              return subgoals;
            }

            // ── No machine: the call prompts the owner to connect one, and
            //    raises no consent card, since there is nothing to consent to. ──
            const firstTurnCard = socket.broadcast(CONSENT_REQUESTED);
            await session.prompt(ASK);

            const cardWithoutMachine = await Promise.race([firstTurnCard, Promise.resolve(false)]);
            const before = await session.runEvents();
            const prompted = connectPrompts(before);

            subgoals.push({
              what: 'prompted-to-connect',
              reached: prompted.length > 0 && !cardWithoutMachine,
              detail: firstTurnDetail(prompted, before, cardWithoutMachine),
            });

            // ── Connected: consent, and nothing else. ──
            const machine = await attachMachine({ account, name: MACHINE, home: scratchDir('first-run-consent') });
            held.machine = machine;

            const raised = socket.broadcast(CONSENT_REQUESTED);
            const turn = session.prompt(ASK);
            // A turn that ends first raised no card; one that fails fails the case.
            const cardShown = await Promise.race([raised, turn.then(() => false)]);
            const card = cardShown ? (await session.pendingConsents()).find((pending) => pending.deviceId === machine.deviceId) : undefined;
            const decided = card === undefined ? null : await session.resolveConsent(card.consentId, 'once');
            await turn;

            subgoals.push({
              what: 'consent-requested',
              reached: decided?.ok === true,
              detail: card === undefined
                ? `the second turn ${cardShown ? 'raised a card for no connected machine' : 'ended without a consent card'}`
                : `card ${card.consentId} for ${machine.name} answered once: ${JSON.stringify(decided)}`,
            });

            // The card names the command itself, so the owner consents to what will run, not to a tool name.
            subgoals.push({
              what: 'card-names-the-command',
              reached: card !== undefined && card.method === 'exec' && machine.execLog().some((ran) => card.command.includes(ran) || ran.includes(card.command)),
              detail: card === undefined ? 'no card' : `card asked to ${card.method} \`${card.command}\`; the machine ran ${JSON.stringify(machine.execLog())}`,
            });

            // `once` lets this call through and remembers nothing: the Devices page lists no binding for it.
            const consents = await userRoute(account, '/devices/consents');
            const bound = consents.status === 200 ? v.safeParse(ConsentRowsSchema, JSON.parse(consents.body)) : null;
            const binding = bound?.success === true ? bound.output.filter((row) => row.agentName === session.workspace) : null;

            subgoals.push({
              what: 'once-binds-nothing',
              reached: binding !== null && binding.length === 0,
              detail: binding === null ? `the consent listing answered ${String(consents.status)}: ${consents.body.slice(0, 200)}` : `${String(binding.length)} binding(s) for ${session.workspace}`,
            });
            subgoals.push(...await sandboxSwitch(account, machine.deviceId, session.workspace));

            const after = (await session.runEvents()).slice(before.length);
            const again = connectPrompts(after);

            subgoals.push({
              what: 'no-connect-prompt-once-connected',
              reached: again.length === 0,
              detail: again.length === 0
                ? 'no call in the second turn asked the owner to connect a machine'
                : `${again[0]?.name ?? '?'}#${again[0]?.toolCallId ?? '?'} still asked to connect`,
            });

            // What came BACK from the machine, read off the call's own result
            // rather than the model's closing prose: whether the model repeats
            // an output is its choice (a loopback run on 2026-09-23 ran
            // `hostname` on the machine and closed with an empty reply).
            const ran = machine.execLog();
            const calls = after.filter(isToolCallEnd);
            const answered = calls.find((call) => textOf(call.result).includes(machine.name));

            subgoals.push({
              what: 'command-ran-on-the-machine',
              reached: ran.length > 0 && answered !== undefined,
              detail: `${machine.name} ran \`hostname\` ${String(ran.length)} time(s); ${answered === undefined
                ? `no call in the second turn got the machine's name back: ${calls.map((call) => `${call.name} ${(call.error ?? textOf(call.result)).slice(0, 80)}`).join('; ') || 'no tool call'}`
                : `${answered.name}#${answered.toolCallId} got it back`}`,
            });

            return subgoals;
          } finally {
            socket.close('the row is done');
          }
        },
      }, observations);
    } finally {
      if (held.machine !== null) {
        const left = await detachMachine(account, held.machine);

        if (left !== null) console.warn(`    [first-run] ${CASE} teardown: ${left}`);
      }
    }
  });
});

/** The defect this case is red on, re-exported so `wiring.test.ts` can hold the
 *  corpus and the defect register equal without importing the case modules. */
export const DEFECT = FIRST_RUN_DEFECTS[CASE];
