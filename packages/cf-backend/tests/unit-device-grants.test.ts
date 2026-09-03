/**
 * The per-workspace device grant, at the boundary that enforces it.
 *
 * Every agent call into a device passes through ONE chokepoint —
 * `UserDO.deviceRpc` — and consent is resolved there against the PROVEN
 * workspace. So these tests drive the real UserDO over bun:sqlite with a
 * connected device whose socket answers like the daemon does, because the
 * difference between "the grant let it through" and "the grant did nothing"
 * is only visible when the far end replies.
 *
 * Three claims, each provable in both directions:
 *   1. Before a grant, nothing executes: no frame reaches the device.
 *   2. After the owner grants the workspace, calls run without asking again.
 *   3. Revoking the grant takes effect on the NEXT call, with no restart.
 *
 * Plus the two halves the grant model needs to be usable: an agent can SEE
 * the machine by name before it may touch it, and when there is no machine at
 * all its request raises a provisioning card instead of a dead end.
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import * as v from 'valibot';
import {
  createTestUserDO, provisionTestWorkspace, testOwner, type TestUserDO,
} from './helpers/user-do';
import {
  CAPABLE_HELLO, OTHER_WORKSPACE, WORKSPACE, daemon, deviceHarness,
} from './helpers/device-harness';
import type { UserCaller } from '../src/user/workspace-capability';
import { DeviceSocketHub } from '../src/user/device-hub';
import { USER_DO_RPC_SURFACE } from '../src/rpc-surface';
import {
  DEVICE_CONNECT_PATH, DEVICE_CONSENT_DENIED, DEVICE_PROVISION_METHOD,
  DEVICE_TOKEN_ROTATION, DEVICE_TOKEN_ROTATION_ACK,
  DEVICE_CANCEL_METHOD, DEVICE_CANCEL_PROTOCOL, DEVICE_EXEC_ACK_METHOD, JsonValueSchema, nextDeviceRequestId,
  NO_DEVICE_CONNECTED, type JsonValue,
} from '@kinu.run/core';


const DeviceRpcFrameSchema = v.object({
  id: v.string(),
  method: v.string(),
  params: v.array(JsonValueSchema),
});

const UnstoppedRowSchema = v.object({ unstopped_at: v.nullable(v.number()) });

describe('the per-workspace device grant, enforced at the hub chokepoint', () => {
  test('an ungranted workspace is refused, and nothing reaches the machine', async () => {
    const harness = await deviceHarness();
    // The owner is away from the card: an unanswered prompt is not a refusal,
    // but it is not a grant either.
    harness.consentDecision = 'deny';

    await expect(harness.userDO.deviceRpc(harness.workspace, 'exec', ['rm -rf ~/work'], {
      agentName: WORKSPACE,
    })).rejects.toThrow(DEVICE_CONSENT_DENIED);

    // The refusal happened BEFORE the device — the executor boundary, not a
    // message the daemon was asked to ignore.
    expect(harness.deviceFrames.filter((f) => f.method === 'exec')).toEqual([]);
    // And the card the owner saw names the workspace whose access it decides.
    expect(harness.consentPrompts).toEqual([{
      workspace: WORKSPACE,
      method: 'exec',
      command: 'rm -rf ~/work',
      workspaceName: WORKSPACE,
    }]);
    await harness.closeDeviceHarness();
  });

  test('once the owner grants the workspace, calls run without asking again', async () => {
    const harness = await deviceHarness();
    harness.consentDecision = 'always';

    // On the tier a CARD can record, which is the base one. An exec asks every
    // time, deliberately — see "an exec card cannot record the full tier".
    await harness.userDO.deviceRpc(harness.workspace, 'readFile', ['/home/me/a.md'], {
      agentName: WORKSPACE,
    });
    expect(harness.consentPrompts).toHaveLength(1);

    // The grant is remembered, so the second call asks nobody and still runs.
    await harness.userDO.deviceRpc(harness.workspace, 'readFile', ['/home/me/b.md'], {
      agentName: WORKSPACE,
    });
    expect(harness.consentPrompts).toHaveLength(1);
    expect(harness.deviceFrames.filter((f) => f.method === 'readFile').map((f) => f.params[0]))
      .toEqual(['/home/me/a.md', '/home/me/b.md']);
    await harness.closeDeviceHarness();
  });


  test('one binding covers the shell too — the owner is asked once, not once per method', async () => {
    // What this replaces: a base grant used to leave `exec` still gated, so a
    // workspace the owner had already approved was asked AGAIN the first time
    // it ran a command, on a card whose real question was "may I use this
    // machine" and whose text was a shell line. There is one question now, and
    // what a command may touch is the device's own Sandbox switch.
    const harness = await deviceHarness();
    harness.consentDecision = 'always';
    await harness.userDO.deviceRpc(harness.workspace, 'readFile', ['/tmp/a'], { agentName: WORKSPACE });
    expect(harness.consentPrompts).toHaveLength(1);

    // The owner has left. A second card here would park the command on nobody.
    harness.consentDecision = 'deny';
    await harness.userDO.deviceRpc(harness.workspace, 'exec', ['cat /etc/passwd'], { agentName: WORKSPACE });

    expect(harness.consentPrompts).toHaveLength(1);
    expect(harness.deviceFrames.filter((f) => f.method === 'exec').map((f) => f.params[0]))
      .toEqual(['cat /etc/passwd']);
    await harness.closeDeviceHarness();
  });
  test('the grant covers file reads too — the whole device plane, not just exec', async () => {
    const harness = await deviceHarness();
    harness.consentDecision = 'deny';

    // The /pc mount reads THROUGH this same call, so an ungranted read is
    // refused for the same reason an ungranted command is.
    await expect(harness.userDO.deviceRpc(harness.workspace, 'readFile', ['/home/me/.ssh/id_ed25519'], {
      agentName: WORKSPACE,
    })).rejects.toThrow(DEVICE_CONSENT_DENIED);
    expect(harness.deviceFrames.filter((f) => f.method === 'readFile')).toEqual([]);

    harness.consentDecision = 'always';
    await harness.userDO.deviceRpc(harness.workspace, 'readFile', ['/home/me/notes.md'], {
      agentName: WORKSPACE,
    });
    expect(harness.deviceFrames.filter((f) => f.method === 'readFile').map((f) => f.params[0]))
      .toEqual(['/home/me/notes.md']);
    await harness.closeDeviceHarness();
  });

  test('revoking the grant stops the next call — no restart, no cache to wait out', async () => {
    const harness = await deviceHarness();
    harness.consentDecision = 'always';
    await harness.userDO.deviceRpc(harness.workspace, 'exec', ['ls'], { agentName: WORKSPACE });
    expect(harness.deviceFrames.filter((f) => f.method === 'exec')).toHaveLength(1);

    expect(await harness.userDO.revokeDeviceConsent(await testOwner(), WORKSPACE, harness.deviceId))
      .toEqual({ ok: true });

    // Revocation deletes the remembered policy rather than storing a refusal,
    // so the workspace is ASKED again — and the owner, now saying no, stops it.
    harness.consentDecision = 'deny';
    await expect(harness.userDO.deviceRpc(harness.workspace, 'exec', ['ls'], { agentName: WORKSPACE }))
      .rejects.toThrow(DEVICE_CONSENT_DENIED);
    expect(harness.deviceFrames.filter((f) => f.method === 'exec')).toHaveLength(1);
    await harness.closeDeviceHarness();
  });

  test('a grant belongs to one workspace: the sibling is still asked', async () => {
    const harness = await deviceHarness();
    harness.consentDecision = 'always';
    await harness.userDO.deviceRpc(harness.workspace, 'exec', ['ls'], { agentName: WORKSPACE });
    harness.consentPrompts.length = 0;

    harness.consentDecision = 'deny';
    await expect(harness.userDO.deviceRpc(harness.sibling, 'exec', ['ls'], { agentName: OTHER_WORKSPACE }))
      .rejects.toThrow(DEVICE_CONSENT_DENIED);
    expect(harness.consentPrompts.map((p) => p.workspace)).toEqual([OTHER_WORKSPACE]);
    await harness.closeDeviceHarness();
  });

  test('omitting agentName cannot bypass consent for workspace operations', async () => {
    const harness = await deviceHarness();
    harness.consentDecision = 'deny';

    await expect(harness.userDO.deviceRpc(harness.workspace, 'exec', ['cat /etc/passwd']))
      .rejects.toThrow(DEVICE_CONSENT_DENIED);
    await expect(harness.userDO.deviceRpc(
      harness.workspace,
      'checkpointRestore',
      [WORKSPACE, '/home/me/project', 'cp-1'],
    )).rejects.toThrow(DEVICE_CONSENT_DENIED);

    expect(harness.deviceFrames).toEqual([]);
    expect(harness.consentPrompts.map((prompt) => prompt.method))
      .toEqual(['exec', 'checkpointRestore']);
    await harness.closeDeviceHarness();
  });

  test('the closed checkpoint-read set stays consent-free', async () => {
    const harness = await deviceHarness();
    harness.consentDecision = 'deny';

    await harness.userDO.deviceRpc(harness.workspace, 'checkpointStatus', []);

    expect(harness.consentPrompts).toEqual([]);
    expect(harness.deviceFrames.map((frame) => frame.method)).toEqual(['checkpointStatus']);
    await harness.closeDeviceHarness();
  });

  /**
   * Stopping a command is not the same decision as starting one.
   *
   * Consent decides what may RUN on the machine. A cancellation only ends
   * something the owner already let through, and gating it would put a live
   * process behind a card nobody is at the keyboard to answer — the exact
   * failure cancellation exists for.
   */
  test('a cancellation reaches the machine while consent is refusing new work', async () => {
    const harness = await deviceHarness();
    harness.consentDecision = 'deny';
    const requestId = 'rpc-epoch1-7';

    // The control: this workspace cannot START anything right now.
    await expect(harness.userDO.deviceRpc(harness.workspace, 'exec', ['make'], {
      agentName: WORKSPACE,
    })).rejects.toThrow(DEVICE_CONSENT_DENIED);
    expect(harness.deviceFrames).toEqual([]);

    await harness.userDO.deviceRpc(
      harness.workspace, DEVICE_CANCEL_METHOD, [requestId, DEVICE_CANCEL_PROTOCOL],
      { agentName: WORKSPACE },
    );

    expect(harness.deviceFrames.map((frame) => ({ method: frame.method, params: frame.params })))
      .toEqual([{ method: DEVICE_CANCEL_METHOD, params: [requestId, DEVICE_CANCEL_PROTOCOL] }]);
    // And it asked nobody: only the refused `exec` raised a card.
    expect(harness.consentPrompts.map((prompt) => prompt.method)).toEqual(['exec']);
    await harness.closeDeviceHarness();
  });

  test('the identity the caller minted is the id the command is issued under', async () => {
    // The caller has to know the id before the answer, because that id is what
    // a later cancellation names. The hub forwards it verbatim rather than
    // minting one the caller could never learn in time.
    const harness = await deviceHarness();
    harness.consentDecision = 'always';
    const requestId = nextDeviceRequestId();

    await harness.userDO.deviceRpc(harness.workspace, 'exec', ['sleep 600'], {
      agentName: WORKSPACE, requestId,
    });

    expect(harness.deviceFrames.filter((frame) => frame.method === 'exec').map((frame) => frame.id))
      .toEqual([requestId]);
    await harness.closeDeviceHarness();
  });

  /**
   * A binding is read BY NAME on every later call, so its lifetime has to be
   * the lifetime of the thing it names. Two ways it used to outlive them.
   *
   * Retired with the tier vocabulary, on the lane owner's call: 'an exec card
   * cannot record the full tier, however the owner answers it' pinned that an
   * "always" on an exec card recorded the BASE scope rather than
   * full_filesystem. With one binding and no scope there is nothing to clamp,
   * so the property stopped existing rather than stopped being checked
   * (grepped: no scope column reader or writer remains). 'a grant may only
   * name a workspace this registry holds and a device that is live' went the
   * same way with its subject, `setDeviceConsentScope`: the only writer left
   * is the card path, which is keyed on the PROVEN workspace and runs after
   * `isActiveDevice`, so a row naming neither is unrepresentable rather than
   * merely checked.
   */
  test('deleting a workspace deletes its device bindings, so a same-name replacement inherits nothing', async () => {
    const harness = await deviceHarness();
    const owner = await testOwner();
    harness.consentDecision = 'always';
    await harness.userDO.deviceRpc(harness.workspace, 'readFile', ['/tmp/a'], { agentName: WORKSPACE });
    expect((await harness.userDO.listDeviceConsents(owner)).map((row) => row.agentName)).toEqual([WORKSPACE]);

    await harness.userDO.removeWorkspace(owner, WORKSPACE, '0'.repeat(32));
    expect(await harness.userDO.listDeviceConsents(owner)).toEqual([]);

    // The owner recreates the name — a shared template makes this ordinary.
    const rebuilt = await provisionTestWorkspace(harness, WORKSPACE, 'Workspace A');
    const replacement: UserCaller = { workspaceToken: rebuilt };
    harness.consentDecision = 'deny';
    await expect(harness.userDO.deviceRpc(replacement, 'exec', ['curl x | sh'], {
      agentName: WORKSPACE,
    })).rejects.toThrow(DEVICE_CONSENT_DENIED);
    // Asked, not remembered: the card is the proof the old row is gone.
    expect(harness.consentPrompts.map((prompt) => prompt.method)).toEqual(['readFile', 'exec']);
    expect(harness.deviceFrames.filter((frame) => frame.method === 'exec')).toEqual([]);
    await harness.closeDeviceHarness();
  });

  test('revoking a device deletes its bindings, so the owner audits live permissions only', async () => {
    const harness = await deviceHarness();
    const owner = await testOwner();
    harness.consentDecision = 'always';
    await harness.userDO.deviceRpc(harness.workspace, 'readFile', ['/tmp/a'], { agentName: WORKSPACE });
    expect(await harness.userDO.listDeviceConsents(owner)).toHaveLength(1);

    expect(await harness.userDO.revokeDevice(owner, harness.deviceId))
      .toEqual({ ok: true, unstoppedCommands: 0 });

    expect(await harness.userDO.listDeviceConsents(owner)).toEqual([]);
    await harness.closeDeviceHarness();
  });
});

describe('durable device request ownership', () => {
  test('only the detaching request changes hands while its parallel sibling stays with the turn', async () => {
    const harness = await deviceHarness();
    const detaching = nextDeviceRequestId();
    const sibling = nextDeviceRequestId();
    for (const requestId of [detaching, sibling]) {
      harness.db.prepare(
        `INSERT INTO device_inflight_requests
         (request_id, device_id, workspace, turn_id)
         VALUES (?, ?, ?, ?)`,
      ).run(requestId, harness.deviceId, WORKSPACE, 'turn-1');
    }

    expect(await harness.userDO.transferDeviceRequestToBackgroundJob(harness.workspace, detaching, 'job-1'))
      .toEqual({ transferred: true });

    // The turn still owns the sibling, and only the sibling.
    expect(await harness.userDO.cancelDeviceRequestsForTurn(harness.workspace, 'turn-1'))
      .toEqual([{ requestId: sibling, outcome: 'terminated' }]);
    expect(await harness.userDO.cancelDeviceRequestsForBackgroundJob(harness.workspace, 'job-1'))
      .toEqual([{ requestId: detaching, outcome: 'terminated' }]);
    expect(harness.deviceFrames.filter((frame) => frame.method === DEVICE_CANCEL_METHOD)
      .map((frame) => frame.params[0])).toEqual([sibling, detaching]);
    expect(harness.db.prepare(
      `SELECT request_id FROM device_inflight_requests`,
    ).all()).toEqual([]);
    await harness.closeDeviceHarness();
  });

  test('a transfer of an unknown or foreign request reports no ownership change', async () => {
    const harness = await deviceHarness();
    expect(await harness.userDO.transferDeviceRequestToBackgroundJob(
      harness.workspace, nextDeviceRequestId(), 'job-1',
    )).toEqual({ transferred: false });
    await harness.closeDeviceHarness();
  });

  /**
   * The provider half of detached device ownership: the seam a background-job
   * consumer must call. The consumer lives in the durable turn/job subsystem,
   * so this proves the contract exists and is reachable rather than claiming an
   * end-to-end detach this package does not own.
   */
  test('the ownership seam a background-job consumer needs is reachable and native', async () => {
    const harness = await deviceHarness();
    const seam = {
      transferDeviceRequestToBackgroundJob: harness.userDO.transferDeviceRequestToBackgroundJob,
      cancelDeviceRequestsForBackgroundJob: harness.userDO.cancelDeviceRequestsForBackgroundJob,
      acknowledgeDeviceRequest: harness.userDO.acknowledgeDeviceRequest,
    };
    for (const [name, member] of Object.entries(seam)) {
      expect(member).toBeFunction();
      expect(USER_DO_RPC_SURFACE).toContain(name);
    }
    // A per-request transfer takes exactly one request identity plus one job
    // identity — no turn argument exists to widen it back to the whole turn.
    expect(seam.transferDeviceRequestToBackgroundJob).toHaveLength(3);
    await harness.closeDeviceHarness();
  });

  /**
   * Controlled interleaving, not a snapshot: the sweep claims eligible rows
   * before its first device await, so a detach that lands mid-sweep cannot move
   * a request the sweep is already cancelling, and cannot be cancelled by a
   * sweep it escaped in time.
   */
  test('a detach racing an in-flight turn sweep loses to the sweep claim', async () => {
    const harness = await deviceHarness();
    const claimed = nextDeviceRequestId();
    harness.db.prepare(
      `INSERT INTO device_inflight_requests (request_id, device_id, workspace, turn_id)
       VALUES (?, ?, ?, ?)`,
    ).run(claimed, harness.deviceId, WORKSPACE, 'turn-1');

    const sweep = harness.userDO.cancelDeviceRequestsForTurn(harness.workspace, 'turn-1');
    // Interleaved before the sweep resolves: the row is already claimed.
    expect(await harness.userDO.transferDeviceRequestToBackgroundJob(harness.workspace, claimed, 'job-1'))
      .toEqual({ transferred: false });
    expect(await sweep).toEqual([{ requestId: claimed, outcome: 'terminated' }]);
    expect(await harness.userDO.cancelDeviceRequestsForBackgroundJob(harness.workspace, 'job-1')).toEqual([]);
    await harness.closeDeviceHarness();
  });

  test('a request that detached before the sweep is not cancelled by the turn', async () => {
    const harness = await deviceHarness();
    const detached = nextDeviceRequestId();
    harness.db.prepare(
      `INSERT INTO device_inflight_requests (request_id, device_id, workspace, turn_id)
       VALUES (?, ?, ?, ?)`,
    ).run(detached, harness.deviceId, WORKSPACE, 'turn-1');

    expect(await harness.userDO.transferDeviceRequestToBackgroundJob(harness.workspace, detached, 'job-1'))
      .toEqual({ transferred: true });
    expect(await harness.userDO.cancelDeviceRequestsForTurn(harness.workspace, 'turn-1')).toEqual([]);
    expect(harness.deviceFrames.filter((frame) => frame.method === DEVICE_CANCEL_METHOD)).toEqual([]);
    await harness.closeDeviceHarness();
  });

  test('a failed kill releases its claim so a later sweep can retry the same request', async () => {
    const harness = await deviceHarness();
    const requestId = nextDeviceRequestId();
    harness.db.prepare(
      `INSERT INTO device_inflight_requests (request_id, device_id, workspace, turn_id)
       VALUES (?, ?, ?, ?)`,
    ).run(requestId, harness.deviceId, WORKSPACE, 'turn-1');
    harness.attachDevice(null);

    // No live tunnel: the kill cannot be confirmed, so the row stays retryable.
    expect(await harness.userDO.cancelDeviceRequestsForTurn(harness.workspace, 'turn-1'))
      .toEqual([{ requestId, outcome: 'failed', detail: NO_DEVICE_CONNECTED }]);

    harness.attachDevice(harness.deviceId);
    expect(await harness.userDO.cancelDeviceRequestsForTurn(harness.workspace, 'turn-1'))
      .toEqual([{ requestId, outcome: 'terminated' }]);
    await harness.closeDeviceHarness();
  });

  test('an activation that died holding a claim leaves the request cancellable again', async () => {
    const harness = await deviceHarness();
    const requestId = nextDeviceRequestId();
    harness.db.prepare(
      `INSERT INTO device_inflight_requests (request_id, device_id, workspace, turn_id)
       VALUES (?, ?, ?, ?)`,
    ).run(requestId, harness.deviceId, WORKSPACE, 'turn-1');
    // Claimed, then the isolate died before the cancel frame went out: exactly
    // the state a reset between claim and RPC leaves behind.
    harness.db.prepare(
      `UPDATE device_inflight_requests SET cancel_claim = ? WHERE request_id = ?`,
    ).run('claim-of-a-dead-activation', requestId);

    const revived = createTestUserDO({ storage: harness.db, deviceResponder: daemon });
    revived.attachDevice(harness.deviceId);
    expect(await revived.userDO.cancelDeviceRequestsForTurn(harness.workspace, 'turn-1'))
      .toEqual([{ requestId, outcome: 'terminated' }]);
    await revived.joinFibers();
    revived.close();
    await harness.closeDeviceHarness();
  });

  test('a killed request whose acknowledgement fails is untransferable and cleaned up in the same activation', async () => {
    let ackWorks = false;
    const harness = await deviceHarness('ashish@studio', (frame) => {
      if (frame.method === DEVICE_EXEC_ACK_METHOD && !ackWorks) {
        throw new Error('acknowledgement channel down');
      }
      return daemon(frame);
    });
    const requestId = nextDeviceRequestId();
    harness.db.prepare(
      `INSERT INTO device_inflight_requests (request_id, device_id, workspace, turn_id)
       VALUES (?, ?, ?, ?)`,
    ).run(requestId, harness.deviceId, WORKSPACE, 'turn-1');

    // The kill is confirmed, so the outcome is truthful and the row is
    // process-terminal with only its replay cleanup outstanding.
    expect(await harness.userDO.cancelDeviceRequestsForTurn(harness.workspace, 'turn-1'))
      .toEqual([{ requestId, outcome: 'terminated' }]);
    // A dead command must never be handed to a background job.
    expect(await harness.userDO.transferDeviceRequestToBackgroundJob(harness.workspace, requestId, 'job-1'))
      .toEqual({ transferred: false });

    // Same activation, same hot socket: the retry cleans up and never kills the
    // dead process group a second time.
    ackWorks = true;
    expect(await harness.userDO.cancelDeviceRequestsForTurn(harness.workspace, 'turn-1'))
      .toEqual([{ requestId, outcome: 'terminated' }]);
    expect(harness.deviceFrames.filter((frame) => frame.method === DEVICE_CANCEL_METHOD)
      .map((frame) => frame.params[0])).toEqual([requestId]);
    expect(harness.db.prepare(
      `SELECT request_id FROM device_inflight_requests WHERE request_id = ?`,
    ).all(requestId)).toEqual([]);
    await harness.closeDeviceHarness();
  });

  test('a request killed before a restart is still untransferable and cleaned up after it', async () => {
    const harness = await deviceHarness('ashish@studio', (frame) => {
      if (frame.method === DEVICE_EXEC_ACK_METHOD) throw new Error('acknowledgement channel down');
      return daemon(frame);
    });
    const requestId = nextDeviceRequestId();
    harness.db.prepare(
      `INSERT INTO device_inflight_requests (request_id, device_id, workspace, turn_id)
       VALUES (?, ?, ?, ?)`,
    ).run(requestId, harness.deviceId, WORKSPACE, 'turn-1');
    expect(await harness.userDO.cancelDeviceRequestsForTurn(harness.workspace, 'turn-1'))
      .toEqual([{ requestId, outcome: 'terminated' }]);

    // Death is durable, so it outlives the activation that observed it: the new
    // activation refuses the transfer even before it cleans the row up.
    const revived = createTestUserDO({ storage: harness.db, deviceResponder: daemon });
    revived.attachDevice(harness.deviceId);
    expect(await revived.userDO.transferDeviceRequestToBackgroundJob(harness.workspace, requestId, 'job-1'))
      .toEqual({ transferred: false });
    expect(await revived.userDO.cancelDeviceRequestsForTurn(harness.workspace, 'turn-1'))
      .toEqual([{ requestId, outcome: 'terminated' }]);
    expect(revived.deviceFrames.filter((frame) => frame.method === DEVICE_CANCEL_METHOD)).toEqual([]);
    expect(revived.db.prepare(
      `SELECT request_id FROM device_inflight_requests WHERE request_id = ?`,
    ).all(requestId)).toEqual([]);
    await revived.joinFibers();
    revived.close();
    await harness.closeDeviceHarness();
  });

  test('an unknown cancellation whose acknowledgement fails is untransferable and keeps its answer', async () => {
    let ackWorks = false;
    const harness = await deviceHarness('ashish@studio', (frame) => {
      if (frame.method === DEVICE_CANCEL_METHOD) {
        return { requestId: String(frame.params[0]), cancelled: 'unknown' };
      }
      if (frame.method === DEVICE_EXEC_ACK_METHOD && !ackWorks) {
        throw new Error('acknowledgement channel down');
      }
      return daemon(frame);
    });
    const requestId = nextDeviceRequestId();
    harness.db.prepare(
      `INSERT INTO device_inflight_requests (request_id, device_id, workspace, turn_id)
       VALUES (?, ?, ?, ?)`,
    ).run(requestId, harness.deviceId, WORKSPACE, 'turn-1');

    // `unknown` also proves nothing runs under the request, so the row settles.
    expect(await harness.userDO.cancelDeviceRequestsForTurn(harness.workspace, 'turn-1'))
      .toEqual([{ requestId, outcome: 'unknown' }]);
    expect(await harness.userDO.transferDeviceRequestToBackgroundJob(harness.workspace, requestId, 'job-1'))
      .toEqual({ transferred: false });

    // A cleanup retry reports the STORED answer rather than promoting it to a
    // termination this sweep never observed.
    ackWorks = true;
    expect(await harness.userDO.cancelDeviceRequestsForTurn(harness.workspace, 'turn-1'))
      .toEqual([{ requestId, outcome: 'unknown' }]);
    expect(harness.db.prepare(
      `SELECT request_id FROM device_inflight_requests WHERE request_id = ?`,
    ).all(requestId)).toEqual([]);
    await harness.closeDeviceHarness();
  });

  test('a settled request reports its stored answer rather than a kill failure when the device is gone', async () => {
    const harness = await deviceHarness();
    const requestId = nextDeviceRequestId();
    harness.db.prepare(
      `INSERT INTO device_inflight_requests
       (request_id, device_id, workspace, turn_id, cancel_outcome)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(requestId, harness.deviceId, WORKSPACE, 'turn-1', 'terminated');
    harness.attachDevice(null);

    // A confirmed stop must never regress into "the kill failed" just because
    // the socket needed for local cleanup is gone.
    expect(await harness.userDO.cancelDeviceRequestsForTurn(harness.workspace, 'turn-1'))
      .toEqual([{ requestId, outcome: 'terminated' }]);
    // Cleanup is still owed, so the row survives and stays untransferable.
    expect(await harness.userDO.transferDeviceRequestToBackgroundJob(harness.workspace, requestId, 'job-1'))
      .toEqual({ transferred: false });
    // And the revoked-device incident does not count a request already answered.
    expect(await harness.userDO.revokeDevice(await testOwner(), harness.deviceId))
      .toEqual({ ok: true, unstoppedCommands: 0 });
    await harness.closeDeviceHarness();
  });

  test('a sweep that loses its row while the kill fails reports nothing for it', async () => {
    let dropRow: (() => void) | null = null;
    const harness = await deviceHarness('ashish@studio', (frame) => {
      if (frame.method === DEVICE_CANCEL_METHOD) {
        dropRow?.();
        throw new Error('tunnel closed under the kill');
      }
      return daemon(frame);
    });
    const requestId = nextDeviceRequestId();
    harness.db.prepare(
      `INSERT INTO device_inflight_requests (request_id, device_id, workspace, turn_id)
       VALUES (?, ?, ?, ?)`,
    ).run(requestId, harness.deviceId, WORKSPACE, 'turn-1');
    // Revocation deletes the row while this kill is in flight, then the kill
    // rejects. The row is gone, so this sweep no longer answers for it.
    dropRow = () => {
      harness.db.prepare(`DELETE FROM device_inflight_requests WHERE request_id = ?`).run(requestId);
      dropRow = null;
    };

    expect(await harness.userDO.cancelDeviceRequestsForTurn(harness.workspace, 'turn-1')).toEqual([]);
    await harness.closeDeviceHarness();
  });

  test('an exec issued inside a detached scope is the job\'s from the insert, not the turn\'s', async () => {
    const harness = await deviceHarness();
    harness.consentDecision = 'always';
    const requestId = nextDeviceRequestId();

    await harness.userDO.deviceRpc(harness.workspace, 'exec', ['sleep 30'], {
      agentName: WORKSPACE, requestId, backgroundJobId: 'job-1',
      checkpoint: { agent: WORKSPACE, turnId: 'turn-1', sessionId: 's', dir: null },
    });

    // No transfer ran, and the turn that opened the scope never owned the row:
    // there is no window for a Stop to cancel work that already detached.
    expect(harness.db.prepare(
      `SELECT turn_id, background_job_id FROM device_inflight_requests WHERE request_id = ?`,
    ).all(requestId)).toEqual([{ turn_id: null, background_job_id: 'job-1' }]);
    expect(await harness.userDO.cancelDeviceRequestsForTurn(harness.workspace, 'turn-1')).toEqual([]);
    expect(await harness.userDO.cancelDeviceRequestsForBackgroundJob(harness.workspace, 'job-1'))
      .toEqual([{ requestId, outcome: 'terminated' }]);
    await harness.closeDeviceHarness();
  });

  test('a revoked device\'s unresolved request cannot be detached into a job', async () => {
    const harness = await deviceHarness();
    const requestId = nextDeviceRequestId();
    harness.db.prepare(
      `INSERT INTO device_inflight_requests (request_id, device_id, workspace, turn_id)
       VALUES (?, ?, ?, ?)`,
    ).run(requestId, harness.deviceId, WORKSPACE, 'turn-1');
    // Revoked, and a crashed activation left no claim behind to block a detach.
    harness.db.prepare(`UPDATE user_devices SET revoked_at = ? WHERE id = ?`)
      .run(Date.now(), harness.deviceId);

    // The daemon can never reconnect, so a job that adopted this could never
    // cancel it: the unresolved command stays revocation's to report.
    expect(await harness.userDO.transferDeviceRequestToBackgroundJob(harness.workspace, requestId, 'job-1'))
      .toEqual({ transferred: false });
    await harness.closeDeviceHarness();
  });

  test('a request already owned by a job stops reporting success once its device is revoked', async () => {
    const harness = await deviceHarness();
    const requestId = nextDeviceRequestId();
    harness.db.prepare(
      `INSERT INTO device_inflight_requests (request_id, device_id, workspace, background_job_id)
       VALUES (?, ?, ?, ?)`,
    ).run(requestId, harness.deviceId, WORKSPACE, 'job-1');

    // Idempotent while the machine can still be reached...
    expect(await harness.userDO.transferDeviceRequestToBackgroundJob(harness.workspace, requestId, 'job-1'))
      .toEqual({ transferred: true });
    harness.db.prepare(`UPDATE user_devices SET revoked_at = ? WHERE id = ?`)
      .run(Date.now(), harness.deviceId);
    // ...and no longer a success once it cannot, because the job could not
    // cancel what it would be told it owns.
    expect(await harness.userDO.transferDeviceRequestToBackgroundJob(harness.workspace, requestId, 'job-1'))
      .toEqual({ transferred: false });
    await harness.closeDeviceHarness();
  });

  test('an exec refuses an owner that does not name a job', async () => {
    const harness = await deviceHarness();
    harness.consentDecision = 'always';
    const requestId = nextDeviceRequestId();

    // A blank owner would insert a row no turn sweep and no job sweep can ever
    // select - the orphan this table exists to prevent.
    await expect(harness.userDO.deviceRpc(harness.workspace, 'exec', ['sleep 30'], {
      agentName: WORKSPACE, requestId, backgroundJobId: '',
    })).rejects.toThrow('must name a job');
    expect(harness.db.prepare(
      `SELECT request_id FROM device_inflight_requests WHERE request_id = ?`,
    ).all(requestId)).toEqual([]);
    expect(harness.deviceFrames.filter((frame) => frame.method === 'exec')).toEqual([]);
    await harness.closeDeviceHarness();
  });

  test('the owner cannot retire a revocation warning while the sweep still holds rows', async () => {
    const harness = await deviceHarness();
    const requestId = nextDeviceRequestId();
    harness.db.prepare(
      `INSERT INTO device_inflight_requests (request_id, device_id, workspace, turn_id)
       VALUES (?, ?, ?, ?)`,
    ).run(requestId, harness.deviceId, WORKSPACE, 'turn-1');
    // The state a sweep leaves between writing its provisional warning and
    // deciding: revoked, warned, rows still unsettled.
    harness.db.prepare(`UPDATE user_devices SET revoked_at = ?, unstopped_at = ? WHERE id = ?`)
      .run(Date.now(), Date.now(), harness.deviceId);

    // Nothing to read yet, so nothing to acknowledge: clearing here could retire
    // a warning about a process no one has confirmed and no one can ask again.
    expect(await harness.userDO.acknowledgeUnstoppedDevice(await testOwner(), harness.deviceId))
      .toEqual({ ok: false });

    harness.db.prepare(`DELETE FROM device_inflight_requests WHERE device_id = ?`).run(harness.deviceId);
    expect(await harness.userDO.acknowledgeUnstoppedDevice(await testOwner(), harness.deviceId))
      .toEqual({ ok: true });
    await harness.closeDeviceHarness();
  });

  test('a tool that cancelled its own exec and the turn sweep agree on one answer', async () => {
    const harness = await deviceHarness();
    harness.consentDecision = 'always';
    const requestId = nextDeviceRequestId();
    harness.db.prepare(
      `INSERT INTO device_inflight_requests (request_id, device_id, workspace, turn_id)
       VALUES (?, ?, ?, ?)`,
    ).run(requestId, harness.deviceId, WORKSPACE, 'turn-1');

    // The abort path the laptop exec tool takes: the cancellation frame goes
    // straight through this same forwarder rather than through a sweep.
    await harness.userDO.deviceRpc(harness.workspace, DEVICE_CANCEL_METHOD, [requestId, DEVICE_CANCEL_PROTOCOL], {
      agentName: WORKSPACE,
    });

    // The turn sweep then finds the request already answered: it reports THAT
    // answer and sends no second kill, so the two paths cannot disagree about
    // whether the process group died.
    expect(await harness.userDO.cancelDeviceRequestsForTurn(harness.workspace, 'turn-1'))
      .toEqual([{ requestId, outcome: 'terminated' }]);
    expect(harness.deviceFrames.filter((frame) => frame.method === DEVICE_CANCEL_METHOD)
      .map((frame) => frame.params[0])).toEqual([requestId]);
    expect(harness.db.prepare(
      `SELECT request_id FROM device_inflight_requests WHERE request_id = ?`,
    ).all(requestId)).toEqual([]);
    await harness.closeDeviceHarness();
  });

  test('an exec is refused when revocation lands inside its acknowledgement probe', async () => {
    let revokeNow: (() => void) | null = null;
    const harness = await deviceHarness('ashish@studio', (frame) => {
      if (frame.method === DEVICE_EXEC_ACK_METHOD) revokeNow?.();
      return daemon(frame);
    });
    harness.consentDecision = 'always';
    // The probe is the one await between admission and the durable row, so this
    // is where a revocation sweep can slip past an earlier check.
    revokeNow = () => {
      harness.db.prepare(`UPDATE user_devices SET revoked_at = ? WHERE id = ?`)
        .run(Date.now(), harness.deviceId);
    };
    const requestId = nextDeviceRequestId();

    await expect(harness.userDO.deviceRpc(harness.workspace, 'exec', ['sleep 30'], {
      agentName: WORKSPACE, requestId,
    })).rejects.toThrow(NO_DEVICE_CONNECTED);
    // Neither a row a revoked device could never answer for, nor a command frame.
    expect(harness.db.prepare(
      `SELECT request_id FROM device_inflight_requests WHERE request_id = ?`,
    ).all(requestId)).toEqual([]);
    expect(harness.deviceFrames.filter((frame) => frame.method === 'exec')).toEqual([]);
    await harness.closeDeviceHarness();
  });

  test('a transfer to the job already cancelling the request reports no ownership change', async () => {
    const harness = await deviceHarness();
    const requestId = nextDeviceRequestId();
    harness.db.prepare(
      `INSERT INTO device_inflight_requests
       (request_id, device_id, workspace, background_job_id, cancel_claim)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(requestId, harness.deviceId, WORKSPACE, 'job-1', 'claim-of-the-live-sweep');

    // Same job id, and the row is mid-cancellation: it has not changed hands,
    // so a detach must not read the pre-existing owner as its own success.
    expect(await harness.userDO.transferDeviceRequestToBackgroundJob(harness.workspace, requestId, 'job-1'))
      .toEqual({ transferred: false });
    // Unclaimed, the same transfer is idempotent rather than a false negative.
    harness.db.prepare(`UPDATE device_inflight_requests SET cancel_claim = NULL WHERE request_id = ?`)
      .run(requestId);
    expect(await harness.userDO.transferDeviceRequestToBackgroundJob(harness.workspace, requestId, 'job-1'))
      .toEqual({ transferred: true });
    await harness.closeDeviceHarness();
  });

  test('a sweep whose claim is taken mid-flight sends no further frame for that row', async () => {
    let stealClaim: (() => void) | null = null;
    const harness = await deviceHarness('ashish@studio', (frame) => {
      if (frame.method === DEVICE_CANCEL_METHOD) stealClaim?.();
      return daemon(frame);
    });
    const [first, second] = [nextDeviceRequestId(), nextDeviceRequestId()];
    for (const requestId of [first, second]) {
      harness.db.prepare(
        `INSERT INTO device_inflight_requests (request_id, device_id, workspace, turn_id)
         VALUES (?, ?, ?, ?)`,
      ).run(requestId, harness.deviceId, WORKSPACE, 'turn-1');
    }
    // Both rows are claimed by the sweep, then the terminal authority takes the
    // second row's claim while the first row's frame is in flight.
    stealClaim = () => {
      harness.db.prepare(`UPDATE device_inflight_requests SET cancel_claim = ? WHERE request_id = ?`)
        .run('claim-of-the-revocation', second);
      stealClaim = null;
    };

    expect(await harness.userDO.cancelDeviceRequestsForTurn(harness.workspace, 'turn-1'))
      .toEqual([{ requestId: first, outcome: 'terminated' }]);
    // Exactly one authority cancels and reports a request: the displaced row
    // belongs to whoever took it.
    expect(harness.deviceFrames.filter((frame) => frame.method === DEVICE_CANCEL_METHOD)
      .map((frame) => frame.params[0])).toEqual([first]);
    await harness.closeDeviceHarness();
  });

  test('revocation records its incident before the first kill and clears it only when all are confirmed', async () => {
    const seenAtFrame: Array<number | null> = [];
    const harness = await deviceHarness('ashish@studio', (frame) => {
      if (frame.method === DEVICE_CANCEL_METHOD) {
        seenAtFrame.push(harness.db.prepare(
          `SELECT unstopped_at FROM user_devices WHERE id = ?`,
        ).all(harness.deviceId).map((row) => v.parse(UnstoppedRowSchema, row).unstopped_at)[0]);
      }
      return daemon(frame);
    });
    const requestId = nextDeviceRequestId();
    harness.db.prepare(
      `INSERT INTO device_inflight_requests (request_id, device_id, workspace, turn_id)
       VALUES (?, ?, ?, ?)`,
    ).run(requestId, harness.deviceId, WORKSPACE, 'turn-1');

    expect(await harness.userDO.revokeDevice(await testOwner(), harness.deviceId))
      .toEqual({ ok: true, unstoppedCommands: 0 });
    // An activation dying anywhere after the claim leaves the incident standing.
    expect(seenAtFrame).toHaveLength(1);
    expect(seenAtFrame[0]).toBeNumber();
    // Every command was confirmed dead, so nothing is left to warn about.
    expect(harness.db.prepare(`SELECT unstopped_at FROM user_devices WHERE id = ?`)
      .all(harness.deviceId)).toEqual([{ unstopped_at: null }]);
    await harness.closeDeviceHarness();
  });
});

describe('device revocation admission', () => {
  test('rejects new exec while it awaits durable command cancellation', async () => {
    const harness = await deviceHarness();
    harness.consentDecision = 'always';
    const requestId = nextDeviceRequestId();
    harness.db.prepare(
      `INSERT INTO device_inflight_requests
       (request_id, device_id, workspace, turn_id)
       VALUES (?, ?, ?, ?)`,
    ).run(requestId, harness.deviceId, WORKSPACE, 'turn-1');

    const cancellationSent = Promise.withResolvers<{ id: string; method: string; params: JsonValue[] }>();
    let attachment: JsonValue = null;
    let hub: DeviceSocketHub | null = null;
    const socket = {
      readyState: 1,
      close: () => {},
      serializeAttachment: (value: JsonValue) => { attachment = value; },
      deserializeAttachment: () => attachment,
      send: (raw: string) => {
        const frame = v.parse(DeviceRpcFrameSchema, JSON.parse(raw));
        if (frame.method === DEVICE_CANCEL_METHOD) cancellationSent.resolve(frame);
        if (frame.method === DEVICE_EXEC_ACK_METHOD && hub) {
          hub.handleMessage(harness.deviceId, JSON.stringify({
            id: frame.id, result: { requestId, acknowledged: true },
          }));
        }
      },
    };
    const hubCandidate = Object.getOwnPropertyDescriptor(harness.userDO, '_devices')?.value;
    if (!(hubCandidate instanceof DeviceSocketHub)) throw new Error('UserDO device hub is unavailable.');
    hub = hubCandidate;
    harness.attachDevice(null);
    hub.accept(harness.deviceId, socket);

    const revocation = harness.userDO.revokeDevice(await testOwner(), harness.deviceId);
    const cancellation = await cancellationSent.promise;
    await expect(harness.userDO.deviceRpc(harness.workspace, 'exec', ['true'], {
      agentName: WORKSPACE,
    })).rejects.toThrow(NO_DEVICE_CONNECTED);
    expect(cancellation.params).toEqual([requestId, DEVICE_CANCEL_PROTOCOL]);

    hub.handleMessage(harness.deviceId, JSON.stringify({
      id: cancellation.id,
      result: { requestId, cancelled: 'terminated' },
    }));
    expect(await revocation).toEqual({ ok: true, unstoppedCommands: 0 });
    await harness.closeDeviceHarness();
  });
});

describe('a device is visible before it is usable', () => {
  test('an ungranted workspace sees the machine by name, platform and liveness', async () => {
    const harness = await deviceHarness('ashish@studio');
    // Nobody has granted anything, and no consent prompt is raised by looking.
    const status = await harness.userDO.deviceRuntimeStatus(harness.workspace);

    expect(status.connected).toBe(true);
    expect(status.workspaceGranted).toBe(false);
    expect(status.devices).toMatchObject([
      { id: harness.deviceId, name: 'ashish@studio', os: 'linux', hostname: 'studio', connected: true },
    ]);
    // The fleet entry says the same thing PER MACHINE: visible, and not yet
    // this workspace's to use.
    expect(status.devices?.[0]?.granted).toBe(false);
    expect(harness.consentPrompts).toEqual([]);
    await harness.closeDeviceHarness();
  });

  test('the same read reports the binding once it exists', async () => {
    const harness = await deviceHarness();
    harness.consentDecision = 'always';
    await harness.userDO.deviceRpc(harness.workspace, 'readFile', ['/tmp/a'], { agentName: WORKSPACE });

    expect((await harness.userDO.deviceRuntimeStatus(harness.workspace)).workspaceGranted).toBe(true);
    expect((await harness.userDO.deviceRuntimeStatus(harness.sibling)).workspaceGranted).toBe(false);
    await harness.closeDeviceHarness();
  });

  test('a renamed device is renamed everywhere, because there is one name', async () => {
    const harness = await deviceHarness('ashish@studio');
    expect(await harness.userDO.renameDevice(await testOwner(), harness.deviceId, '  studio tower  '))
      .toEqual({ ok: true });

    expect((await harness.userDO.listDevices(await testOwner()))[0].label).toBe('studio tower');
    expect((await harness.userDO.deviceRuntimeStatus(harness.workspace)).devices?.[0].name)
      .toBe('studio tower');
    expect(await harness.userDO.renameDevice(await testOwner(), harness.deviceId, '   '))
      .toEqual({ ok: false });
    expect(await harness.userDO.renameDevice(await testOwner(), 'dev-nope', 'x'))
      .toEqual({ ok: false });
    expect((await harness.userDO.listDevices(await testOwner()))[0].label).toBe('studio tower');
    await harness.closeDeviceHarness();
  });

  test('registration bounds the name before any surface can render it', async () => {
    const harness = await deviceHarness(`  ${'x'.repeat(120)}  `);
    expect((await harness.userDO.listDevices(await testOwner()))[0].label)
      .toBe('x'.repeat(80));
    await harness.closeDeviceHarness();
  });
});

describe('asking for a machine when there is none', () => {
  test('the call raises a provisioning card and still refuses, by name', async () => {
    const harness = createTestUserDO();
    const workspace = await provisionTestWorkspace(harness, WORKSPACE, 'Workspace A');

    await expect(harness.userDO.deviceRpc({ workspaceToken: workspace }, 'exec', ['make build'], {
      agentName: WORKSPACE,
    })).rejects.toThrow(NO_DEVICE_CONNECTED);

    expect(harness.consentPrompts).toEqual([{
      workspace: WORKSPACE,
      method: DEVICE_PROVISION_METHOD,
      command: expect.stringContaining('Connect this computer'),
      workspaceName: WORKSPACE,
    }]);
    await harness.joinFibers();
    harness.close();
  });

  test('a card still waiting is not raised twice by a retrying agent', async () => {
    // The dedupe is the REGISTRY's, not the caller's. The UserDO used to read
    // listPendingConsents and skip — a check-then-act across two RPCs that
    // raced itself, and only ever covered the provisioning method. Now an
    // identical still-waiting request joins the card already up, so this drives
    // two identical asks and reads what the authority actually did.
    const harness = createTestUserDO();
    const workspace = await provisionTestWorkspace(harness, WORKSPACE, 'Workspace A');
    harness.consentDecision = 'hold';

    const first = harness.userDO.deviceRpc({ workspaceToken: workspace }, 'exec', ['make build'], {
      agentName: WORKSPACE,
    });
    const retry = harness.userDO.deviceRpc({ workspaceToken: workspace }, 'exec', ['make build'], {
      agentName: WORKSPACE,
    });
    const settled = Promise.allSettled([first, retry]);
    // Await the CONDITION, never a duration: yield to the scheduler until the
    // card is actually up. Both calls are already in flight, so the second
    // reaches the registry during the same yielding and meets the first's card.
    for (let turn = 0; turn < 100 && harness.consentPrompts.length === 0; turn += 1) {
      await new Promise<void>((resolve) => { setImmediate(resolve); });
    }

    // ONE card, one id: the provisioning question is identical both times.
    expect(harness.consentPrompts).toEqual([{
      workspace: WORKSPACE,
      method: DEVICE_PROVISION_METHOD,
      command: expect.stringContaining('Connect this computer'),
      workspaceName: WORKSPACE,
    }]);
    expect(harness.raisedConsentIds).toEqual(['cons-1']);

    // And BOTH callers are parked on that one card — neither was answered by a
    // second prompt nobody raised, and neither ran ahead without one.
    const pending = Symbol('pending');
    expect(await Promise.race([settled, Promise.resolve(pending)])).toBe(pending);

    // One answer settles every caller waiting on it. Both still refuse, because
    // approving the card provisions nothing — no daemon is linked yet.
    harness.answerConsent('once');
    const outcomes = await settled;
    expect(outcomes.map((o) => o.status)).toEqual(['rejected', 'rejected']);
    for (const outcome of outcomes) {
      expect(String(outcome.status === 'rejected' ? outcome.reason : '')).toContain(NO_DEVICE_CONNECTED);
    }
    // And answering did not raise a second card on the way out.
    expect(harness.raisedConsentIds).toEqual(['cons-1']);
    await harness.joinFibers();
    harness.close();
  });

  test('the round trip completes: request, approve, connect, grant, execute', async () => {
    // ONE hub throughout, because that is the shape of the real flow: the
    // workspace, the device registry and the socket are all the same user's.
    const harness = createTestUserDO({ deviceResponder: daemon });
    const token = await provisionTestWorkspace(harness, WORKSPACE, 'Workspace A');
    const caller: UserCaller = { workspaceToken: token };

    // 1. The agent reaches for a machine and there is none: a card is raised.
    await expect(harness.userDO.deviceRpc(caller, 'exec', ['make build'], { agentName: WORKSPACE }))
      .rejects.toThrow(NO_DEVICE_CONNECTED);
    expect(harness.consentPrompts.map((p) => p.method)).toEqual([DEVICE_PROVISION_METHOD]);
    expect(harness.deviceFrames).toEqual([]);

    // 2. The owner approved the card and ran `kinu connect`, naming the machine.
    //    Its daemon says what it proved on connect, which is what makes the
    //    machine usable: one that proves nothing runs no commands.
    const { deviceId } = await harness.userDO.registerDevice(await testOwner(), 'ashish@studio');
    harness.attachDevice(deviceId);
    await harness.sendDeviceHello(CAPABLE_HELLO);
    // The agent can now SEE it — by name — while still holding no grant.
    const seen = await harness.userDO.deviceRuntimeStatus(caller);
    expect(seen.devices?.map((d) => d.name)).toEqual(['ashish@studio']);
    expect(seen.workspaceGranted).toBe(false);

    // 3. The next call asks for THIS workspace's access, and the owner grants it.
    harness.consentDecision = 'always';
    const result = await harness.userDO.deviceRpc(caller, 'exec', ['make build'], { agentName: WORKSPACE });

    // 4. It executed on the machine, and the grant is now recorded.
    expect(result).toContain('"exitCode":0');
    expect(harness.deviceFrames.filter((f) => f.method === 'exec').map((f) => f.params[0]))
      .toEqual(['make build']);
    expect((await harness.userDO.deviceRuntimeStatus(caller)).workspaceGranted).toBe(true);
    expect((await harness.userDO.listDeviceConsents(await testOwner()))).toEqual([
      expect.objectContaining({ agentName: WORKSPACE, deviceId, policy: 'allow' }),
    ]);
    await harness.joinFibers();
    harness.close();
  });
});

/**
 * The owner's own sequence, reproduced as one flow: a machine connects and
 * shows online, the workspace holds no grant, and the agent asks for the
 * device. What he saw was the PROVISIONING card — "needs a computer of yours
 * and none is connected" — on a machine that was connected. The routing that
 * raises it keys on hub liveness only, so if this ever passes while the
 * machine is live and ungranted, the defect has moved somewhere this suite
 * has not reached: keep looking, do not declare the Env half fixed.
 */
describe('the owner\'s sequence: a live machine, an ungranted workspace, one ask', () => {
  test('a connected device raises the GRANT card, never the provisioning card', async () => {
    const harness = await deviceHarness();
    harness.consentDecision = 'deny';

    await expect(harness.userDO.deviceRpc(harness.workspace, 'exec', ['ls'], {
      agentName: WORKSPACE,
    })).rejects.toThrow(DEVICE_CONSENT_DENIED);

    // The one card names the machine and THIS workspace — the grant question.
    expect(harness.consentPrompts).toEqual([{
      workspace: WORKSPACE,
      method: 'exec',
      command: 'ls',
      workspaceName: WORKSPACE,
    }]);
    // And no provisioning card was raised beside it: the machine was live, so
    // "none is connected" is the wrong question to have asked.
    expect(harness.consentPrompts.some((p) => p.method === DEVICE_PROVISION_METHOD)).toBe(false);
    await harness.closeDeviceHarness();
  });
});

/**
 * One ask, four worlds — what the owner sees on the card and what the Env
 * view says about the machine. The card half lives in the hub chokepoint; the
 * Env half rides `deviceRuntimeStatus`, the read the executor row and the
 * surfaces both consume. A machine the workspace cannot use is OFFLINE in the
 * Env grid until the owner answers for it, because that is what a row that
 * says otherwise told him.
 */
describe('the machine the agent asked for, as the owner reads it', () => {
  test('no device: the provisioning card, and no laptop row to render', async () => {
    const harness = createTestUserDO();
    const workspace = await provisionTestWorkspace(harness, WORKSPACE, 'Workspace A');

    await expect(harness.userDO.deviceRpc({ workspaceToken: workspace }, 'exec', ['make'], {
      agentName: WORKSPACE,
    })).rejects.toThrow(NO_DEVICE_CONNECTED);
    expect(harness.consentPrompts.map((p) => p.method)).toEqual([DEVICE_PROVISION_METHOD]);

    const status = await harness.userDO.deviceRuntimeStatus({ workspaceToken: workspace });
    expect(status.connected).toBe(false);
    expect(status.workspaceGranted).toBeUndefined();
    await harness.joinFibers();
    harness.close();
  });

  test('device offline: the provisioning card, and an offline row', async () => {
    const harness = await deviceHarness();
    // The daemon's socket closes — the machine is registered but gone.
    harness.attachDevice(null);

    await expect(harness.userDO.deviceRpc(harness.workspace, 'exec', ['make'], {
      agentName: WORKSPACE,
    })).rejects.toThrow(NO_DEVICE_CONNECTED);
    expect(harness.consentPrompts.map((p) => p.method)).toEqual([DEVICE_PROVISION_METHOD]);

    const status = await harness.userDO.deviceRuntimeStatus(harness.workspace);
    expect(status.connected).toBe(false);
    expect(status.registered).toBe(true);
    expect(status.workspaceGranted).toBeUndefined();
    await harness.closeDeviceHarness();
  });

  test('device online and ungranted: the GRANT card, and a row that is not usable', async () => {
    const harness = await deviceHarness();
    harness.consentDecision = 'deny';

    await expect(harness.userDO.deviceRpc(harness.workspace, 'exec', ['make'], {
      agentName: WORKSPACE,
    })).rejects.toThrow(DEVICE_CONSENT_DENIED);
    // The grant card, by name, for this workspace — not the provisioning one.
    expect(harness.consentPrompts).toEqual([{
      workspace: WORKSPACE,
      method: 'exec',
      command: 'make',
      workspaceName: WORKSPACE,
    }]);
    // And the row the Env view renders reads as connected but not granted.
    const status = await harness.userDO.deviceRuntimeStatus(harness.workspace);
    expect(status.connected).toBe(true);
    expect(status.workspaceGranted).toBe(false);
    await harness.closeDeviceHarness();
  });

  test('device online and granted: no card, and a row the agent can act on', async () => {
    const harness = await deviceHarness();
    harness.consentDecision = 'always';

    await harness.userDO.deviceRpc(harness.workspace, 'exec', ['make'], {
      agentName: WORKSPACE,
    });
    expect(harness.consentPrompts).toHaveLength(1);

    const status = await harness.userDO.deviceRuntimeStatus(harness.workspace);
    expect(status.connected).toBe(true);
    expect(status.workspaceGranted).toBe(true);
    await harness.closeDeviceHarness();
  });
});

/**
 * A stolen `device.json` used to be an indefinite credential: the token never
 * changed and its window slid forward on every use, so a copy stayed valid for
 * as long as the thief kept connecting. Rotation made it a race — and then the
 * race would not END, because a displaced claimant was handed a fresh grace to
 * reconnect on. These pin the properties that make it terminate.
 */
describe('a copied device.json goes stale', () => {
  /** The daemon's own connect handshake, as `pc-handler` drives it: exchange the
   *  stored token for a ticket, then upgrade with that ticket. Answers the
   *  rotated token the hub pushes down the accepted socket.
   *
   *  The incumbent socket is dropped first, because that is the only state in
   *  which a redial is a redial: the hub refuses a newcomer while a socket for
   *  the device is live (`claimAgainstLiveSocket` below is that case). */
  async function connectDaemon(harness: TestUserDO, token: string): Promise<string | null> {
    harness.acceptedSockets.at(-1)?.drop();
    const issued = await harness.userDO.issueDeviceConnectTicket(await testOwner(), token);
    if (!issued.ok || !issued.ticket) return null;
    const response = await harness.userDO.fetch(new Request(
      `https://kinu.example.com${DEVICE_CONNECT_PATH}?ticket=${issued.ticket}`,
      { headers: { Upgrade: 'websocket', 'cf-connecting-ip': '203.0.113.7', 'user-agent': 'kinu-daemon/1' } },
    ));
    expect(response.status).toBe(101);
    // The rotation frame rides the socket the hub just accepted.
    const socket = harness.acceptedSockets.at(-1);
    const rotation = (socket?.sent ?? [])
      .map((raw) => v.safeParse(v.object({ type: v.string(), token: v.string() }), JSON.parse(raw)))
      .find((parsed) => parsed.success && parsed.output.type === DEVICE_TOKEN_ROTATION);
    return rotation?.success ? rotation.output.token : null;
  }

  /** A second claimant arriving while the device's socket is still live: the
   *  thief's case, and a duplicate daemon's. The newcomer wins the slot;
   *  returns the upgrade status. */
  async function claimAgainstLiveSocket(harness: TestUserDO, token: string): Promise<number> {
    const issued = await harness.userDO.issueDeviceConnectTicket(await testOwner(), token);
    if (!issued.ok || !issued.ticket) return 0;
    const response = await harness.userDO.fetch(new Request(
      `https://kinu.example.com${DEVICE_CONNECT_PATH}?ticket=${issued.ticket}`,
      { headers: { Upgrade: 'websocket', 'cf-connecting-ip': '198.51.100.9', 'user-agent': 'thief/1' } },
    ));
    return response.status;
  }

  /** The daemon's side of the rotation handshake: it persisted the new secret
   *  and says so, which is what ends the grace on the superseded one. */
  async function acknowledgeRotation(harness: TestUserDO): Promise<void> {
    const socket = harness.acceptedSockets.at(-1);
    if (!socket) throw new Error('no accepted device socket to acknowledge on');
    await harness.userDO.webSocketMessage(socket.ws, JSON.stringify({ type: DEVICE_TOKEN_ROTATION_ACK }));
  }

  function graceHash(harness: TestUserDO, deviceId: string): string | null {
    return v.parse(
      v.array(v.object({ prev_token_hash: v.nullable(v.string()) })),
      harness.sql.exec(`SELECT prev_token_hash FROM user_devices WHERE id = ?`, deviceId).toArray(),
    )[0].prev_token_hash;
  }

  test('the token rotates on every accepted connect, and the old copy dies', async () => {
    const harness = createTestUserDO({ deviceResponder: daemon });
    const { deviceId, token: first } = await harness.userDO.registerDevice(await testOwner(), 'ashish@studio');

    const second = await connectDaemon(harness, first);
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);

    // The real daemon persisted the rotation and reconnects with it. Either
    // half of the handshake ends the grace; the reconnect is the half that
    // survives a daemon too old to acknowledge.
    const third = await connectDaemon(harness, second ?? '');
    expect(third).toBeTruthy();

    // The thief still holds the file as it was written at link time.
    expect(await harness.userDO.verifyDeviceToken(await testOwner(), first)).toEqual({ ok: false });
    expect(await harness.userDO.issueDeviceConnectTicket(await testOwner(), first)).toEqual({ ok: false });
    // And the device itself is unharmed: its current secret works.
    expect(await harness.userDO.verifyDeviceToken(await testOwner(), third ?? ''))
      .toEqual({ ok: true, deviceId, current: true });
    await harness.joinFibers();
    harness.close();
  });

  test('a rotation lost with the socket does not brick the machine', async () => {
    const harness = createTestUserDO({ deviceResponder: daemon });
    const { deviceId, token: first } = await harness.userDO.registerDevice(await testOwner(), 'ashish@studio');

    // The hub rotated, but the daemon never saw the frame (socket died first),
    // so it redials with the secret it still has on disk.
    await connectDaemon(harness, first);
    // `current: false` is the point: the machine is recovering ON the grace,
    // which is the one accept that may not leave another behind.
    expect(await harness.userDO.verifyDeviceToken(await testOwner(), first))
      .toEqual({ ok: true, deviceId, current: false });
    await harness.joinFibers();
    harness.close();
  });

  test('acknowledging the rotation ends the grace, without waiting for a next call', async () => {
    const harness = createTestUserDO({ deviceResponder: daemon });
    const { deviceId, token: first } = await harness.userDO.registerDevice(await testOwner(), 'ashish@studio');

    const second = await connectDaemon(harness, first);
    // Until the machine says the new secret landed, the old one still opens a
    // socket — that grace is the whole reason a lost frame is survivable.
    expect(graceHash(harness, deviceId)).not.toBeNull();

    await acknowledgeRotation(harness);

    // The machine has it on disk, so the copy the thief holds is now nothing.
    expect(graceHash(harness, deviceId)).toBeNull();
    expect(await harness.userDO.verifyDeviceToken(await testOwner(), first)).toEqual({ ok: false });
    expect(await harness.userDO.verifyDeviceToken(await testOwner(), second ?? ''))
      .toEqual({ ok: true, deviceId, current: true });
    await harness.joinFibers();
    harness.close();
  });

  test('the grace is one-shot, so two claimants cannot alternate on it forever', async () => {
    const harness = createTestUserDO({ deviceResponder: daemon });
    const { deviceId, token: stolen } = await harness.userDO.registerDevice(await testOwner(), 'ashish@studio');

    // The thief connects first with the copied file, and does NOT acknowledge:
    // a hostile daemon has no reason to end its own grace.
    const thief = await connectDaemon(harness, stolen);
    expect(thief).toBeTruthy();

    // The real machine is displaced, redials with the secret on its disk, and
    // spends the grace. Before this fix that accept minted a FRESH grace over
    // the thief's token, so each side's reconnect re-armed the other's and the
    // pair alternated every second indefinitely, both always holding a live
    // token.
    const real = await connectDaemon(harness, stolen);
    expect(real).toBeTruthy();
    expect(real).not.toBe(thief);

    // The thief's rotated token is neither current nor grace: the chain ends.
    expect(await harness.userDO.verifyDeviceToken(await testOwner(), thief ?? '')).toEqual({ ok: false });
    expect(await harness.userDO.issueDeviceConnectTicket(await testOwner(), thief ?? ''))
      .toEqual({ ok: false });
    expect(await harness.userDO.verifyDeviceToken(await testOwner(), real ?? ''))
      .toEqual({ ok: true, deviceId, current: true });
    await harness.joinFibers();
    harness.close();
  });

  test('the window is absolute from the last rotation, not slid by use', async () => {
    const harness = createTestUserDO({ deviceResponder: daemon });
    const { deviceId, token } = await harness.userDO.registerDevice(await testOwner(), 'ashish@studio');
    const expiry = () => v.parse(
      v.array(v.object({ expires_at: v.number() })),
      harness.sql.exec(`SELECT expires_at FROM user_devices WHERE id = ?`, deviceId).toArray(),
    )[0].expires_at;
    // A window far enough out to be unmistakable: an idle-sliding
    // implementation rewrites it to ~now+TTL, which is a different number, while
    // an absolute one leaves it exactly where the last rotation put it. Reading
    // the stored value rather than a clock is what makes this test independent
    // of how fast the suite runs.
    const anchor = Date.now() + 400 * 24 * 60 * 60 * 1000;
    harness.sql.exec(`UPDATE user_devices SET expires_at = ? WHERE id = ?`, anchor, deviceId);

    expect(await harness.userDO.verifyDeviceToken(await testOwner(), token))
      .toEqual({ ok: true, deviceId, current: true });
    expect(expiry()).toBe(anchor);

    // An elapsed window is refused, however recently the token was used.
    harness.sql.exec(`UPDATE user_devices SET expires_at = ? WHERE id = ?`, 1, deviceId);
    expect(await harness.userDO.verifyDeviceToken(await testOwner(), token)).toEqual({ ok: false });
    await harness.joinFibers();
    harness.close();
  });

  test('a second claimant takes the slot and is recorded where the owner reads it', async () => {
    const harness = createTestUserDO({ deviceResponder: daemon });
    const { deviceId, token } = await harness.userDO.registerDevice(await testOwner(), 'ashish@studio');

    const rotated = await connectDaemon(harness, token);
    expect((await harness.userDO.listDevices(await testOwner()))[0]).toMatchObject({
      id: deviceId, lastIp: '203.0.113.7', lastAgent: 'kinu-daemon/1', replacedAt: null,
    });
    const incumbent = harness.acceptedSockets.at(-1);

    // A second claimant arrives while that socket is live and TAKES the slot: a
    // real machine redialling must not be locked out by a socket the hub has
    // not noticed closing. What stops the alternation this used to start is the
    // one-shot grace above, not a refusal here.
    expect(await claimAgainstLiveSocket(harness, rotated ?? '')).toBe(101);

    // Recorded where the owner reads the device, and the incumbent is closed.
    const [row] = await harness.userDO.listDevices(await testOwner());
    expect(row.replacedAt).not.toBeNull();
    expect(row.connected).toBe(true);
    expect(harness.acceptedSockets.at(-1)).not.toBe(incumbent);
    expect((incumbent?.sent ?? []).filter((raw) => raw.includes(DEVICE_TOKEN_ROTATION))).toHaveLength(1);
    await harness.joinFibers();
    harness.close();
  });
});

describe('device RPC stays unreachable from owner HTTP routes', () => {
  test('no /api/user route forwards an arbitrary method to deviceRpc', () => {
    const source = readFileSync(new URL('../src/user/routes.ts', import.meta.url).pathname, 'utf8');
    // Checkpoint reads are the only consent-free methods. An HTTP pass-through
    // would still widen the owner route into an undeclared device RPC surface.
    expect(source).not.toContain('deviceRpc');
  });
});
