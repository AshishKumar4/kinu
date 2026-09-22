/**
 * The UserDO device chokepoint against a misbehaving far end. Defends: a mispaired cancel confirms nothing,
 * a completion held past its cancellation publishes nothing, and revoking consent is not a stop.
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

/** Waits in event-loop hops, never a delay, until the device was asked `method`. */
async function asked(harness: DeviceHarness, method: string): Promise<void> {
  for (let hop = 0; hop < 100; hop += 1) {
    if (harness.deviceFrames.some((frame) => frame.method === method)) return;
    const { promise, resolve } = Promise.withResolvers<void>();
    setImmediate(resolve);
    await promise;
  }

  throw new Error(`the device was never asked to ${method}`);
}

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

/** `exec` is withheld until `release`, putting a completion past its own cancellation. */
function holdingDaemon() {
  const held = Promise.withResolvers<JsonValue>();

  const responder: DeviceResponder =
    (frame) => (frame.method === 'exec' ? held.promise : daemon(frame));

  return {
    responder,
    release: () => held.resolve({ stdout: 'built', stderr: '', exitCode: 0 }),
  };
}

/** The turn identity makes it a row a Stop can sweep. */
function runCommand(harness: DeviceHarness, requestId: string, command = 'bun run build'): Promise<string | undefined> {
  return harness.userDO.deviceRpc(harness.workspace, 'exec', [command], {
    agentName: WORKSPACE,
    requestId,
    checkpoint: { agent: WORKSPACE, turnId: TURN, sessionId: 'session-1', dir: null },
  });
}

/** Believing this kill claim would delete a row whose processes are still running. */
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

    // Still live work, so the next sweep asks again.
    expect(requestRow(harness, requestId))
      .toEqual({ cancel_outcome: null, cancel_claim: null });
    expect(await harness.userDO.revokeDevice(await testOwner(), harness.deviceId))
      .toEqual({ ok: true, unstoppedCommands: 1 });
    expect(v.parse(UnstoppedRowSchema, harness.db.prepare(
      `SELECT unstopped_at FROM user_devices WHERE id = ?`,
    ).all(harness.deviceId)[0]).unstopped_at).not.toBeNull();
    await harness.closeDeviceHarness();
  });

  test('is not stored as this request\'s answer on the tool\'s own abort path', async () => {
    // The tool's own abort path must fail rather than hand back another command's answer.
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
    // Already finished on the machine, so the daemon holds no control entry: the completion boundary.
      if (frame.method === DEVICE_CANCEL_METHOD) {
        return { requestId: v.parse(v.string(), frame.params[0]), cancelled: 'unknown' };
      }

      return responder(frame);
    });

    harness.consentDecision = 'always';
    const requestId = nextDeviceRequestId();

    const running = runCommand(harness, requestId);
    await asked(harness, 'exec');

    expect(await harness.userDO.cancelDeviceRequestsForTurn(harness.workspace, TURN))
      .toEqual([{ requestId, outcome: 'unknown' }]);
    expect(askedAbout(harness, DEVICE_EXEC_ACK_METHOD)).toContain(requestId);
    expect(requestRow(harness, requestId)).toBeUndefined();
    const framesAtSettlement = harness.deviceFrames.length;

    // The late answer belongs only to the caller that asked.
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
    // Revoking consent deletes the remembered policy; it does not reach into a command already let through.
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

    // Revocation stops and confirms the running command, so no unstopped-command incident.
    expect(await harness.userDO.revokeDevice(await testOwner(), harness.deviceId))
      .toEqual({ ok: true, unstoppedCommands: 0 });
    expect(askedAbout(harness, DEVICE_CANCEL_METHOD)).toEqual([requestId]);

    // The socket went with the device: the caller gets `TUNNEL_DISCONNECTED`, not a result.
    await expect(running).rejects.toThrow(TUNNEL_DISCONNECTED);
    expect(harness.db.prepare(`SELECT request_id FROM device_inflight_requests`).all()).toEqual([]);
    // A late completion after revocation remains fenced.
    release();
    await harness.closeDeviceHarness();
  });
});
