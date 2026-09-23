/**
 * Consent is resolved at the one chokepoint, `UserDO.deviceRpc`, against the proven workspace:
 * driven over a real UserDO whose device socket answers, so a grant that did nothing is visible.
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
import type { UserCaller } from '@kinu.run/core';
import { DeviceSocketHub } from '@kinu.run/core';
import { USER_DO_RPC_SURFACE } from '../src/rpc-surface';
import {
  DEVICE_CONNECT_PATH, DEVICE_CONSENT_DENIED,
  DEVICE_TOKEN_ROTATION, DEVICE_TOKEN_ROTATION_ACK,
  DEVICE_CANCEL_METHOD, DEVICE_CANCEL_PROTOCOL, DEVICE_EXEC_ACK_METHOD, JsonValueSchema, nextDeviceRequestId,
  NO_DEVICE_CONNECTED, type JsonValue,
} from '@kinu.run/core';
import { present } from '@kinu.run/test-utils';


const DeviceRpcFrameSchema = v.object({
  id: v.string(),
  method: v.string(),
  params: v.array(JsonValueSchema),
});

const UnstoppedRowSchema = v.object({ unstopped_at: v.nullable(v.number()) });

describe('the per-workspace device grant, enforced at the hub chokepoint', () => {
  test('an ungranted workspace is refused, and nothing reaches the machine', async () => {
    const harness = await deviceHarness();
    // An unanswered prompt is not a refusal, but it is not a grant either.
    harness.consentDecision = 'deny';

    await expect(harness.userDO.deviceRpc(harness.workspace, 'exec', ['rm -rf ~/work'], {
      agentName: WORKSPACE,
    })).rejects.toThrow(DEVICE_CONSENT_DENIED);

    // Refused before the device: at the executor boundary, not a message the daemon ignores.
    expect(harness.deviceFrames.filter((f) => f.method === 'exec')).toEqual([]);
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

    // Recorded on the base tier a card can record; an exec asks every time, deliberately.
    await harness.userDO.deviceRpc(harness.workspace, 'readFile', ['/home/me/a.md'], {
      agentName: WORKSPACE,
    });
    expect(harness.consentPrompts).toHaveLength(1);

    await harness.userDO.deviceRpc(harness.workspace, 'readFile', ['/home/me/b.md'], {
      agentName: WORKSPACE,
    });
    expect(harness.consentPrompts).toHaveLength(1);
    expect(harness.deviceFrames.filter((f) => f.method === 'readFile').map((f) => f.params[0]))
      .toEqual(['/home/me/a.md', '/home/me/b.md']);
    await harness.closeDeviceHarness();
  });


  test('one binding covers the shell too — the owner is asked once, not once per method', async () => {
    // One question: a grant must not leave `exec` gated. What a command may touch is the device's
    // own Sandbox switch.
    const harness = await deviceHarness();
    harness.consentDecision = 'always';
    await harness.userDO.deviceRpc(harness.workspace, 'readFile', ['/tmp/a'], { agentName: WORKSPACE });
    expect(harness.consentPrompts).toHaveLength(1);

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

    // The /pc mount reads through this same call, so an ungranted read is refused too.
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

    // Revocation deletes the remembered policy rather than storing a refusal, so the workspace is
    // asked again.
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

  /** Stopping is not starting: gating a cancel would put a live process behind an unanswered
   *  card. */
  test('a cancellation reaches the machine while consent is refusing new work', async () => {
    const harness = await deviceHarness();
    harness.consentDecision = 'deny';
    const requestId = 'rpc-epoch1-7';

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
    expect(harness.consentPrompts.map((prompt) => prompt.method)).toEqual(['exec']);
    await harness.closeDeviceHarness();
  });

  test('the identity the caller minted is the id the command is issued under', async () => {
    // A later cancellation names this id, so the hub forwards the caller's id verbatim.
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
   * A binding is read by name on every later call, so it lives as long as the thing it names.
   * Outliving it is unrepresentable (one binding, no scope; rows written only on the card path).
   */
  test('deleting a workspace deletes its device bindings, so a same-name replacement inherits nothing', async () => {
    const harness = await deviceHarness();
    const owner = await testOwner();
    harness.consentDecision = 'always';
    await harness.userDO.deviceRpc(harness.workspace, 'readFile', ['/tmp/a'], { agentName: WORKSPACE });
    expect((await harness.userDO.listDeviceConsents(owner)).map((row) => row.agentName)).toEqual([WORKSPACE]);

    await harness.userDO.removeWorkspace(owner, WORKSPACE, '0'.repeat(32));
    expect(await harness.userDO.listDeviceConsents(owner)).toEqual([]);

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

  /** The provider half of detached device ownership; the consumer lives in the turn/job
   *  subsystem. */
  test('the ownership seam a background-job consumer needs is reachable and native', async () => {
    const harness = await deviceHarness();

    const seam = {
      transferDeviceRequestToBackgroundJob: harness.userDO.transferDeviceRequestToBackgroundJob.bind(harness.userDO),
      cancelDeviceRequestsForBackgroundJob: harness.userDO.cancelDeviceRequestsForBackgroundJob.bind(harness.userDO),
      acknowledgeDeviceRequest: harness.userDO.acknowledgeDeviceRequest.bind(harness.userDO),
    };

    for (const [name, member] of Object.entries(seam)) {
      expect(member).toBeFunction();
      expect(USER_DO_RPC_SURFACE).toContain(name);
    }

    // A per-request transfer takes one request and one job identity: no turn argument can widen it.
    expect(seam.transferDeviceRequestToBackgroundJob).toHaveLength(3);
    await harness.closeDeviceHarness();
  });

  /** The sweep claims eligible rows before its first device await: a mid-sweep detach cannot
   *  move a claimed request, nor be cancelled by a sweep it escaped. */
  test('a detach racing an in-flight turn sweep loses to the sweep claim', async () => {
    const harness = await deviceHarness();
    const claimed = nextDeviceRequestId();
    harness.db.prepare(
      `INSERT INTO device_inflight_requests (request_id, device_id, workspace, turn_id)
       VALUES (?, ?, ?, ?)`,
    ).run(claimed, harness.deviceId, WORKSPACE, 'turn-1');

    const sweep = harness.userDO.cancelDeviceRequestsForTurn(harness.workspace, 'turn-1');
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

    expect(await harness.userDO.cancelDeviceRequestsForTurn(harness.workspace, 'turn-1'))
      .toEqual([{ requestId, outcome: 'terminated' }]);
    expect(await harness.userDO.transferDeviceRequestToBackgroundJob(harness.workspace, requestId, 'job-1'))
      .toEqual({ transferred: false });

    // The retry cleans up and never kills the dead process group a second time.
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

    // Death is durable: a new activation refuses the transfer even before cleaning the row up.
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
        return { requestId: v.parse(v.string(), frame.params[0]), cancelled: 'unknown' };
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

    expect(await harness.userDO.cancelDeviceRequestsForTurn(harness.workspace, 'turn-1'))
      .toEqual([{ requestId, outcome: 'unknown' }]);
    expect(await harness.userDO.transferDeviceRequestToBackgroundJob(harness.workspace, requestId, 'job-1'))
      .toEqual({ transferred: false });

    // A cleanup retry reports the stored answer, never a termination this sweep did not observe.
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

    // A confirmed stop must never regress into "the kill failed" when the cleanup socket is gone.
    expect(await harness.userDO.cancelDeviceRequestsForTurn(harness.workspace, 'turn-1'))
      .toEqual([{ requestId, outcome: 'terminated' }]);
    expect(await harness.userDO.transferDeviceRequestToBackgroundJob(harness.workspace, requestId, 'job-1'))
      .toEqual({ transferred: false });
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
    harness.db.prepare(`UPDATE user_devices SET revoked_at = ? WHERE id = ?`)
      .run(Date.now(), harness.deviceId);

    // The daemon can never reconnect, so a job adopting this could never cancel it.
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

    expect(await harness.userDO.transferDeviceRequestToBackgroundJob(harness.workspace, requestId, 'job-1'))
      .toEqual({ transferred: true });
    harness.db.prepare(`UPDATE user_devices SET revoked_at = ? WHERE id = ?`)
      .run(Date.now(), harness.deviceId);
    expect(await harness.userDO.transferDeviceRequestToBackgroundJob(harness.workspace, requestId, 'job-1'))
      .toEqual({ transferred: false });
    await harness.closeDeviceHarness();
  });

  test('an exec refuses an owner that does not name a job', async () => {
    const harness = await deviceHarness();
    harness.consentDecision = 'always';
    const requestId = nextDeviceRequestId();

    // A blank owner would insert a row no sweep can ever select: the orphan this table prevents.
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
    harness.db.prepare(`UPDATE user_devices SET revoked_at = ?, unstopped_at = ? WHERE id = ?`)
      .run(Date.now(), Date.now(), harness.deviceId);

    // Clearing here could retire a warning about a process no one has confirmed.
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

    await harness.userDO.deviceRpc(harness.workspace, DEVICE_CANCEL_METHOD, [requestId, DEVICE_CANCEL_PROTOCOL], {
      agentName: WORKSPACE,
    });

    // The sweep reports the already-stored answer and sends no second kill: the paths cannot
    // disagree.
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
    // The probe is the one await between admission and the durable row: where a revocation can slip
    // past.
    revokeNow = () => {
      harness.db.prepare(`UPDATE user_devices SET revoked_at = ? WHERE id = ?`)
        .run(Date.now(), harness.deviceId);
    };

    const requestId = nextDeviceRequestId();

    await expect(harness.userDO.deviceRpc(harness.workspace, 'exec', ['sleep 30'], {
      agentName: WORKSPACE, requestId,
    })).rejects.toThrow(NO_DEVICE_CONNECTED);
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

    // Mid-cancellation the row has not changed hands: a detach must not read the old owner as
    // success.
    expect(await harness.userDO.transferDeviceRequestToBackgroundJob(harness.workspace, requestId, 'job-1'))
      .toEqual({ transferred: false });
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

    stealClaim = () => {
      harness.db.prepare(`UPDATE device_inflight_requests SET cancel_claim = ? WHERE request_id = ?`)
        .run('claim-of-the-revocation', second);
      stealClaim = null;
    };

    expect(await harness.userDO.cancelDeviceRequestsForTurn(harness.workspace, 'turn-1'))
      .toEqual([{ requestId: first, outcome: 'terminated' }]);
    // Exactly one authority cancels and reports a request.
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
    expect(seenAtFrame).toHaveLength(1);
    expect(seenAtFrame[0]).toBeNumber();
    // Every kill confirmed: nothing is left to warn about, so the revoked device leaves the roster.
    expect(await harness.userDO.listDevices(await testOwner())).toEqual([]);
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
    const status = await harness.userDO.deviceRuntimeStatus(harness.workspace);

    expect(status.connected).toBe(true);
    expect(status.workspaceGranted).toBe(false);
    expect(status.devices).toMatchObject([
      { id: harness.deviceId, name: 'ashish@studio', os: 'linux', hostname: 'studio', connected: true },
    ]);
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
  test('the call refuses and names the registered machines on the workspace rail', async () => {
    const harness = createTestUserDO();
    const workspace = await provisionTestWorkspace(harness, WORKSPACE, 'Workspace A');
    const { deviceId } = await harness.userDO.registerDevice(await testOwner(), 'studio tower');

    await expect(harness.userDO.deviceRpc({ workspaceToken: workspace }, 'exec', ['make build'], {
      agentName: WORKSPACE,
    })).rejects.toThrow(NO_DEVICE_CONNECTED);

    expect(harness.consentPrompts).toEqual([]);
    expect(harness.unavailableNotices).toEqual([{
      workspace: WORKSPACE,
      devices: [{ id: deviceId, label: 'studio tower', lastSeenAt: null }],
    }]);
    await harness.joinFibers();
    harness.close();
  });

  test('no registered machine: the notice carries no devices', async () => {
    const harness = createTestUserDO();
    const workspace = await provisionTestWorkspace(harness, WORKSPACE, 'Workspace A');

    await expect(harness.userDO.deviceRpc({ workspaceToken: workspace }, 'exec', ['make build'], {
      agentName: WORKSPACE,
    })).rejects.toThrow(NO_DEVICE_CONNECTED);

    expect(harness.consentPrompts).toEqual([]);
    expect(harness.unavailableNotices).toEqual([{ workspace: WORKSPACE, devices: [] }]);
    await harness.joinFibers();
    harness.close();
  });

  test('a retrying agent sends one notice per refused call, and no card', async () => {
    const harness = createTestUserDO();
    const workspace = await provisionTestWorkspace(harness, WORKSPACE, 'Workspace A');

    const first = harness.userDO.deviceRpc({ workspaceToken: workspace }, 'exec', ['make build'], {
      agentName: WORKSPACE,
    });

    const retry = harness.userDO.deviceRpc({ workspaceToken: workspace }, 'exec', ['make build'], {
      agentName: WORKSPACE,
    });

    const outcomes = await Promise.allSettled([first, retry]);

    expect(outcomes.map((o) => o.status)).toEqual(['rejected', 'rejected']);

    for (const outcome of outcomes) {
      expect(String(outcome.status === 'rejected' ? outcome.reason : '')).toContain(NO_DEVICE_CONNECTED);
    }

    expect(harness.consentPrompts).toEqual([]);
    expect(harness.unavailableNotices).toEqual([
      { workspace: WORKSPACE, devices: [] },
      { workspace: WORKSPACE, devices: [] },
    ]);
    await harness.joinFibers();
    harness.close();
  });

  test('the round trip completes: request, connect, grant, execute', async () => {
    const harness = createTestUserDO({ deviceResponder: daemon });
    const token = await provisionTestWorkspace(harness, WORKSPACE, 'Workspace A');
    const caller: UserCaller = { workspaceToken: token };

    await expect(harness.userDO.deviceRpc(caller, 'exec', ['make build'], { agentName: WORKSPACE }))
      .rejects.toThrow(NO_DEVICE_CONNECTED);
    expect(harness.consentPrompts).toEqual([]);
    expect(harness.unavailableNotices).toEqual([{ workspace: WORKSPACE, devices: [] }]);
    expect(harness.deviceFrames).toEqual([]);

    // A daemon that proves nothing on connect runs no commands.
    const { deviceId } = await harness.userDO.registerDevice(await testOwner(), 'studio');
    harness.attachDevice(deviceId);
    await harness.sendDeviceHello(CAPABLE_HELLO);
    const seen = await harness.userDO.deviceRuntimeStatus(caller);
    expect(seen.devices?.map((d) => d.name)).toEqual(['studio']);
    expect(seen.workspaceGranted).toBe(false);

    harness.consentDecision = 'always';
    const result = await harness.userDO.deviceRpc(caller, 'exec', ['make build'], { agentName: WORKSPACE });

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

  test('a daemon connecting announces the machine where the notice went', async () => {
    const harness = createTestUserDO();
    const token = await provisionTestWorkspace(harness, WORKSPACE, 'Workspace A');

    await expect(harness.userDO.deviceRpc({ workspaceToken: token }, 'exec', ['make build'], {
      agentName: WORKSPACE,
    })).rejects.toThrow(NO_DEVICE_CONNECTED);

    const { deviceId, token: deviceToken } = await harness.userDO.registerDevice(await testOwner(), 'studio');
    const issued = await harness.userDO.issueDeviceConnectTicket(await testOwner(), deviceToken);

    if (!issued.ok || !issued.ticket) throw new Error('the owner could not mint a connect ticket');

    const upgrade = await harness.userDO.fetch(new Request(
      `https://kinu.example.com${DEVICE_CONNECT_PATH}?ticket=${issued.ticket}`,
      { headers: { Upgrade: 'websocket' } },
    ));

    expect(upgrade.status).toBe(101);
    const device = harness.acceptedSockets.at(-1);

    if (!device) throw new Error('the device upgrade produced no socket');
    await harness.userDO.webSocketMessage(device.ws, JSON.stringify(CAPABLE_HELLO));

    expect(harness.availableNotices).toEqual([{
      workspace: WORKSPACE, device: { id: deviceId, label: 'studio' },
    }]);

    await harness.joinFibers();
    harness.close();
  });

  test('a connect clears the notice on the told workspace only', async () => {
    const harness = createTestUserDO();
    const first = await provisionTestWorkspace(harness, WORKSPACE, 'Workspace A');
    await provisionTestWorkspace(harness, OTHER_WORKSPACE, 'Workspace B');
    const owner = await testOwner();
    await harness.userDO.registerDevice(owner, 'studio-tower');

    await expect(harness.userDO.deviceRpc({ workspaceToken: first }, 'exec', ['make build'], {
      agentName: WORKSPACE,
    })).rejects.toThrow(NO_DEVICE_CONNECTED);
    expect(harness.unavailableNotices.map((n) => n.workspace)).toEqual([WORKSPACE]);

    const pending = harness.db.query<{ agent_name: string }, []>('SELECT agent_name FROM device_notice_pending ORDER BY agent_name ASC').all();
    expect(pending.map((row) => row.agent_name)).toEqual([WORKSPACE]);
    const { token: deviceToken } = await harness.userDO.registerDevice(owner, 'studio');

    const issued = await harness.userDO.issueDeviceConnectTicket(owner, deviceToken);

    if (!issued.ok || !issued.ticket) throw new Error('the owner could not mint a connect ticket');

    const upgrade = await harness.userDO.fetch(new Request(`https://kinu.example.com${DEVICE_CONNECT_PATH}?ticket=${issued.ticket}`, { headers: { Upgrade: 'websocket' } }));
    expect(upgrade.status).toBe(101);
    const device = harness.acceptedSockets.at(-1);

    if (!device) throw new Error('the device upgrade produced no socket');
    await harness.userDO.webSocketMessage(device.ws, JSON.stringify(CAPABLE_HELLO));
    expect(harness.availableNotices.map((n) => n.workspace)).toEqual([WORKSPACE]);
    expect(harness.db.query('SELECT agent_name FROM device_notice_pending').all()).toEqual([]);

    await harness.joinFibers();
    harness.close();
  });

});

describe('the owner\'s sequence: a live machine, an ungranted workspace, one ask', () => {
  test('a connected device raises the GRANT card, never the offline notice', async () => {
    const harness = await deviceHarness();
    harness.consentDecision = 'deny';

    await expect(harness.userDO.deviceRpc(harness.workspace, 'exec', ['ls'], {
      agentName: WORKSPACE,
    })).rejects.toThrow(DEVICE_CONSENT_DENIED);

    expect(harness.consentPrompts).toEqual([{
      workspace: WORKSPACE,
      method: 'exec',
      command: 'ls',
      workspaceName: WORKSPACE,
    }]);
    expect(harness.unavailableNotices).toEqual([]);
    await harness.closeDeviceHarness();
  });
});

/**
 * A machine the workspace cannot use reads offline in the Env grid until the owner answers for it.
 */
describe('the machine the agent asked for, as the owner reads it', () => {
  test('no device: the offline notice, and no device row to render', async () => {
    const harness = createTestUserDO();
    const workspace = await provisionTestWorkspace(harness, WORKSPACE, 'Workspace A');

    await expect(harness.userDO.deviceRpc({ workspaceToken: workspace }, 'exec', ['make'], {
      agentName: WORKSPACE,
    })).rejects.toThrow(NO_DEVICE_CONNECTED);
    expect(harness.unavailableNotices).toEqual([{ workspace: WORKSPACE, devices: [] }]);

    const status = await harness.userDO.deviceRuntimeStatus({ workspaceToken: workspace });
    expect(status.connected).toBe(false);
    expect(status.workspaceGranted).toBeUndefined();
    await harness.joinFibers();
    harness.close();
  });

  test('device offline: the offline notice, and an offline row', async () => {
    const harness = await deviceHarness();
    harness.attachDevice(null);

    await expect(harness.userDO.deviceRpc(harness.workspace, 'exec', ['make'], {
      agentName: WORKSPACE,
    })).rejects.toThrow(NO_DEVICE_CONNECTED);
    expect(harness.unavailableNotices).toHaveLength(1);
    expect(harness.unavailableNotices[0]?.workspace).toBe(WORKSPACE);
    expect(harness.unavailableNotices[0]?.devices.map((d) => d.label)).toEqual(['ashish@studio']);

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
    expect(harness.consentPrompts).toEqual([{
      workspace: WORKSPACE,
      method: 'exec',
      command: 'make',
      workspaceName: WORKSPACE,
    }]);
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
 * A stolen `device.json` must not be an indefinite credential: rotation makes it a race, and a
 * displaced claimant must never get a fresh grace, or the race never ends.
 */
describe('a copied device.json goes stale', () => {
  /** The incumbent socket is dropped first: the hub refuses a newcomer while the device's socket
   *  is live. */
  async function connectDaemon(harness: TestUserDO, token: string): Promise<string | null> {
    harness.acceptedSockets.at(-1)?.drop();
    const issued = await harness.userDO.issueDeviceConnectTicket(await testOwner(), token);

    if (!issued.ok || !issued.ticket) return null;

    const response = await harness.userDO.fetch(new Request(
      `https://kinu.example.com${DEVICE_CONNECT_PATH}?ticket=${issued.ticket}`,
      { headers: { Upgrade: 'websocket', 'cf-connecting-ip': '203.0.113.7', 'user-agent': 'kinu-daemon/1' } },
    ));

    expect(response.status).toBe(101);
    const socket = harness.acceptedSockets.at(-1);

    const rotation = (socket?.sent ?? [])
      .map((raw) => v.safeParse(v.object({ type: v.string(), token: v.string() }), JSON.parse(raw)))
      .find((parsed) => parsed.success && parsed.output.type === DEVICE_TOKEN_ROTATION);

    return rotation?.success ? rotation.output.token : null;
  }

  /** The thief's case, and a duplicate daemon's: the newcomer wins the slot. */
  async function claimAgainstLiveSocket(harness: TestUserDO, token: string): Promise<number> {
    const issued = await harness.userDO.issueDeviceConnectTicket(await testOwner(), token);

    if (!issued.ok || !issued.ticket) return 0;

    const response = await harness.userDO.fetch(new Request(
      `https://kinu.example.com${DEVICE_CONNECT_PATH}?ticket=${issued.ticket}`,
      { headers: { Upgrade: 'websocket', 'cf-connecting-ip': '198.51.100.9', 'user-agent': 'thief/1' } },
    ));

    return response.status;
  }

  /** Acknowledging the persisted secret ends the grace on the superseded one. */
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

  /** The account's row for one device, as Settings → Devices reads it; undefined once it is gone. */
  async function deviceRow(harness: TestUserDO, deviceId: string) {
    return (await harness.userDO.listDevices(await testOwner())).find((device) => device.id === deviceId);
  }

  test('the token rotates on every accepted connect, and the current one keeps working', async () => {
    const harness = createTestUserDO({ deviceResponder: daemon });
    const { deviceId, token: first } = await harness.userDO.registerDevice(await testOwner(), 'ashish@studio');

    const second = await connectDaemon(harness, first);
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);

    // Either half of the handshake ends the grace; the reconnect survives a daemon too old to
    // acknowledge.
    const third = await connectDaemon(harness, second ?? '');
    expect(third).toBeTruthy();

    expect(await harness.userDO.verifyDeviceToken(await testOwner(), third ?? ''))
      .toEqual({ ok: true, deviceId, current: true });
    await harness.joinFibers();
    harness.close();
  });

  test('a rotation lost with the socket does not brick the machine', async () => {
    const harness = createTestUserDO({ deviceResponder: daemon });
    const { deviceId, token: first } = await harness.userDO.registerDevice(await testOwner(), 'ashish@studio');

    await connectDaemon(harness, first);
    // Recovering on the grace is the one accept that may not leave another behind.
    expect(await harness.userDO.verifyDeviceToken(await testOwner(), first))
      .toEqual({ ok: true, deviceId, current: false });
    await harness.joinFibers();
    harness.close();
  });

  test('acknowledging the rotation ends the grace, without waiting for a next call', async () => {
    const harness = createTestUserDO({ deviceResponder: daemon });
    const { deviceId, token: first } = await harness.userDO.registerDevice(await testOwner(), 'ashish@studio');

    const second = await connectDaemon(harness, first);
    // Until the machine acknowledges, the old secret still opens a socket: that grace makes a lost
    // frame survivable.
    expect(graceHash(harness, deviceId)).not.toBeNull();

    await acknowledgeRotation(harness);

    expect(graceHash(harness, deviceId)).toBeNull();
    expect(await harness.userDO.verifyDeviceToken(await testOwner(), second ?? ''))
      .toEqual({ ok: true, deviceId, current: true });
    await harness.joinFibers();
    harness.close();
  });

  test('the grace is one-shot: the secret the recovery dropped names a second copy', async () => {
    const harness = createTestUserDO({ deviceResponder: daemon });
    const { deviceId, token: stolen } = await harness.userDO.registerDevice(await testOwner(), 'ashish@studio');

    const thief = await connectDaemon(harness, stolen);
    expect(thief).toBeTruthy();

    // Spending the grace must not mint a fresh one over the thief's token, or the two reconnects
    // re-arm each other indefinitely.
    const real = await connectDaemon(harness, stolen);
    expect(real).toBeTruthy();
    expect(real).not.toBe(thief);
    expect(await harness.userDO.verifyDeviceToken(await testOwner(), real ?? ''))
      .toEqual({ ok: true, deviceId, current: true });
    const live = harness.acceptedSockets.at(-1);

    // Two parties hold this device's secrets and the hub cannot tell which is the owner's, so the
    // thief's next try revokes the device rather than being merely refused.
    expect(await harness.userDO.issueDeviceConnectTicket(await testOwner(), thief ?? '')).toEqual({ ok: false });
    expect(live?.ws.readyState).toBe(WebSocket.CLOSED);
    expect(await harness.userDO.verifyDeviceToken(await testOwner(), real ?? '')).toEqual({ ok: false });
    expect(await deviceRow(harness, deviceId)).toMatchObject({ revokedAt: expect.any(Number), reuseDetectedAt: expect.any(Number) });
    await harness.joinFibers();
    harness.close();
  });

  test('a retired key presented again revokes the device, closes its socket, and waits for the owner', async () => {
    // SECURITY-devices C3. Whichever copy of device.json acknowledged first holds the only valid
    // secret; the other copy's return is the only evidence there are two. The live socket may be
    // the thief's, so it closes too.
    const harness = createTestUserDO({ deviceResponder: daemon });
    const { deviceId, token: copied } = await harness.userDO.registerDevice(await testOwner(), 'ashish@studio');
    const current = await connectDaemon(harness, copied);
    await acknowledgeRotation(harness);
    const live = harness.acceptedSockets.at(-1);
    expect(live?.ws.readyState).toBe(WebSocket.OPEN);

    expect(await harness.userDO.issueDeviceConnectTicket(await testOwner(), copied)).toEqual({ ok: false });

    expect(live?.ws.readyState).toBe(WebSocket.CLOSED);
    expect(await harness.userDO.verifyDeviceToken(await testOwner(), current ?? '')).toEqual({ ok: false });
    expect(await deviceRow(harness, deviceId)).toMatchObject({
      connected: false, revokedAt: expect.any(Number), unstoppedAt: null, reuseDetectedAt: expect.any(Number),
    });

    // The incident stays until the owner has read it; acknowledging removes the device.
    expect(await harness.userDO.acknowledgeUnstoppedDevice(await testOwner(), deviceId)).toEqual({ ok: true });
    expect(await deviceRow(harness, deviceId)).toBeUndefined();
    await harness.joinFibers();
    harness.close();
  });

  test('a machine that keeps its secret current never reads as a copy', async () => {
    const harness = createTestUserDO({ deviceResponder: daemon });
    const { deviceId, token: first } = await harness.userDO.registerDevice(await testOwner(), 'ashish@studio');
    let held = first;

    for (let round = 1; round <= 3; round += 1) {
      held = present(await connectDaemon(harness, held), `rotation ${String(round)}`);
      await acknowledgeRotation(harness);
    }

    // One rotation lost with its socket: the machine never saw it and recovers on the grace.
    present(await connectDaemon(harness, held), 'the lost rotation');
    held = present(await connectDaemon(harness, held), 'the recovery');
    await acknowledgeRotation(harness);
    held = present(await connectDaemon(harness, held), 'the next connect');
    await acknowledgeRotation(harness);

    expect(await harness.userDO.verifyDeviceToken(await testOwner(), held)).toEqual({ ok: true, deviceId, current: true });
    expect(await deviceRow(harness, deviceId)).toMatchObject({ revokedAt: null, reuseDetectedAt: null, connected: true });
    await harness.joinFibers();
    harness.close();
  });

  test('a retired key is remembered for the token lifetime, then forgotten', async () => {
    const harness = createTestUserDO({ deviceResponder: daemon });
    const { deviceId, token: first } = await harness.userDO.registerDevice(await testOwner(), 'ashish@studio');
    const second = present(await connectDaemon(harness, first), 'the first rotation');
    await acknowledgeRotation(harness);
    // Retired longer ago than a device token lives (180 days): it would have expired unrotated.
    harness.sql.exec(`UPDATE user_device_retired_tokens SET retired_at = ?`, Date.now() - 181 * 24 * 60 * 60 * 1000);

    const third = present(await connectDaemon(harness, second), 'the second rotation');
    await acknowledgeRotation(harness);

    // Retiring the second secret forgot the first, so the store holds one row per live window.
    expect(v.parse(
      v.array(v.object({ n: v.number() })),
      harness.sql.exec(`SELECT COUNT(*) AS n FROM user_device_retired_tokens`).toArray(),
    )[0].n).toBe(1);
    // Forgotten is refused, not reported: that secret expired on its own long ago.
    expect(await harness.userDO.verifyDeviceToken(await testOwner(), first)).toEqual({ ok: false });
    expect(await harness.userDO.verifyDeviceToken(await testOwner(), third)).toEqual({ ok: true, deviceId, current: true });
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

    // An idle-sliding window would be rewritten to ~now+TTL; an absolute one stays put. Reading the
    // stored value keeps this independent of suite speed.
    const anchor = Date.now() + 400 * 24 * 60 * 60 * 1000;
    harness.sql.exec(`UPDATE user_devices SET expires_at = ? WHERE id = ?`, anchor, deviceId);

    expect(await harness.userDO.verifyDeviceToken(await testOwner(), token))
      .toEqual({ ok: true, deviceId, current: true });
    expect(expiry()).toBe(anchor);

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

    // A redialling machine must not be locked out by a socket the hub has not seen close: the one-
    // shot
    // grace, not a refusal here, stops the alternation.
    expect(await claimAgainstLiveSocket(harness, rotated ?? '')).toBe(101);

    const [row] = await harness.userDO.listDevices(await testOwner());
    expect(row.replacedAt).not.toBeNull();
    expect(row.connected).toBe(true);
    expect(harness.acceptedSockets.at(-1)).not.toBe(incumbent);
    expect((incumbent?.sent ?? []).filter((raw) => raw.includes(DEVICE_TOKEN_ROTATION))).toHaveLength(1);
    await harness.joinFibers();
    harness.close();
  });
});

describe('the account keeps one row per linked machine', () => {
  test('a revoked device with nothing left to report is removed, not kept', async () => {
    const harness = createTestUserDO({ deviceResponder: daemon });
    const { deviceId, token } = await harness.userDO.registerDevice(await testOwner(), 'ashish@studio');

    expect(await harness.userDO.revokeDevice(await testOwner(), deviceId)).toEqual({ ok: true, unstoppedCommands: 0 });

    expect(harness.sql.exec(`SELECT id FROM user_devices WHERE id = ?`, deviceId).toArray()).toEqual([]);
    expect(await harness.userDO.verifyDeviceToken(await testOwner(), token)).toEqual({ ok: false });
    await harness.joinFibers();
    harness.close();
  });

  test('linking a machine again replaces its old registration instead of adding a row', async () => {
    const harness = createTestUserDO({ deviceResponder: daemon });
    const owner = await testOwner();
    const first = await harness.userDO.registerDevice(await testOwner(), 'ashish@studio');

    // `kinu connect` run again sends the token its device.json held.
    const again = await harness.userDO.registerDevice(owner, 'ashish@studio', first.token);

    expect((await harness.userDO.listDevices(owner)).map((device) => device.id)).toEqual([again.deviceId]);
    expect(await harness.userDO.verifyDeviceToken(owner, first.token)).toEqual({ ok: false });
    await harness.joinFibers();
    harness.close();
  });

  test('a reported host name or path no machine can have is not stored', async () => {
    const harness = await deviceHarness('ashish@studio', daemon, {
      hello: { ...CAPABLE_HELLO, hostname: 'h'.repeat(256), root: `/${'d'.repeat(4096)}` },
    });

    // RFC 1035 bounds a name at 255 octets and PATH_MAX a path at 4096 bytes.
    const [row] = await harness.userDO.listDevices(await testOwner());
    expect(row.hostname).toBeNull();
    const runtime = await harness.userDO.deviceRuntimeStatus(harness.workspace);
    expect(JSON.stringify(runtime)).not.toContain('d'.repeat(4096));

    await harness.sendDeviceHello({ ...CAPABLE_HELLO, hostname: 'h'.repeat(255) });
    expect((await harness.userDO.listDevices(await testOwner()))[0].hostname).toBe('h'.repeat(255));
    await harness.closeDeviceHarness();
  });
});

describe('a workspace\'s device checkpoints are its own', () => {
  test('another workspace\'s store is refused by name, before any frame leaves', async () => {
    const harness = await deviceHarness();
    harness.consentDecision = 'always';

    for (const [method, params] of [
      ['checkpointList', [OTHER_WORKSPACE, 50, null]],
      ['checkpointPlan', [OTHER_WORKSPACE, '/home/ashish/work', 'c0ffee1']],
      ['checkpointRestore', [OTHER_WORKSPACE, '/home/ashish/work', 'c0ffee1']],
    ] satisfies Array<[string, JsonValue[]]>) {
      await expect(harness.userDO.deviceRpc(harness.workspace, method, params))
        .rejects.toThrow('reads and restores only its own device checkpoints');
    }

    expect(harness.deviceFrames).toEqual([]);
    await harness.userDO.deviceRpc(harness.workspace, 'checkpointList', [WORKSPACE, 50, null]);
    expect(harness.deviceFrames.map((frame) => frame.method)).toEqual(['checkpointList']);
    await harness.closeDeviceHarness();
  });

  test('a snapshot hint lands in the calling workspace\'s store, whatever store it names', async () => {
    const harness = await deviceHarness();
    harness.consentDecision = 'always';

    await harness.userDO.deviceRpc(harness.workspace, 'writeFile', ['/home/ashish/work/a.txt', 'x'], {
      agentName: WORKSPACE, checkpoint: { agent: OTHER_WORKSPACE, turnId: 'turn-1', sessionId: 's', dir: null },
    });

    expect(harness.deviceFrames.map((frame) => frame.checkpoint)).toEqual([
      { agent: WORKSPACE, turnId: 'turn-1', sessionId: 's', dir: null },
    ]);
    await harness.closeDeviceHarness();
  });
});

describe('device RPC stays unreachable from owner HTTP routes', () => {
  test('no /api/user route forwards an arbitrary method to deviceRpc', () => {
    const source = readFileSync(new URL('../src/user/routes.ts', import.meta.url).pathname, 'utf8');
    // Checkpoint reads are the only consent-free methods; an HTTP pass-through would widen the
    // device RPC surface.
    expect(source).not.toContain('deviceRpc');
  });
});
