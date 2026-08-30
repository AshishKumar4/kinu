/**
 * The device chokepoint when the machine on the other end misbehaves.
 *
 * `UserDO` is the durable authority over every command running on a user's
 * computer: it holds the row a cancellation is resolved against, counts the
 * commands a revoked device left unaccounted for, and tells the owner what
 * happened. Every input to that authority arrives over a socket from a program
 * this side does not run, so each claim below is about what the authority may
 * NOT be talked into:
 *
 *   1. A machine that answers a cancellation for some other command has
 *      confirmed nothing, and the request stays live work.
 *   2. A command whose result was held past its own cancellation publishes
 *      nothing afterwards — no row, no frame, no acknowledgement.
 *   3. Revoking CONSENT is not a stop. It decides what may start next;
 *      revoking the DEVICE is what ends what is already running.
 *
 * The far end here answers on the test's schedule rather than immediately,
 * because these are all orderings a real machine produces and an
 * always-immediate double cannot express.
 */
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { testOwner, type DeviceFrame } from './helpers/user-do';
import {
  WORKSPACE, daemon, deviceHarness, type DeviceHarness, type DeviceResponder,
} from './helpers/device-harness';
import {
  DEVICE_CANCEL_METHOD, DEVICE_CANCEL_MISPAIRED, DEVICE_CANCEL_PROTOCOL,
  DEVICE_CONSENT_DENIED, DEVICE_EXEC_ACK_METHOD,
  TUNNEL_DISCONNECTED, nextDeviceRequestId, type JsonValue,
} from '@kinu.run/core';

const TURN = 'turn-1';
const RequestRowSchema = v.object({
  cancel_outcome: v.nullable(v.string()),
  cancel_claim: v.nullable(v.string()),
});
const UnstoppedRowSchema = v.object({ unstopped_at: v.nullable(v.number()) });

/**
 * Wait until the device has actually been asked `method`, so a test acts on a
 * command that is genuinely in flight rather than on one it hopes is.
 *
 * Each hop is one event-loop turn, never a delay: the harness answers frames
 * in-process, so the wait ends on the frame and nothing here reads the clock.
 */
async function asked(harness: DeviceHarness, method: string): Promise<void> {
  for (let hop = 0; hop < 100; hop += 1) {
    if (harness.deviceFrames.some((frame) => frame.method === method)) return;
    const { promise, resolve } = Promise.withResolvers<void>();
    setImmediate(resolve);
    await promise;
  }
  throw new Error(`the device was never asked to ${method}`);
}

/** What each `method` frame was asked ABOUT — the command or request id the
 *  device was told to act on. */
function askedAbout(harness: DeviceHarness, method: string): JsonValue[] {
  return harness.deviceFrames.filter((frame) => frame.method === method).map((frame) => frame.params[0]);
}

function requestRow(
  harness: DeviceHarness, requestId: string,
): v.InferOutput<typeof RequestRowSchema> | undefined {
  const row = harness.db.prepare(
    `SELECT cancel_outcome, cancel_claim FROM device_inflight_requests WHERE request_id = ?`,
  ).all(requestId)[0];
  return row === undefined ? undefined : v.parse(RequestRowSchema, row);
}

/**
 * A machine whose commands finish when this test says so.
 *
 * `exec` is withheld until `release` is called, which is what puts a completion
 * on the far side of its own cancellation. Everything else answers like the
 * daemon.
 */
function holdingDaemon() {
  const held = Promise.withResolvers<JsonValue>();
  const responder: DeviceResponder =
    (frame) => (frame.method === 'exec' ? held.promise : daemon(frame));
  return {
    responder,
    release: () => held.resolve({ stdout: 'built', stderr: '', exitCode: 0 }),
  };
}

/** Start one durable workspace command. The turn identity makes it a row a
 *  Stop can sweep, exactly as a real turn's exec does. */
function runCommand(harness: DeviceHarness, requestId: string, command = 'bun run build'): Promise<string | undefined> {
  return harness.userDO.deviceRpc(harness.workspace, 'exec', [command], {
    agentName: WORKSPACE,
    requestId,
    checkpoint: { agent: WORKSPACE, turnId: TURN, sessionId: 'session-1', dir: null },
  });
}

/** A machine that claims a kill while naming a command nobody asked about.
 *  Believing it would settle — and delete — a row whose processes are still
 *  running on the user's own computer. */
function mispairingDaemon(frame: DeviceFrame): JsonValue {
  if (frame.method === DEVICE_CANCEL_METHOD) {
    return { requestId: 'rpc-elsewhere0-4', cancelled: 'terminated' };
  }
  return daemon(frame);
}

describe('a device that answers a cancellation for another command', () => {
  test('confirms nothing, keeps the request live, and is counted as unstopped', async () => {
    const harness = await deviceHarness('ashish@studio', mispairingDaemon);
    const requestId = nextDeviceRequestId();
    harness.db.prepare(
      `INSERT INTO device_inflight_requests (request_id, device_id, workspace, turn_id)
       VALUES (?, ?, ?, ?)`,
    ).run(requestId, harness.deviceId, WORKSPACE, TURN);

    const outcomes = await harness.userDO.cancelDeviceRequestsForTurn(harness.workspace, TURN);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].outcome).toBe('failed');
    expect(outcomes[0].detail).toContain(DEVICE_CANCEL_MISPAIRED);

    // Still live work: no stored answer, no claim, so the next sweep asks again.
    expect(requestRow(harness, requestId))
      .toEqual({ cancel_outcome: null, cancel_claim: null });
    // And the terminal authority counts it for the owner rather than reporting a
    // clean revocation over commands nobody confirmed stopped.
    expect(await harness.userDO.revokeDevice(await testOwner(), harness.deviceId))
      .toEqual({ ok: true, unstoppedCommands: 1 });
    expect(v.parse(UnstoppedRowSchema, harness.db.prepare(
      `SELECT unstopped_at FROM user_devices WHERE id = ?`,
    ).all(harness.deviceId)[0]).unstopped_at).not.toBeNull();
    await harness.closeDeviceHarness();
  });

  test('is not stored as this request\'s answer on the tool\'s own abort path', async () => {
    // The same lie down the path a tool aborting its own exec uses. The forward
    // must fail rather than hand back an answer about another command.
    const harness = await deviceHarness('ashish@studio', mispairingDaemon);
    const requestId = nextDeviceRequestId();
    harness.db.prepare(
      `INSERT INTO device_inflight_requests (request_id, device_id, workspace, turn_id)
       VALUES (?, ?, ?, ?)`,
    ).run(requestId, harness.deviceId, WORKSPACE, TURN);

    await expect(harness.userDO.deviceRpc(
      harness.workspace, DEVICE_CANCEL_METHOD, [requestId, DEVICE_CANCEL_PROTOCOL],
      { agentName: WORKSPACE },
    )).rejects.toThrow(DEVICE_CANCEL_MISPAIRED);
    expect(requestRow(harness, requestId)?.cancel_outcome).toBeNull();
    await harness.closeDeviceHarness();
  });
});

describe('a completion held past its own cancellation', () => {
  test('publishes no row, frame or acknowledgement after the request settled', async () => {
    const { responder, release } = holdingDaemon();
    const harness = await deviceHarness('ashish@studio', (frame) => {
      // The command had already finished on the machine when the stop arrived,
      // so the daemon holds no control entry for it: the completion boundary.
      if (frame.method === DEVICE_CANCEL_METHOD) {
        return { requestId: String(frame.params[0]), cancelled: 'unknown' };
      }
      return responder(frame);
    });
    harness.consentDecision = 'always';
    const requestId = nextDeviceRequestId();

    const running = runCommand(harness, requestId);
    await asked(harness, 'exec');

    expect(await harness.userDO.cancelDeviceRequestsForTurn(harness.workspace, TURN))
      .toEqual([{ requestId, outcome: 'unknown' }]);
    // The sweep released the daemon's retained supervisor and dropped the row.
    expect(askedAbout(harness, DEVICE_EXEC_ACK_METHOD)).toContain(requestId);
    expect(requestRow(harness, requestId)).toBeUndefined();
    const framesAtSettlement = harness.deviceFrames.length;

    // Now the machine's own answer arrives. It belongs to the caller that asked
    // for it, and to nothing else.
    release();
    expect(JSON.parse(await running ?? 'null')).toMatchObject({ exitCode: 0 });
    await harness.userDO.acknowledgeDeviceRequest(harness.workspace, requestId);

    expect(harness.deviceFrames).toHaveLength(framesAtSettlement);
    expect(harness.db.prepare(`SELECT request_id FROM device_inflight_requests`).all()).toEqual([]);
    await harness.closeDeviceHarness();
  });
});

describe('revoking consent while a command is running', () => {
  test('does not stop it, and stops the next one', async () => {
    // Consent decides what may RUN. Revoking it deletes the remembered policy,
    // so the next call is asked again — it does not reach into a command the
    // owner already let through.
    const { responder, release } = holdingDaemon();
    const harness = await deviceHarness('ashish@studio', responder);
    harness.consentDecision = 'always';

    const running = runCommand(harness, nextDeviceRequestId());
    await asked(harness, 'exec');

    expect(await harness.userDO.revokeDeviceConsent(await testOwner(), WORKSPACE, harness.deviceId))
      .toEqual({ ok: true });
    expect(askedAbout(harness, DEVICE_CANCEL_METHOD)).toEqual([]);

    release();
    expect(JSON.parse(await running ?? 'null')).toMatchObject({ exitCode: 0 });

    // The next command is the one revocation stops, with no restart in between.
    harness.consentDecision = 'deny';
    await expect(runCommand(harness, nextDeviceRequestId(), 'bun run deploy'))
      .rejects.toThrow(DEVICE_CONSENT_DENIED);
    expect(askedAbout(harness, 'exec')).toEqual(['bun run build']);
    await harness.closeDeviceHarness();
  });

  test('revoking the device is the stop that revoking consent is not', async () => {
    const { responder, release } = holdingDaemon();
    const harness = await deviceHarness('ashish@studio', responder);
    harness.consentDecision = 'always';
    const requestId = nextDeviceRequestId();

    const running = runCommand(harness, requestId);
    await asked(harness, 'exec');

    // Revocation is the terminal device authority: it stops the running command
    // and confirms it, so the owner gets no unstopped-command incident.
    expect(await harness.userDO.revokeDevice(await testOwner(), harness.deviceId))
      .toEqual({ ok: true, unstoppedCommands: 0 });
    expect(askedAbout(harness, DEVICE_CANCEL_METHOD)).toEqual([requestId]);

    // The socket went with the device, so the held command's own answer never
    // comes back — the caller is told the device is gone, not given a result.
    await expect(running).rejects.toThrow(TUNNEL_DISCONNECTED);
    expect(harness.db.prepare(`SELECT request_id FROM device_inflight_requests`).all()).toEqual([]);
    // Settle the simulated far-end fiber after the disconnected caller has
    // already observed revocation. A late completion remains fenced.
    release();
    await harness.closeDeviceHarness();
  });
});
