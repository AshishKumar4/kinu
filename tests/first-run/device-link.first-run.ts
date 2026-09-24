/**
 * FIRST RUN: a linked machine STAYS linked, runs a command, and revokes clean.
 *
 * THE DEFECT. The owner connected a machine and every socket dropped about
 * forty seconds in: the daemon's keepalive (`packages/pc-agent/src/index.js`,
 * PING_FRAME thirty seconds after open, PONG_DEADLINE_MS ten after that)
 * is a bare `ping` text frame the deployed hub never answers, so the daemon
 * closes its own live socket and redials. Every redial writes a fresh
 * `connected_at` on the device row (`acceptDeviceSocket` stamps it on every
 * accept), and a workspace call that lands in the gap between close and
 * redial is answered "needs a computer of yours" — a card the connecting
 * daemon never retires, because nothing does.
 *
 * WHY EVERY GATE STAYED GREEN. Every device test attaches a fake daemon or
 * drives `connectDevice` until the first `connected` and stops there: the
 * link is asserted at the moment it forms and never forty seconds later, so
 * a hub that cannot answer `ping` is invisible to all of them. The fixture
 * could express "connected" and could not express "STILL connected on the
 * same socket".
 *
 * THE THREE CASES share one defect row — `device-link` — because they are one
 * link's lifetime: it must HOLD, it must RUN a command through the real
 * consent card, and it must END on revoke. Each case attaches its own real
 * daemon — the shipped `packages/pc-agent/src/index.js` under this repo's
 * bun, with a device.json minted by the same `POST /api/cli/devices`
 * registration `kinu connect` performs — because a case that borrows a
 * sibling's machine is measuring the sibling's socket age, not the link.
 *
 * WHAT "HELD" CAN BE READ AS. The routes do not serve `connected_at` itself;
 * they serve `lastSeenAt`, which the same `UPDATE` stamps on every accept,
 * plus `replacedAt` (set when a second socket takes a LIVE slot) and
 * `connected` (the hub's own socket check). A redial is therefore read as a
 * NEW `lastSeenAt` — always written, never sampled — with `replacedAt` as
 * the second accept's own mark and `connected` polled through the gap.
 */
import { afterAll, describe, test } from 'vitest';

import { scratchDir, workerSession, type EvalObservation, type EvalSubgoal } from '@kinu.run/test-utils';
import {
  listDevicesOverCliRoute, revokeDeviceOverUserRoute,
  type DeviceAccount, type DeviceListing, type DeviceRow,
} from './device-session';
import type { KinuPublicSession, PublicExecutorResult, PublicSessionPlan } from '../../evals/src/session';
import { attachMachine, detachMachine, readDaemonLogTail, type AttachedMachine } from './daemon';
import { firstRunCasePlan, publishFirstRunRecord, runFirstRunCase } from './first-run';

const SUITE = 'First-run · device-link';

const CASE = 'device-link' as const;

/**
 * The machine label this row registers under. The fleet resolves calls by
 * LABEL, so the case's commands name this string the way the owner would tap
 * it in the consent card — and the daemon's staged `hostname` shim prints it
 * back, which is how a command proves it ran on THIS machine: the shim leads
 * the PATH inside whatever sandbox the hub chose (measured on the deployed
 * build: `~/.local/bin` precedes the sandboxed PATH as well as the raw one),
 * so any other answer — this box's name, another machine's — is the finding.
 */
const MACHINE = 'kinu-first-run-link';

/**
 * The window a link must hold for the defect to fire. The daemon pings at
 * +30 s and closes at +40 s on a hub that never pongs, so fifty seconds sees
 * a whole redial on the broken build — and is the dead time "held" costs to
 * measure on a fixed one.
 */
const HOLDS_WINDOW_MS = 50_000;

/** How often the device list is re-read inside the window. */
const HOLDS_POLL_MS = 500;

/**
 * The consent card's own lifetime — the registry's five-minute window
 * (`DeviceConsentRegistry`), which is also the parked caller's. The case
 * polls inside it rather than beside it, so "the card was never raised" is a
 * finding, not a hang.
 */
const CONSENT_WINDOW_MS = 300_000;

const CARD_POLL_MS = 500;

const WARMUP_RETRY_MS = 1_000;

/**
 * The workspace's transport snapshot can trail the device list: the first
 * `executeInExecutor('device', …)` on a fresh workspace can answer "not
 * available" while its status refresh is still in flight. A person sees it
 * once and their next click works; the case retries on the same words
 * `grantDeviceAccess` treats as warm-up, because a refusal still warm-up
 * after the card window is unreachable with its own words, not a defect
 * about the link.
 */
const WARMUP_WORDS = /not available|no device connected|not known here yet|no connected machine is named/i;

/**
 * The daemon's own exit status for a credential the hub will not take again.
 * `REJECTED_EXIT` lives in the shipped daemon, which is dependency-free and
 * exports it nowhere; the value is what this case asserts, so it is written
 * here with its name.
 */
const DAEMON_REJECTED_EXIT = 4;

const PLAN = firstRunCasePlan(SUITE, CASE);

const liveTest = test.skipIf(PLAN === null);

const observations: EvalObservation[] = [];

afterAll(() => { publishFirstRunRecord(SUITE, PLAN?.llm.model, [CASE], observations); });

/**
 * The account a device case acts with: the eval-service identity on both of
 * the planes the product splits it across — the CLI bearer for registration
 * and the device list, the web identity for the owner route that revokes.
 */
function evalAccount(plan: PublicSessionPlan): DeviceAccount {
  return { origin: plan.origin, cliToken: workerSession(plan.llm).token, identity: plan.identity };
}

/** The row the deployment reports for a device, or a failure that carries
 *  the route's own words. A row the account cannot show is the finding. */
function requireRow(listing: DeviceListing, deviceId: string): DeviceRow {
  const row = listing.rows?.find((device) => device.id === deviceId);

  if (row === undefined) {
    throw new Error(`the devices route answered ${String(listing.status)} without ${deviceId} `
      + `in it — ${listing.body.slice(0, 400)}`);
  }

  return row;
}

/** Poll the devices route until `seen` holds or the window ends; answers the
 *  row's last reading either way so the caller's detail line carries the
 *  deployment's own state. */
async function pollDevice(
  account: DeviceAccount, deviceId: string, windowMs: number,
  seen: (row: DeviceRow | null) => boolean,
): Promise<DeviceRow | null> {
  const deadline = Date.now() + windowMs;
  let last: DeviceRow | null = null;

  for (;;) {
    const listing = await listDevicesOverCliRoute(account);
    last = listing.rows?.find((device) => device.id === deviceId) ?? null;

    if (seen(last)) return last;

    if (Date.now() >= deadline) return last;

    const tick = Promise.withResolvers<void>();
    setTimeout(tick.resolve, HOLDS_POLL_MS);
    await tick.promise;
  }
}

/**
 * Wait out the connect flurry. `acceptDeviceSocket` stamps `last_seen_at`
 * once, and the rotation ACK stamps it again when the daemon writes the new
 * token — both inside the first seconds of a healthy link. The hold window
 * measures from the first STABLE reading, so a late ACK cannot read as a
 * redial and a genuine redial can never be explained as one.
 */
async function stableLinkBaseline(account: DeviceAccount, deviceId: string): Promise<DeviceRow> {
  const deadline = Date.now() + 15_000;

  let last = await pollDevice(account, deviceId, 15_000,
    (row) => row?.connected === true && row.lastSeenAt !== null);

  if (last === null || last.lastSeenAt === null) {
    throw new Error('the device never read connected with a seen stamp — the link never formed');
  }

  for (;;) {
    const tick = Promise.withResolvers<void>();
    setTimeout(tick.resolve, 1_500);
    await tick.promise;

    const next = requireRow(await listDevicesOverCliRoute(account), deviceId);

    if (next.lastSeenAt === last.lastSeenAt) return next;
    last = next;

    if (Date.now() >= deadline) {
      throw new Error('the device\'s lastSeenAt kept moving for 15 s after connect — '
        + 'the link never settled');
    }
  }
}

interface DeviceCommandRun {
  /** The executor's answer, whole — refusal fields included, since which one
   *  it answered on is the finding. */
  readonly result: PublicExecutorResult;
  /** The consent card this run answered `once`, or null when the call settled
   *  without one (a remembered grant, or a refusal raised before it). */
  readonly cardId: string | null;
}

/**
 * One `executeInExecutor('device', command, machine)` driven the way the Env
 * pane drives it — over the workspace's own socket — while the consent card
 * it raises is answered `once` through `resolveDeviceConsent`, the RPC the
 * card's button calls (use-kinu.ts).
 *
 * THE ORDER IS THE FLOW BEING PROVED: the call PARKS on the card
 * (`awaitDeviceConsent`), so it is fired detached; the card is then polled
 * off `listPendingConsents` and resolved, which is what unblocks the call. A
 * call that settles WITHOUT a card is one of two things and the loop treats
 * them as such: warm-up (retried inside the window) or an answer to report
 * verbatim.
 */
async function runDeviceCommand(
  session: KinuPublicSession, machine: AttachedMachine, command: string,
): Promise<DeviceCommandRun> {
  const deadline = Date.now() + CONSENT_WINDOW_MS;
  let cardId: string | null = null;

  for (;;) {
    // The settlement flag lives on an object so the poll loop reads what the
    // socket actually did rather than what control flow can prove about a
    // `let` assigned inside a `.then` — TypeScript narrows that to never.
    const landed = { done: false };
    const call = session.execute('device', command, machine.name);
    void call.then(() => { landed.done = true; }, () => { landed.done = true; });

    while (!landed.done && Date.now() < deadline) {
      const card = (await session.pendingConsents())
        .find((pending) => pending.deviceId === machine.deviceId && pending.consentId !== cardId);

      if (card !== undefined) {
        const decided = await session.resolveConsent(card.consentId, 'once');

        if (!decided.ok) {
          throw new Error(`the consent card ${card.consentId} was already settled — `
            + 'the answer the case is proving never landed');
        }

        cardId = card.consentId;
        break;
      }

      const tick = Promise.withResolvers<void>();
      setTimeout(tick.resolve, CARD_POLL_MS);
      await tick.promise;
    }

    // The call's own verdict is always awaited — a parked call that outlived
    // the window gets a grace, then the case reports the park rather than
    // abandoning the frame.
    const finished = await Promise.race([
      call.then(() => true, () => true),
      new Promise<false>((resolve) => { setTimeout(() => resolve(false), 5_000); }),
    ]);

    if (!finished) {
      throw new Error(`the device call stayed parked past the consent window${cardId === null
        ? ' and never raised its card' : ` past its answered card ${cardId}`}`);
    }

    // A socket-level failure throws here with its own words; a refusal or an
    // answer arrives as the result, which the caller reports verbatim.
    const result = await call;
    const words = result.error ?? result.stdout ?? result.refusal?.error ?? '';

    if (!WARMUP_WORDS.test(words) || Date.now() >= deadline) {
      return { result, cardId };
    }

    const tick = Promise.withResolvers<void>();
    setTimeout(tick.resolve, WARMUP_RETRY_MS);
    await tick.promise;
  }
}

/** Detach in teardown order: stop the daemon, then revoke the row, then
 *  remove the home — every step unconditional, a failure reported rather
 *  than thrown over the case's own. */
async function putAway(account: DeviceAccount, machine: AttachedMachine | null): Promise<void> {
  if (machine === null) return;

  const left = await detachMachine(account, machine);

  if (left !== null) console.warn(`    [first-run] ${CASE} teardown: ${left}`);
}

describe(SUITE, () => {
  liveTest('device-link-holds', async () => {
    if (PLAN === null) throw new Error('unreachable: this arm is gated on a resolved plan');

    const account = evalAccount(PLAN);
    let machine: AttachedMachine | null = null;

    try {
      await runFirstRunCase(PLAN, {
        id: CASE,
        episode: 'device-link-holds',
        modelCalls: 'none',
        genesis: false,
        purpose: 'A probe proving a linked machine stays linked past the keepalive window.',
        async run() {
          // Read BEFORE this machine registers, so a failing route is the route's own: on
          // 2026-09-01 `kinu connect` failed on two machines because this list answered 500,
          // SELECTing `unstopped_at` from a table created before the column existed.
          const before = await listDevicesOverCliRoute(account);

          machine = await attachMachine({
            account, name: MACHINE, home: scratchDir(`first-run-${CASE}-holds`),
          });
          const attached = machine;

          const baseline = await stableLinkBaseline(account, attached.deviceId);
          const seenAt = baseline.lastSeenAt;

          let last: DeviceRow = baseline;
          let disconnects = 0;
          let rewrites = 0;
          const deadline = Date.now() + HOLDS_WINDOW_MS;

          while (Date.now() < deadline) {
            const tick = Promise.withResolvers<void>();
            setTimeout(tick.resolve, HOLDS_POLL_MS);
            await tick.promise;

            last = requireRow(await listDevicesOverCliRoute(account), attached.deviceId);

            if (!last.connected) disconnects += 1;

            if (last.lastSeenAt !== seenAt) rewrites += 1;
          }

          const reading = JSON.stringify({
            seenAt, after: last.lastSeenAt, disconnects, rewrites,
            replacedAt: last.replacedAt, connected: last.connected,
          });

          return [
            { what: 'link-stays-connected', reached: last.connected && disconnects === 0,
              detail: `50 s inside the keepalive window: ${disconnects} disconnected reading(s), `
                + `ends connected=${String(last.connected)} — ${reading}` },
            // THE RED LINE. A hub that cannot answer `ping` forces the redial
            // at +40 s, and `acceptDeviceSocket` stamps a fresh seen time on
            // the accept — so this subgoal is the defect in one comparison.
            { what: 'no-second-accept', reached: rewrites === 0 && last.lastSeenAt === seenAt,
              detail: `lastSeenAt went ${String(seenAt)} → ${String(last.lastSeenAt)} across `
                + `${String(rewrites)} accept(s) — each one is a socket the daemon closed `
                + 'itself because no pong came' },
            { what: 'no-socket-takeover', reached: last.replacedAt === null,
              detail: `replacedAt is ${JSON.stringify(last.replacedAt)} — a second socket `
                + 'landing on a live slot would have stamped it' },
            { what: 'devices-route-answers', reached: before.status === 200 && before.rows !== null,
              detail: `GET /api/cli/devices before registering answered ${String(before.status)}: ${before.body}` },
          ] satisfies EvalSubgoal[];
        },
      }, observations);
    } finally {
      await putAway(account, machine);
    }
  });

  liveTest('device-link-command', async () => {
    if (PLAN === null) throw new Error('unreachable: this arm is gated on a resolved plan');

    const account = evalAccount(PLAN);
    let machine: AttachedMachine | null = null;

    try {
      await runFirstRunCase(PLAN, {
        id: CASE,
        episode: 'device-link-command',
        modelCalls: 'none',
        genesis: false,
        purpose: 'A probe proving one command reaches a linked machine through the consent card.',
        async run({ session }) {
          machine = await attachMachine({
            account, name: MACHINE, home: scratchDir(`first-run-${CASE}-command`),
          });
          const attached = machine;

          // The command is the round-trip: a marker this file minted plus the
          // machine's own `hostname`, which the daemon's PATH resolves to the
          // shim the attach staged — the shim prints the registration label
          // from inside whatever sandbox the hub chose, so the answer names
          // the machine by its own hand.
          const marker = 'KINU_DEVICE_LINK_ROUNDTRIP';
          const want = `${marker} ${MACHINE}`;

          const run = await runDeviceCommand(session, attached,
            `printf '%s %s\\n' ${marker} "$(hostname)"`);

          const ran = run.result.exitCode === 0 && run.result.refusal === undefined
            && run.result.error === undefined && run.result.stdout?.trim() === want;

          return [
            { what: 'consent-card-answered-once', reached: run.cardId !== null,
              detail: run.cardId === null
                ? 'no bind card was ever raised for this workspace — the command ran without '
                  + 'the consent the product requires, or refused before reaching it'
                : `the workspace's bind card ${run.cardId} was raised and answered 'once' ` +
                  'through the RPC its own button calls' },
            { what: 'command-ran-on-the-machine', reached: ran,
              detail: `expected ${JSON.stringify(want)} — the machine's own name by its own `
                + `hand; the executor answered ${JSON.stringify(run.result)}` },
          ] satisfies EvalSubgoal[];
        },
      }, observations);
    } finally {
      await putAway(account, machine);
    }
  });

  liveTest('device-link-revoke', async () => {
    if (PLAN === null) throw new Error('unreachable: this arm is gated on a resolved plan');

    const account = evalAccount(PLAN);
    let machine: AttachedMachine | null = null;

    try {
      await runFirstRunCase(PLAN, {
        id: CASE,
        episode: 'device-link-revoke',
        modelCalls: 'none',
        genesis: false,
        purpose: 'A probe proving revoke ends a link: the socket dies, the credential dies.',
        async run() {
          machine = await attachMachine({
            account, name: MACHINE, home: scratchDir(`first-run-${CASE}-revoke`),
          });
          const attached = machine;

          const answer = await revokeDeviceOverUserRoute(account, attached.deviceId);

          // Revocation closes the socket (`_devices.close`), the daemon's own
          // retry then fails the ticket exchange, and the process exits with
          // the rejected-credential status rather than dialling a dead secret
          // forever. Both halves are read from the machine itself: the exit
          // status is the process's own verdict and the log tail its own words.
          const code = await Promise.race([
            attached.exited,
            new Promise<number | null>((resolve) => { setTimeout(() => resolve(null), 20_000); }),
          ]);

          const tail = readDaemonLogTail(`${attached.home}/pc-agent.log`);

          const row = await pollDevice(account, attached.deviceId, 10_000,
            (entry) => entry === null || !entry.connected || entry.revokedAt !== null);

          return [
            { what: 'revoke-answered', reached: answer.status === 200,
              detail: `DELETE /api/user/devices/${attached.deviceId} → ${String(answer.status)} `
                + answer.body.slice(0, 300) },
            { what: 'daemon-told-the-truth', reached: code === DAEMON_REJECTED_EXIT
                && tail.includes('device credentials were rejected'),
              detail: `exit ${String(code)} — the daemon's rejected-credential status is `
                + `${String(DAEMON_REJECTED_EXIT)}; its log ends: ${JSON.stringify(tail)}` },
            { what: 'device-shows-gone', reached: row === null || !row.connected
                || row.revokedAt !== null,
              detail: `the devices route now reads the row as ${JSON.stringify(row)}` },
          ] satisfies EvalSubgoal[];
        },
      }, observations);
    } finally {
      await putAway(account, machine);
    }
  });
});
