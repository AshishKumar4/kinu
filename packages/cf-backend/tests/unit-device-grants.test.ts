/**
 * Consent is resolved at the one chokepoint, `UserDO.deviceRpc`, against the proven workspace:
 * driven over a real UserDO whose device socket answers, so a grant that did nothing is visible.
 */
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import {
  createTestUserDO, provisionTestWorkspace, testOwner, type TestUserDO,
} from './helpers/user-do';
import {
  CAPABLE_HELLO, CONSENT_REFUSED, OTHER_WORKSPACE, WORKSPACE, daemon, deviceHarness,
} from './helpers/device-harness';
import type { UserCaller } from '@kinu.run/core';
import { connectedDevices, DeviceSocketHub, soleLiveDevice, DEVICE_CONNECT_SECRET, DEVICE_FRAMES, DEVICE_METHOD } from '@kinu.run/core';
import { mockAgentsSdk } from './helpers/agents-sdk';
import { appProbe, concretePath, PROBE_ORIGIN } from './helpers/app-probe';
import {
  DEVICE_PROTOCOL_VERSION, DEVICE_FEATURES, JsonValueSchema, nextDeviceRequestId,
  NO_DEVICE_CONNECTED, type JsonValue,
} from '@kinu.run/core';
import { UserDevices } from '../src/user/devices';
import {
  buyTicket, connectProof, connectTestDevice, handedSecret, openDeviceSocket, registerTestDevice, secretAck, secretHash, signConnect, signReplace,
  testDeviceKey, TEST_HUB_ORIGIN,
} from './helpers/device-key';


// The /api app's module graph reaches the Agents SDK: mocked before it loads.
mockAgentsSdk();

const { api } = await import('../src/api/app');

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

    await expect(harness.deviceCall(harness.workspace, 'exec', ['rm -rf ~/work'], {
      agentName: WORKSPACE,
    })).rejects.toThrow(CONSENT_REFUSED);

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

  test("an agent's parked call keeps the surface of the turn it was made in: the owner's answer wakes its re-issue on it", async () => {
    const harness = await deviceHarness();
    harness.consentDecision = 'once';

    await harness.deviceCall(harness.workspace, 'exec', ['make deploy'], { agentName: WORKSPACE, actorId: 'agent-1', surface: 'interactive' });
    await harness.deviceCall(harness.workspace, 'exec', ['make test'], { agentName: WORKSPACE, actorId: 'agent-1', surface: 'one-shot' });

    expect(harness.consentWakes.map(({ actorId, surface }) => ({ actorId, surface }))).toEqual([
      { actorId: 'agent-1', surface: 'interactive' },
      { actorId: 'agent-1', surface: 'one-shot' },
    ]);
    expect(harness.deviceFrames.filter((f) => f.method === 'exec').map((f) => f.params[0])).toEqual(['make deploy', 'make test']);
    await harness.closeDeviceHarness();
  });

  test('once the owner grants the workspace, calls run without asking again', async () => {
    const harness = await deviceHarness();
    harness.consentDecision = 'always';

    // Recorded on the base tier a card can record; an exec asks every time, deliberately.
    await harness.deviceCall(harness.workspace, 'readRange', ['/home/me/a.md', 0, 64], {
      agentName: WORKSPACE,
    });
    expect(harness.consentPrompts).toHaveLength(1);

    await harness.deviceCall(harness.workspace, 'readRange', ['/home/me/b.md', 0, 64], {
      agentName: WORKSPACE,
    });
    expect(harness.consentPrompts).toHaveLength(1);
    expect(harness.deviceFrames.filter((f) => f.method === 'readRange').map((f) => f.params[0]))
      .toEqual(['/home/me/a.md', '/home/me/b.md']);
    await harness.closeDeviceHarness();
  });


  test('one binding covers the shell too — the owner is asked once, not once per method', async () => {
    // One question: a grant must not leave `exec` gated. What a command may touch is the device's
    // own Sandbox switch.
    const harness = await deviceHarness();
    harness.consentDecision = 'always';
    await harness.deviceCall(harness.workspace, 'readRange', ['/tmp/a', 0, 64], { agentName: WORKSPACE });
    expect(harness.consentPrompts).toHaveLength(1);

    harness.consentDecision = 'deny';
    await harness.deviceCall(harness.workspace, 'exec', ['cat /etc/passwd'], { agentName: WORKSPACE });

    expect(harness.consentPrompts).toHaveLength(1);
    expect(harness.deviceFrames.filter((f) => f.method === 'exec').map((f) => f.params[0]))
      .toEqual(['cat /etc/passwd']);
    await harness.closeDeviceHarness();
  });
  test('the grant covers file reads too — the whole device plane, not just exec', async () => {
    const harness = await deviceHarness();
    harness.consentDecision = 'deny';

    // The /pc mount reads through this same call, so an ungranted read is refused too.
    await expect(harness.deviceCall(harness.workspace, 'readRange', ['/home/me/.ssh/id_ed25519', 0, 64], {
      agentName: WORKSPACE,
    })).rejects.toThrow(CONSENT_REFUSED);
    expect(harness.deviceFrames.filter((f) => f.method === 'readRange')).toEqual([]);

    harness.consentDecision = 'always';
    await harness.deviceCall(harness.workspace, 'readRange', ['/home/me/notes.md', 0, 64], {
      agentName: WORKSPACE,
    });
    expect(harness.deviceFrames.filter((f) => f.method === 'readRange').map((f) => f.params[0]))
      .toEqual(['/home/me/notes.md']);
    await harness.closeDeviceHarness();
  });

  test('revoking the grant stops the next call — no restart, no cache to wait out', async () => {
    const harness = await deviceHarness();
    harness.consentDecision = 'always';
    await harness.deviceCall(harness.workspace, 'exec', ['ls'], { agentName: WORKSPACE });
    expect(harness.deviceFrames.filter((f) => f.method === 'exec')).toHaveLength(1);

    expect(await harness.userDO.revokeDeviceConsent(await testOwner(), WORKSPACE, harness.deviceId))
      .toEqual({ ok: true });

    // Revocation deletes the remembered policy rather than storing a refusal, so the workspace is
    // asked again.
    harness.consentDecision = 'deny';
    await expect(harness.deviceCall(harness.workspace, 'exec', ['ls'], { agentName: WORKSPACE }))
      .rejects.toThrow(CONSENT_REFUSED);
    expect(harness.deviceFrames.filter((f) => f.method === 'exec')).toHaveLength(1);
    await harness.closeDeviceHarness();
  });

  // L111 #4: an 'always' on its way back while the owner revoked bound 'allow' again, restoring the grant they took away.
  test("an approval answering while the owner revokes restores nothing: the call does not run, and the next one asks", async () => {
    const harness = await deviceHarness();
    harness.consentDecision = 'always';
    const owner = await testOwner();
    // The answer that spends the owner's 'always' is the one in flight.
    harness.whileAskAnswers = async (verdict) => {
      if (verdict !== 'always') return;
      harness.whileAskAnswers = null;
      await harness.userDO.revokeDeviceConsent(owner, WORKSPACE, harness.deviceId);
    };

    await expect(harness.deviceCall(harness.workspace, 'readRange', ['/home/me/a.md', 0, 64], { agentName: WORKSPACE }))
      .rejects.toThrow('changed while this call waited');
    const bound = await harness.userDO.listDeviceConsents(owner);

    harness.consentDecision = 'deny';
    await expect(harness.deviceCall(harness.workspace, 'readRange', ['/home/me/a.md', 0, 64], { agentName: WORKSPACE }))
      .rejects.toThrow(CONSENT_REFUSED);

    expect({ bound, reads: harness.deviceFrames.filter((f) => f.method === 'readRange'), asked: harness.consentPrompts.length })
      .toEqual({ bound: [], reads: [], asked: 2 });
    await harness.closeDeviceHarness();
  });

  // L111 #4: a call admitted on a standing grant ran though the owner revoked it while the call waited to be sent.
  test('a call admitted on a grant the owner revokes before it is sent does not run', async () => {
    const owner = await testOwner();
    let granted = false;

    const harness = await deviceHarness('ashish@studio', async (frame) => {
      // The probe before the send: the owner revokes while the admitted call waits on it.
      if (granted && frame.method === DEVICE_METHOD.execAck) await harness.userDO.revokeDeviceConsent(owner, WORKSPACE, harness.deviceId);

      return daemon(frame);
    });

    harness.grantDevice(WORKSPACE, harness.deviceId);
    granted = true;

    await expect(harness.deviceCall(harness.workspace, 'exec', ['make deploy'], { agentName: WORKSPACE, requestId: nextDeviceRequestId() }))
      .rejects.toThrow('changed while this call waited');
    expect(harness.deviceFrames.filter((f) => f.method === 'exec')).toEqual([]);
    await harness.closeDeviceHarness();
  });

  test('a grant belongs to one workspace: the sibling is still asked', async () => {
    const harness = await deviceHarness();
    harness.consentDecision = 'always';
    await harness.deviceCall(harness.workspace, 'exec', ['ls'], { agentName: WORKSPACE });
    harness.consentPrompts.length = 0;

    harness.consentDecision = 'deny';
    await expect(harness.deviceCall(harness.sibling, 'exec', ['ls'], { agentName: OTHER_WORKSPACE }))
      .rejects.toThrow(CONSENT_REFUSED);
    expect(harness.consentPrompts.map((p) => p.workspace)).toEqual([OTHER_WORKSPACE]);
    await harness.closeDeviceHarness();
  });

  test('omitting agentName cannot bypass consent for workspace operations', async () => {
    const harness = await deviceHarness();
    harness.consentDecision = 'deny';

    await expect(harness.deviceCall(harness.workspace, 'exec', ['cat /etc/passwd']))
      .rejects.toThrow(CONSENT_REFUSED);
    await expect(harness.deviceCall(
      harness.workspace,
      'checkpointRestore',
      [WORKSPACE, '/home/me/project', 'cp-1'],
    )).rejects.toThrow(CONSENT_REFUSED);

    expect(harness.deviceFrames).toEqual([]);
    expect(harness.consentPrompts.map((prompt) => prompt.method))
      .toEqual(['exec', 'checkpointRestore']);
    await harness.closeDeviceHarness();
  });

  test('the closed checkpoint-read set stays consent-free', async () => {
    const harness = await deviceHarness();
    harness.consentDecision = 'deny';

    await harness.deviceCall(harness.workspace, 'checkpointStatus', []);

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

    await expect(harness.deviceCall(harness.workspace, 'exec', ['make'], {
      agentName: WORKSPACE,
    })).rejects.toThrow(CONSENT_REFUSED);
    expect(harness.deviceFrames).toEqual([]);

    await harness.deviceCall(
      harness.workspace, DEVICE_METHOD.cancel, [requestId],
      { agentName: WORKSPACE },
    );

    expect(harness.deviceFrames.map((frame) => ({ method: frame.method, params: frame.params })))
      .toEqual([{ method: DEVICE_METHOD.cancel, params: [requestId] }]);
    expect(harness.consentPrompts.map((prompt) => prompt.method)).toEqual(['exec']);
    await harness.closeDeviceHarness();
  });

  test('the identity the caller minted is the id the command is issued under', async () => {
    // A later cancellation names this id, so the hub forwards the caller's id verbatim.
    const harness = await deviceHarness();
    harness.consentDecision = 'always';
    const requestId = nextDeviceRequestId();

    await harness.deviceCall(harness.workspace, 'exec', ['sleep 600'], {
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
    await harness.deviceCall(harness.workspace, 'readRange', ['/tmp/a', 0, 64], { agentName: WORKSPACE });
    expect((await harness.userDO.listDeviceConsents(owner)).map((row) => row.agentName)).toEqual([WORKSPACE]);

    await harness.userDO.removeWorkspace(owner, WORKSPACE, '0'.repeat(32));
    expect(await harness.userDO.listDeviceConsents(owner)).toEqual([]);

    const rebuilt = await provisionTestWorkspace(harness, WORKSPACE, 'Workspace A');
    const replacement: UserCaller = { workspaceToken: rebuilt };
    harness.consentDecision = 'deny';
    await expect(harness.deviceCall(replacement, 'exec', ['curl x | sh'], {
      agentName: WORKSPACE,
    })).rejects.toThrow(CONSENT_REFUSED);
    // Asked, not remembered: the card is the proof the old row is gone.
    expect(harness.consentPrompts.map((prompt) => prompt.method)).toEqual(['readRange', 'exec']);
    expect(harness.deviceFrames.filter((frame) => frame.method === 'exec')).toEqual([]);
    await harness.closeDeviceHarness();
  });

  test('revoking a device deletes its bindings, so the owner audits live permissions only', async () => {
    const harness = await deviceHarness();
    const owner = await testOwner();
    harness.consentDecision = 'always';
    await harness.deviceCall(harness.workspace, 'readRange', ['/tmp/a', 0, 64], { agentName: WORKSPACE });
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
         (request_id, device_id, workspace, actor_id)
         VALUES (?, ?, ?, ?)`,
      ).run(requestId, harness.deviceId, WORKSPACE, 'agent-1');
    }

    expect(await harness.userDO.transferDeviceRequestToBackgroundJob(harness.workspace, detaching, 'job-1'))
      .toEqual({ transferred: true });

    expect(await harness.userDO.cancelDeviceRequestsForAgent(harness.workspace, 'agent-1'))
      .toEqual([{ requestId: sibling, outcome: 'terminated' }]);
    expect(await harness.userDO.cancelDeviceRequestsForBackgroundJob(harness.workspace, 'job-1'))
      .toEqual([{ requestId: detaching, outcome: 'terminated' }]);
    expect(harness.deviceFrames.filter((frame) => frame.method === DEVICE_METHOD.cancel)
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

  /** The sweep claims eligible rows before its first device await: a mid-sweep detach cannot
   *  move a claimed request, nor be cancelled by a sweep it escaped. */
  test('a detach racing an in-flight turn sweep loses to the sweep claim', async () => {
    const harness = await deviceHarness();
    const claimed = nextDeviceRequestId();
    harness.db.prepare(
      `INSERT INTO device_inflight_requests (request_id, device_id, workspace, actor_id)
       VALUES (?, ?, ?, ?)`,
    ).run(claimed, harness.deviceId, WORKSPACE, 'agent-1');

    const sweep = harness.userDO.cancelDeviceRequestsForAgent(harness.workspace, 'agent-1');
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
      `INSERT INTO device_inflight_requests (request_id, device_id, workspace, actor_id)
       VALUES (?, ?, ?, ?)`,
    ).run(detached, harness.deviceId, WORKSPACE, 'agent-1');

    expect(await harness.userDO.transferDeviceRequestToBackgroundJob(harness.workspace, detached, 'job-1'))
      .toEqual({ transferred: true });
    expect(await harness.userDO.cancelDeviceRequestsForAgent(harness.workspace, 'agent-1')).toEqual([]);
    expect(harness.deviceFrames.filter((frame) => frame.method === DEVICE_METHOD.cancel)).toEqual([]);
    await harness.closeDeviceHarness();
  });

  test('a failed kill releases its claim so a later sweep can retry the same request', async () => {
    const harness = await deviceHarness();
    const requestId = nextDeviceRequestId();
    harness.db.prepare(
      `INSERT INTO device_inflight_requests (request_id, device_id, workspace, actor_id)
       VALUES (?, ?, ?, ?)`,
    ).run(requestId, harness.deviceId, WORKSPACE, 'agent-1');
    harness.attachDevice(null);

    // No live tunnel: the kill cannot be confirmed, so the row stays retryable.
    expect(await harness.userDO.cancelDeviceRequestsForAgent(harness.workspace, 'agent-1'))
      .toEqual([{ requestId, outcome: 'failed', detail: NO_DEVICE_CONNECTED }]);

    harness.attachDevice(harness.deviceId);
    expect(await harness.userDO.cancelDeviceRequestsForAgent(harness.workspace, 'agent-1'))
      .toEqual([{ requestId, outcome: 'terminated' }]);
    await harness.closeDeviceHarness();
  });

  test('an activation that died holding a claim leaves the request cancellable again', async () => {
    const harness = await deviceHarness();
    const requestId = nextDeviceRequestId();
    harness.db.prepare(
      `INSERT INTO device_inflight_requests (request_id, device_id, workspace, actor_id)
       VALUES (?, ?, ?, ?)`,
    ).run(requestId, harness.deviceId, WORKSPACE, 'agent-1');
    harness.db.prepare(
      `UPDATE device_inflight_requests SET cancel_claim = ? WHERE request_id = ?`,
    ).run('claim-of-a-dead-activation', requestId);

    const revived = createTestUserDO({ storage: harness.db, deviceResponder: daemon });
    revived.attachDevice(harness.deviceId);
    expect(await revived.userDO.cancelDeviceRequestsForAgent(harness.workspace, 'agent-1'))
      .toEqual([{ requestId, outcome: 'terminated' }]);
    await revived.joinFibers();
    revived.close();
    await harness.closeDeviceHarness();
  });

  test('a killed request whose acknowledgement fails is untransferable and cleaned up in the same activation', async () => {
    let ackWorks = false;

    const harness = await deviceHarness('ashish@studio', (frame) => {
      if (frame.method === DEVICE_METHOD.execAck && !ackWorks) {
        throw new Error('acknowledgement channel down');
      }

      return daemon(frame);
    });

    const requestId = nextDeviceRequestId();
    harness.db.prepare(
      `INSERT INTO device_inflight_requests (request_id, device_id, workspace, actor_id)
       VALUES (?, ?, ?, ?)`,
    ).run(requestId, harness.deviceId, WORKSPACE, 'agent-1');

    expect(await harness.userDO.cancelDeviceRequestsForAgent(harness.workspace, 'agent-1'))
      .toEqual([{ requestId, outcome: 'terminated' }]);
    expect(await harness.userDO.transferDeviceRequestToBackgroundJob(harness.workspace, requestId, 'job-1'))
      .toEqual({ transferred: false });

    // The retry cleans up and never kills the dead process group a second time.
    ackWorks = true;
    expect(await harness.userDO.cancelDeviceRequestsForAgent(harness.workspace, 'agent-1'))
      .toEqual([{ requestId, outcome: 'terminated' }]);
    expect(harness.deviceFrames.filter((frame) => frame.method === DEVICE_METHOD.cancel)
      .map((frame) => frame.params[0])).toEqual([requestId]);
    expect(harness.db.prepare(
      `SELECT request_id FROM device_inflight_requests WHERE request_id = ?`,
    ).all(requestId)).toEqual([]);
    await harness.closeDeviceHarness();
  });

  test('a request killed before a restart is still untransferable and cleaned up after it', async () => {
    const harness = await deviceHarness('ashish@studio', (frame) => {
      if (frame.method === DEVICE_METHOD.execAck) throw new Error('acknowledgement channel down');

      return daemon(frame);
    });

    const requestId = nextDeviceRequestId();
    harness.db.prepare(
      `INSERT INTO device_inflight_requests (request_id, device_id, workspace, actor_id)
       VALUES (?, ?, ?, ?)`,
    ).run(requestId, harness.deviceId, WORKSPACE, 'agent-1');
    expect(await harness.userDO.cancelDeviceRequestsForAgent(harness.workspace, 'agent-1'))
      .toEqual([{ requestId, outcome: 'terminated' }]);

    // Death is durable: a new activation refuses the transfer even before cleaning the row up.
    const revived = createTestUserDO({ storage: harness.db, deviceResponder: daemon });
    revived.attachDevice(harness.deviceId);
    expect(await revived.userDO.transferDeviceRequestToBackgroundJob(harness.workspace, requestId, 'job-1'))
      .toEqual({ transferred: false });
    expect(await revived.userDO.cancelDeviceRequestsForAgent(harness.workspace, 'agent-1'))
      .toEqual([{ requestId, outcome: 'terminated' }]);
    expect(revived.deviceFrames.filter((frame) => frame.method === DEVICE_METHOD.cancel)).toEqual([]);
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
      if (frame.method === DEVICE_METHOD.cancel) {
        return { requestId: v.parse(v.string(), frame.params[0]), cancelled: 'unknown' };
      }

      if (frame.method === DEVICE_METHOD.execAck && !ackWorks) {
        throw new Error('acknowledgement channel down');
      }

      return daemon(frame);
    });

    const requestId = nextDeviceRequestId();
    harness.db.prepare(
      `INSERT INTO device_inflight_requests (request_id, device_id, workspace, actor_id)
       VALUES (?, ?, ?, ?)`,
    ).run(requestId, harness.deviceId, WORKSPACE, 'agent-1');

    expect(await harness.userDO.cancelDeviceRequestsForAgent(harness.workspace, 'agent-1'))
      .toEqual([{ requestId, outcome: 'unknown' }]);
    expect(await harness.userDO.transferDeviceRequestToBackgroundJob(harness.workspace, requestId, 'job-1'))
      .toEqual({ transferred: false });

    // A cleanup retry reports the stored answer, never a termination this sweep did not observe.
    ackWorks = true;
    expect(await harness.userDO.cancelDeviceRequestsForAgent(harness.workspace, 'agent-1'))
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
       (request_id, device_id, workspace, actor_id, cancel_outcome)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(requestId, harness.deviceId, WORKSPACE, 'agent-1', 'terminated');
    harness.attachDevice(null);

    // A confirmed stop must never regress into "the kill failed" when the cleanup socket is gone.
    expect(await harness.userDO.cancelDeviceRequestsForAgent(harness.workspace, 'agent-1'))
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
      if (frame.method === DEVICE_METHOD.cancel) {
        dropRow?.();
        throw new Error('tunnel closed under the kill');
      }

      return daemon(frame);
    });

    const requestId = nextDeviceRequestId();
    harness.db.prepare(
      `INSERT INTO device_inflight_requests (request_id, device_id, workspace, actor_id)
       VALUES (?, ?, ?, ?)`,
    ).run(requestId, harness.deviceId, WORKSPACE, 'agent-1');
    dropRow = () => {
      harness.db.prepare(`DELETE FROM device_inflight_requests WHERE request_id = ?`).run(requestId);
      dropRow = null;
    };

    expect(await harness.userDO.cancelDeviceRequestsForAgent(harness.workspace, 'agent-1')).toEqual([]);
    await harness.closeDeviceHarness();
  });

  test('an exec issued inside a detached scope is the job\'s from the insert, not the turn\'s', async () => {
    const harness = await deviceHarness();
    // Granted before the test: an agent's re-issue is a new call under a new request id, and this test names one.
    harness.grantDevice(WORKSPACE, harness.deviceId);
    const requestId = nextDeviceRequestId();

    await harness.deviceCall(harness.workspace, 'exec', ['sleep 30'], {
      agentName: WORKSPACE, actorId: 'agent-1', requestId, backgroundJobId: 'job-1',
      checkpoint: { agent: WORKSPACE, turnId: 'turn-1', sessionId: 's', dir: null },
    });

    expect(harness.db.prepare(
      `SELECT actor_id, background_job_id FROM device_inflight_requests WHERE request_id = ?`,
    ).all(requestId)).toEqual([{ actor_id: null, background_job_id: 'job-1' }]);
    expect(await harness.userDO.cancelDeviceRequestsForAgent(harness.workspace, 'agent-1')).toEqual([]);
    expect(await harness.userDO.cancelDeviceRequestsForBackgroundJob(harness.workspace, 'job-1'))
      .toEqual([{ requestId, outcome: 'terminated' }]);
    await harness.closeDeviceHarness();
  });

  test('a revoked device\'s unresolved request cannot be detached into a job', async () => {
    const harness = await deviceHarness();
    const requestId = nextDeviceRequestId();
    harness.db.prepare(
      `INSERT INTO device_inflight_requests (request_id, device_id, workspace, actor_id)
       VALUES (?, ?, ?, ?)`,
    ).run(requestId, harness.deviceId, WORKSPACE, 'agent-1');
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
    await expect(harness.deviceCall(harness.workspace, 'exec', ['sleep 30'], {
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
      `INSERT INTO device_inflight_requests (request_id, device_id, workspace, actor_id)
       VALUES (?, ?, ?, ?)`,
    ).run(requestId, harness.deviceId, WORKSPACE, 'agent-1');
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
      `INSERT INTO device_inflight_requests (request_id, device_id, workspace, actor_id)
       VALUES (?, ?, ?, ?)`,
    ).run(requestId, harness.deviceId, WORKSPACE, 'agent-1');

    await harness.deviceCall(harness.workspace, DEVICE_METHOD.cancel, [requestId], {
      agentName: WORKSPACE,
    });

    // The sweep reports the already-stored answer and sends no second kill: the paths cannot
    // disagree.
    expect(await harness.userDO.cancelDeviceRequestsForAgent(harness.workspace, 'agent-1'))
      .toEqual([{ requestId, outcome: 'terminated' }]);
    expect(harness.deviceFrames.filter((frame) => frame.method === DEVICE_METHOD.cancel)
      .map((frame) => frame.params[0])).toEqual([requestId]);
    expect(harness.db.prepare(
      `SELECT request_id FROM device_inflight_requests WHERE request_id = ?`,
    ).all(requestId)).toEqual([]);
    await harness.closeDeviceHarness();
  });

  test('an exec is refused when revocation lands inside its acknowledgement probe', async () => {
    let revokeNow: (() => void) | null = null;

    const harness = await deviceHarness('ashish@studio', (frame) => {
      if (frame.method === DEVICE_METHOD.execAck) revokeNow?.();

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

    await expect(harness.deviceCall(harness.workspace, 'exec', ['sleep 30'], {
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
      if (frame.method === DEVICE_METHOD.cancel) stealClaim?.();

      return daemon(frame);
    });

    const [first, second] = [nextDeviceRequestId(), nextDeviceRequestId()];

    for (const requestId of [first, second]) {
      harness.db.prepare(
        `INSERT INTO device_inflight_requests (request_id, device_id, workspace, actor_id)
         VALUES (?, ?, ?, ?)`,
      ).run(requestId, harness.deviceId, WORKSPACE, 'agent-1');
    }

    stealClaim = () => {
      harness.db.prepare(`UPDATE device_inflight_requests SET cancel_claim = ? WHERE request_id = ?`)
        .run('claim-of-the-revocation', second);
      stealClaim = null;
    };

    expect(await harness.userDO.cancelDeviceRequestsForAgent(harness.workspace, 'agent-1'))
      .toEqual([{ requestId: first, outcome: 'terminated' }]);
    // Exactly one authority cancels and reports a request.
    expect(harness.deviceFrames.filter((frame) => frame.method === DEVICE_METHOD.cancel)
      .map((frame) => frame.params[0])).toEqual([first]);
    await harness.closeDeviceHarness();
  });

  test('revocation records its incident before the first kill and clears it only when all are confirmed', async () => {
    const seenAtFrame: Array<number | null> = [];

    const harness = await deviceHarness('ashish@studio', (frame) => {
      if (frame.method === DEVICE_METHOD.cancel) {
        seenAtFrame.push(harness.db.prepare(
          `SELECT unstopped_at FROM user_devices WHERE id = ?`,
        ).all(harness.deviceId).map((row) => v.parse(UnstoppedRowSchema, row).unstopped_at)[0]);
      }

      return daemon(frame);
    });

    const requestId = nextDeviceRequestId();
    harness.db.prepare(
      `INSERT INTO device_inflight_requests (request_id, device_id, workspace, actor_id)
       VALUES (?, ?, ?, ?)`,
    ).run(requestId, harness.deviceId, WORKSPACE, 'agent-1');

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
       (request_id, device_id, workspace, actor_id)
       VALUES (?, ?, ?, ?)`,
    ).run(requestId, harness.deviceId, WORKSPACE, 'agent-1');

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

        if (frame.method === DEVICE_METHOD.cancel) cancellationSent.resolve(frame);

        if (frame.method === DEVICE_METHOD.execAck && hub) {
          hub.handleMessage(harness.deviceId, JSON.stringify({
            id: frame.id, result: { requestId, acknowledged: true },
          }));
        }
      },
    };

    const devices = Object.getOwnPropertyDescriptor(harness.userDO, 'devices')?.value;
    const hubCandidate = devices instanceof UserDevices ? devices._devices : undefined;

    if (!(hubCandidate instanceof DeviceSocketHub)) throw new Error('UserDO device hub is unavailable.');
    hub = hubCandidate;
    harness.attachDevice(null);
    hub.acceptUnauthenticated(socket);
    hub.admit(harness.deviceId, socket);
    hub.hello(harness.deviceId, DEVICE_PROTOCOL_VERSION, DEVICE_FEATURES);

    const revocation = harness.userDO.revokeDevice(await testOwner(), harness.deviceId);
    const cancellation = await cancellationSent.promise;
    await expect(harness.deviceCall(harness.workspace, 'exec', ['true'], {
      agentName: WORKSPACE,
    })).rejects.toThrow(NO_DEVICE_CONNECTED);
    expect(cancellation.params).toEqual([requestId]);

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

    expect(soleLiveDevice(status.devices)?.granted).toBe(false);
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
    await harness.deviceCall(harness.workspace, 'readRange', ['/tmp/a', 0, 64], { agentName: WORKSPACE });

    expect(soleLiveDevice((await harness.userDO.deviceRuntimeStatus(harness.workspace)).devices)?.granted).toBe(true);
    expect(soleLiveDevice((await harness.userDO.deviceRuntimeStatus(harness.sibling)).devices)?.granted).toBe(false);
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
});

describe('asking for a machine when there is none', () => {
  test('the call refuses and names the registered machines on the workspace rail', async () => {
    const harness = createTestUserDO();
    const workspace = await provisionTestWorkspace(harness, WORKSPACE, 'Workspace A');
    const { deviceId } = await registerTestDevice(harness.userDO, 'studio tower');

    await expect(harness.deviceCall({ workspaceToken: workspace }, 'exec', ['make build'], {
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

    await expect(harness.deviceCall({ workspaceToken: workspace }, 'exec', ['make build'], {
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

    const first = harness.deviceCall({ workspaceToken: workspace }, 'exec', ['make build'], {
      agentName: WORKSPACE,
    });

    const retry = harness.deviceCall({ workspaceToken: workspace }, 'exec', ['make build'], {
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

    await expect(harness.deviceCall(caller, 'exec', ['make build'], { agentName: WORKSPACE }))
      .rejects.toThrow(NO_DEVICE_CONNECTED);
    expect(harness.consentPrompts).toEqual([]);
    expect(harness.unavailableNotices).toEqual([{ workspace: WORKSPACE, devices: [] }]);
    expect(harness.deviceFrames).toEqual([]);

    // A daemon that proves nothing on connect runs no commands.
    const { deviceId } = await registerTestDevice(harness.userDO, 'studio');
    harness.attachDevice(deviceId);
    await harness.sendDeviceHello(CAPABLE_HELLO);
    const seen = await harness.userDO.deviceRuntimeStatus(caller);
    expect(seen.devices?.map((d) => d.name)).toEqual(['studio']);
    expect(soleLiveDevice(seen.devices)?.granted).toBe(false);

    harness.consentDecision = 'always';
    const result = await harness.deviceCall(caller, 'exec', ['make build'], { agentName: WORKSPACE });

    expect(result).toContain('"exitCode":0');
    expect(harness.deviceFrames.filter((f) => f.method === 'exec').map((f) => f.params[0]))
      .toEqual(['make build']);
    expect(soleLiveDevice((await harness.userDO.deviceRuntimeStatus(caller)).devices)?.granted).toBe(true);
    expect((await harness.userDO.listDeviceConsents(await testOwner()))).toEqual([
      expect.objectContaining({ agentName: WORKSPACE, deviceId, policy: 'allow' }),
    ]);
    await harness.joinFibers();
    harness.close();
  });

  test('a daemon connecting announces the machine where the notice went', async () => {
    const harness = createTestUserDO();
    const token = await provisionTestWorkspace(harness, WORKSPACE, 'Workspace A');

    await expect(harness.deviceCall({ workspaceToken: token }, 'exec', ['make build'], {
      agentName: WORKSPACE,
    })).rejects.toThrow(NO_DEVICE_CONNECTED);

    const { deviceId, key } = await registerTestDevice(harness.userDO, 'studio');
    const device = await connectTestDevice(harness, deviceId, key, { secret: '', acknowledge: true });

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
    await registerTestDevice(harness.userDO, 'studio-tower', owner);

    await expect(harness.deviceCall({ workspaceToken: first }, 'exec', ['make build'], {
      agentName: WORKSPACE,
    })).rejects.toThrow(NO_DEVICE_CONNECTED);
    expect(harness.unavailableNotices.map((n) => n.workspace)).toEqual([WORKSPACE]);

    const pending = harness.db.query<{ agent_name: string }, []>('SELECT agent_name FROM device_notice_pending ORDER BY agent_name ASC').all();
    expect(pending.map((row) => row.agent_name)).toEqual([WORKSPACE]);
    const studio = await registerTestDevice(harness.userDO, 'studio', owner);
    const device = await connectTestDevice(harness, studio.deviceId, studio.key, { secret: '', acknowledge: true });

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

    await expect(harness.deviceCall(harness.workspace, 'exec', ['ls'], {
      agentName: WORKSPACE,
    })).rejects.toThrow(CONSENT_REFUSED);

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

    await expect(harness.deviceCall({ workspaceToken: workspace }, 'exec', ['make'], {
      agentName: WORKSPACE,
    })).rejects.toThrow(NO_DEVICE_CONNECTED);
    expect(harness.unavailableNotices).toEqual([{ workspace: WORKSPACE, devices: [] }]);

    const status = await harness.userDO.deviceRuntimeStatus({ workspaceToken: workspace });
    // Away: no machine is live, so none answers for this workspace's grant.
    expect(connectedDevices(status.devices)).toEqual([]);
    await harness.joinFibers();
    harness.close();
  });

  test('device offline: the offline notice, and an offline row', async () => {
    const harness = await deviceHarness();
    harness.attachDevice(null);

    await expect(harness.deviceCall(harness.workspace, 'exec', ['make'], {
      agentName: WORKSPACE,
    })).rejects.toThrow(NO_DEVICE_CONNECTED);
    expect(harness.unavailableNotices).toHaveLength(1);
    expect(harness.unavailableNotices[0]?.workspace).toBe(WORKSPACE);
    expect(harness.unavailableNotices[0]?.devices.map((d) => d.label)).toEqual(['ashish@studio']);

    const status = await harness.userDO.deviceRuntimeStatus(harness.workspace);
    // Registered and away: the machine is listed, live nowhere, and claims no grant.
    expect(status.devices).toMatchObject([{ name: 'ashish@studio', connected: false }]);
    expect(status.devices?.[0]?.granted).toBeUndefined();
    await harness.closeDeviceHarness();
  });

  test('device online and ungranted: the GRANT card, and a row that is not usable', async () => {
    const harness = await deviceHarness();
    harness.consentDecision = 'deny';

    await expect(harness.deviceCall(harness.workspace, 'exec', ['make'], {
      agentName: WORKSPACE,
    })).rejects.toThrow(CONSENT_REFUSED);
    expect(harness.consentPrompts).toEqual([{
      workspace: WORKSPACE,
      method: 'exec',
      command: 'make',
      workspaceName: WORKSPACE,
    }]);
    const status = await harness.userDO.deviceRuntimeStatus(harness.workspace);
    expect(soleLiveDevice(status.devices)?.granted).toBe(false);
    await harness.closeDeviceHarness();
  });

  test('device online and granted: no card, and a row the agent can act on', async () => {
    const harness = await deviceHarness();
    harness.consentDecision = 'always';

    await harness.deviceCall(harness.workspace, 'exec', ['make'], {
      agentName: WORKSPACE,
    });
    expect(harness.consentPrompts).toHaveLength(1);

    const status = await harness.userDO.deviceRuntimeStatus(harness.workspace);
    expect(soleLiveDevice(status.devices)?.granted).toBe(true);
    await harness.closeDeviceHarness();
  });
});

/**
 * Device protocol 5: a machine's key is its credential, and a copy of it is found by the connect secret beside it. Each
 * accepted connect hands the machine a fresh random secret, committed once the machine says it stored it; a ticket is
 * bought over the committed one or the one just handed, and any other means a second machine holds the key.
 */
describe('a device key is its credential, and a second holder is found', () => {
  /** The device's committed and handed secrets (as hashes) and its incident, as the account stores them. */
  function stored(harness: TestUserDO, deviceId: string) {
    return v.parse(
      v.array(v.object({
        connect_secret_hash: v.nullable(v.string()), pending_secret_hash: v.nullable(v.string()),
        clone_detected_at: v.nullable(v.number()), revoked_at: v.nullable(v.number()),
      })),
      harness.sql.exec(`SELECT connect_secret_hash, pending_secret_hash, clone_detected_at, revoked_at FROM user_devices WHERE id = ?`, deviceId).toArray(),
    )[0];
  }

  /** The account's row for one device, as Settings → Devices reads it; undefined once it is gone. */
  async function deviceRow(harness: TestUserDO, deviceId: string) {
    return (await harness.userDO.listDevices(await testOwner())).find((device) => device.id === deviceId);
  }

  test("each accepted connect hands a fresh secret, committed only on the machine's answer naming it", async () => {
    const harness = createTestUserDO({ deviceResponder: daemon });
    const { deviceId, key } = await registerTestDevice(harness.userDO, 'ashish@studio');

    const first = await connectTestDevice(harness, deviceId, key, { secret: '', acknowledge: false });
    expect(first.handed).toMatch(DEVICE_CONNECT_SECRET);
    expect(stored(harness, deviceId)).toMatchObject({ connect_secret_hash: null, pending_secret_hash: secretHash(first.handed) });
    // An answer naming any other secret moves nothing.
    await harness.userDO.webSocketMessage(first.ws, secretAck('x'.repeat(43)));
    expect(stored(harness, deviceId).connect_secret_hash).toBeNull();
    await harness.userDO.webSocketMessage(first.ws, secretAck(first.handed));
    expect(stored(harness, deviceId)).toMatchObject({ connect_secret_hash: secretHash(first.handed), pending_secret_hash: null });

    const second = await connectTestDevice(harness, deviceId, key, { secret: first.handed, acknowledge: true });
    expect(second.handed).not.toBe(first.handed);
    expect(stored(harness, deviceId)).toEqual({ connect_secret_hash: secretHash(second.handed), pending_secret_hash: null, clone_detected_at: null, revoked_at: null });
    // The hub keeps hashes alone: neither secret is anywhere in its row.
    expect(JSON.stringify(harness.sql.exec(`SELECT * FROM user_devices WHERE id = ?`, deviceId).toArray())).not.toContain(second.handed);
    await harness.joinFibers();
    harness.close();
  });

  test('a secret the machine stored and whose answer was lost connects, and is committed first; so does the one it held', async () => {
    const harness = createTestUserDO({ deviceResponder: daemon });
    const { deviceId, key } = await registerTestDevice(harness.userDO, 'ashish@studio');
    const settled = await connectTestDevice(harness, deviceId, key, { secret: '', acknowledge: true });

    // The machine stored the next secret; its answer went down with the socket.
    const lost = await connectTestDevice(harness, deviceId, key, { secret: settled.handed, acknowledge: false });
    expect(stored(harness, deviceId).connect_secret_hash).toBe(secretHash(settled.handed));

    const recovered = await connectTestDevice(harness, deviceId, key, { secret: lost.handed, acknowledge: false });
    expect(stored(harness, deviceId)).toMatchObject({ connect_secret_hash: secretHash(lost.handed), pending_secret_hash: secretHash(recovered.handed), clone_detected_at: null });

    // A machine that could not store what it was handed connects on the one it holds, which the hub still holds too.
    const kept = await connectTestDevice(harness, deviceId, key, { secret: lost.handed, acknowledge: true });
    expect(stored(harness, deviceId)).toMatchObject({ connect_secret_hash: secretHash(kept.handed), clone_detected_at: null, revoked_at: null });
    expect(await deviceRow(harness, deviceId)).toMatchObject({ connected: true, cloneDetectedAt: null });
    await harness.joinFibers();
    harness.close();
  });

  // Device protocol 5's review, 2026-10-23: a predecessor and successor on one machine can each hold a ticket bought on
  // one committed secret. Were each socket handed its own secret, the second would replace the one the first stored
  // and answered, and the machine's next connect would read as a clone.
  test('two sockets accepted on one committed secret are handed the same next one, so the first one answered still commits', async () => {
    const harness = createTestUserDO({ deviceResponder: daemon });
    const { deviceId, key } = await registerTestDevice(harness.userDO, 'ashish@studio');
    const settled = await connectTestDevice(harness, deviceId, key, { secret: '', acknowledge: true });

    // Both tickets bought on the committed secret before either socket says AUTH.
    const predecessor = await buyTicket(harness, deviceId, key, settled.handed);
    const successor = await buyTicket(harness, deviceId, key, settled.handed);

    if (!predecessor.ok || !successor.ok) throw new Error('the hub refused a ticket on the committed secret');
    const first = await openDeviceSocket(harness);
    await harness.userDO.webSocketMessage(first.ws, JSON.stringify({ type: DEVICE_FRAMES.auth, user: harness.userDO.name, ticket: predecessor.ticket }));
    const second = await openDeviceSocket(harness);
    await harness.userDO.webSocketMessage(second.ws, JSON.stringify({ type: DEVICE_FRAMES.auth, user: harness.userDO.name, ticket: successor.ticket }));

    const handed = handedSecret(first);
    expect(handed).not.toBeNull();
    expect(handedSecret(second)).toBe(handed);

    // The second never answers; the first's answer commits what both were handed, and the machine connects on it.
    await harness.userDO.webSocketMessage(first.ws, secretAck(handed ?? ''));
    expect(stored(harness, deviceId)).toMatchObject({ connect_secret_hash: secretHash(handed ?? ''), pending_secret_hash: null, revoked_at: null });
    expect(await buyTicket(harness, deviceId, key, handed ?? '')).toMatchObject({ ok: true });
    await harness.joinFibers();
    harness.close();
  });

  test('a copy taken before the owner connected again is a second holder: revoked, the socket closed, the incident kept', async () => {
    const harness = createTestUserDO({ deviceResponder: daemon });
    const { deviceId, key } = await registerTestDevice(harness.userDO, 'ashish@studio');
    const before = await connectTestDevice(harness, deviceId, key, { secret: '', acknowledge: true });

    // The copy holds the key and the secret of that moment; the owner's machine connects once more and moves past it.
    const copied = before.handed;
    const live = await connectTestDevice(harness, deviceId, key, { secret: copied, acknowledge: true });

    expect(await buyTicket(harness, deviceId, key, copied)).toEqual({ ok: false, refusal: 'cloned' });
    expect(live.closed()).toMatchObject({ code: 1000 });
    expect(stored(harness, deviceId)).toMatchObject({ clone_detected_at: expect.any(Number), revoked_at: expect.any(Number) });
    expect(await deviceRow(harness, deviceId)).toMatchObject({
      connected: false, revokedAt: expect.any(Number), unstoppedAt: null, cloneDetectedAt: expect.any(Number),
    });
    // Revoked, it answers no challenge, and says why.
    expect(await harness.userDO.issueDeviceConnectChallenge(await testOwner(), deviceId)).toEqual({ ok: false, refusal: 'cloned' });

    // The incident stays until the owner has read it; acknowledging removes the device.
    expect(await harness.userDO.acknowledgeUnstoppedDevice(await testOwner(), deviceId)).toEqual({ ok: true });
    expect(await deviceRow(harness, deviceId)).toBeUndefined();
    await harness.joinFibers();
    harness.close();
  });

  test('a clone that edits its secret buys nothing either: any secret the hub never handed is a second holder', async () => {
    for (const edited of ['', 'A'.repeat(43)]) {
      const harness = createTestUserDO({ deviceResponder: daemon });
      const { deviceId, key } = await registerTestDevice(harness.userDO, 'ashish@studio');
      await connectTestDevice(harness, deviceId, key, { secret: '', acknowledge: true });

      // Signed with the real key: the signature holds, and the secret gives the copy away.
      expect(await buyTicket(harness, deviceId, key, edited)).toEqual({ ok: false, refusal: 'cloned' });
      expect(stored(harness, deviceId)).toMatchObject({ clone_detected_at: expect.any(Number), revoked_at: expect.any(Number) });
      await harness.joinFibers();
      harness.close();
    }
  });

  test('another key\'s signature, a replayed challenge or one for another device buys nothing, and revokes nothing', async () => {
    const harness = createTestUserDO({ deviceResponder: daemon });
    const owner = await testOwner();
    const { deviceId, key } = await registerTestDevice(harness.userDO, 'ashish@studio');
    const other = await registerTestDevice(harness.userDO, 'ashish@laptop');

    // A key that is not this device's, even one the account knows, signs nothing for it; the challenge stays live.
    const forged = await connectProof(harness, deviceId, other.key, '');
    expect(await harness.userDO.issueDeviceConnectTicket(owner, forged)).toEqual({ ok: false, refusal: 'unauthorized' });
    const genuine = signConnect(key, { device: deviceId, secret: '', nonce: forged.nonce });
    expect(await harness.userDO.issueDeviceConnectTicket(owner, { ...forged, signature: genuine })).toMatchObject({ ok: true });

    // Spent: the same signed request again is refused, as is a signature for another hub.
    expect(await harness.userDO.issueDeviceConnectTicket(owner, { ...forged, signature: genuine })).toEqual({ ok: false, refusal: 'challenge_spent' });
    const staging = await connectProof(harness, deviceId, key, '');
    expect(await harness.userDO.issueDeviceConnectTicket(owner, { ...staging, origin: 'https://staging.kinu.example.com' })).toEqual({ ok: false, refusal: 'unauthorized' });

    // A challenge issued to one device spends for no other.
    const borrowed = await connectProof(harness, other.deviceId, other.key, '');
    const signedForThis = signConnect(key, { device: deviceId, secret: '', nonce: borrowed.nonce });
    expect(await harness.userDO.issueDeviceConnectTicket(owner, { ...borrowed, device: deviceId, signature: signedForThis })).toEqual({ ok: false, refusal: 'challenge_spent' });

    expect(stored(harness, deviceId)).toMatchObject({ clone_detected_at: null, revoked_at: null });
    await harness.joinFibers();
    harness.close();
  });

  test('a second claimant takes the slot and is recorded where the owner reads it', async () => {
    const harness = createTestUserDO({ deviceResponder: daemon });
    const { deviceId, key } = await registerTestDevice(harness.userDO, 'ashish@studio');

    const incumbent = await connectTestDevice(harness, deviceId, key, { secret: '', acknowledge: true });
    expect((await harness.userDO.listDevices(await testOwner()))[0]).toMatchObject({ id: deviceId, replacedAt: null });

    // A redialling machine must not be locked out by a socket the hub has not seen close.
    const newcomer = await connectTestDevice(harness, deviceId, key, { secret: incumbent.handed, acknowledge: true });

    const [row] = await harness.userDO.listDevices(await testOwner());
    expect(row.replacedAt).not.toBeNull();
    expect(row.connected).toBe(true);
    expect(incumbent.closed()).toEqual({ code: 1000, reason: 'replaced by a new connection' });
    expect(newcomer.closed()).toBeNull();
    await harness.joinFibers();
    harness.close();
  });
});

describe('device RPC stays unreachable from owner HTTP routes', () => {
  test('no /api route reaches deviceRpc, whatever it is sent', async () => {
    // Checkpoint reads are the only consent-free methods; an HTTP pass-through would widen the
    // device RPC surface. Every route the app registers is sent a forward-shaped body by a live
    // session; none may call `deviceRpc`.
    const { env, ctx, cookie, accountCalls } = await appProbe();
    const probed = new Set<string>();

    for (const route of api.routes) {
      const method = route.method === 'ALL' ? 'POST' : route.method;
      const path = concretePath(route.path);

      if (probed.has(`${method} ${path}`)) continue;
      probed.add(`${method} ${path}`);

      const answer = await api.fetch(new Request(`${PROBE_ORIGIN}${path}`, {
        method,
        headers: { cookie, origin: PROBE_ORIGIN, 'content-type': 'application/json' },
        body: method === 'GET' ? undefined : JSON.stringify({ method: 'exec', args: ['ls'], deviceId: 'device-1', path: '/' }),
      }), env, ctx);

      // Wherever the session gate applies, the request got past it and its cross-site check.
      expect(await answer.text(), `${method} ${path}`).not.toMatch(/No Kinu session|Kinu session expired|CROSS_SITE/);
    }

    await Promise.allSettled(ctx.retained);
    expect(probed.size).toBeGreaterThan(50);
    expect(accountCalls).not.toContain('deviceRpc');
  });
});

describe('the account keeps one row per linked machine', () => {
  test('a revoked device with nothing left to report is removed, not kept', async () => {
    const harness = createTestUserDO({ deviceResponder: daemon });
    const { deviceId, key } = await registerTestDevice(harness.userDO, 'ashish@studio');

    expect(await harness.userDO.revokeDevice(await testOwner(), deviceId)).toEqual({ ok: true, unstoppedCommands: 0 });

    expect(harness.sql.exec(`SELECT id FROM user_devices WHERE id = ?`, deviceId).toArray()).toEqual([]);
    expect(await harness.userDO.issueDeviceConnectChallenge(await testOwner(), deviceId)).toEqual({ ok: false, refusal: 'unauthorized' });
    expect(key.publicKey).toHaveLength(43);
    await harness.joinFibers();
    harness.close();
  });

  test('linking a machine again replaces its old registration, on its old key\'s word only', async () => {
    const harness = createTestUserDO({ deviceResponder: daemon });
    const owner = await testOwner();
    const first = await registerTestDevice(harness.userDO, 'ashish@studio');
    const next = testDeviceKey();

    // A replacement signed by any key but the old registration's replaces nothing.
    const unsigned = await harness.userDO.registerDevice(owner, {
      publicKey: next.publicKey, origin: TEST_HUB_ORIGIN, label: 'ashish@studio',
      replaces: { device: first.deviceId, signature: signReplace(next, { device: first.deviceId, publicKey: next.publicKey }) },
    });

    expect((await harness.userDO.listDevices(owner)).map((device) => device.id).sort()).toEqual([first.deviceId, unsigned.deviceId].sort());

    // `kinu connect` run again signs the replacement with the key device.key held.
    const newest = testDeviceKey();

    const again = await harness.userDO.registerDevice(owner, {
      publicKey: newest.publicKey, origin: TEST_HUB_ORIGIN, label: 'ashish@studio',
      replaces: { device: first.deviceId, signature: signReplace(first.key, { device: first.deviceId, publicKey: newest.publicKey }) },
    });

    expect((await harness.userDO.listDevices(owner)).map((device) => device.id).sort()).toEqual([unsigned.deviceId, again.deviceId].sort());
    expect(await harness.userDO.issueDeviceConnectChallenge(owner, first.deviceId)).toEqual({ ok: false, refusal: 'unauthorized' });
    await harness.joinFibers();
    harness.close();
  });

  test('an update re-enrols a machine under its own id with a new key and no secret, and a removed one stays removed', async () => {
    const harness = createTestUserDO({ deviceResponder: daemon });
    const owner = await testOwner();
    const earlier = testDeviceKey();

    // The release's reset dropped the earlier row: re-enrolling makes it anew, under the id device.json names.
    expect(await harness.userDO.registerDevice(owner, { publicKey: earlier.publicKey, origin: TEST_HUB_ORIGIN, label: 'studio', reenrol: 'dev-earlier' }))
      .toEqual({ deviceId: 'dev-earlier' });
    const linked = await connectTestDevice(harness, 'dev-earlier', earlier, { secret: '', acknowledge: true });

    // A ticket the old key earned just before the replacement.
    expect(await buyTicket(harness, 'dev-earlier', earlier, linked.handed)).toMatchObject({ ok: true });

    // Again, as `kinu update` on a machine whose device.json it could not yet rewrite: the key and secret are replaced,
    // and what the old key earned goes with it.
    const replaced = testDeviceKey();
    await harness.userDO.registerDevice(owner, { publicKey: replaced.publicKey, origin: TEST_HUB_ORIGIN, label: 'renamed', reenrol: 'dev-earlier' });
    expect(harness.sql.exec(`SELECT 1 FROM connection_tickets WHERE purpose = 'device_connect' AND device_id = ?`, 'dev-earlier').toArray()).toEqual([]);
    expect(v.parse(v.array(v.object({ public_key: v.string(), connect_secret_hash: v.nullable(v.string()), label: v.string() })),
      harness.sql.exec(`SELECT public_key, connect_secret_hash, label FROM user_devices WHERE id = ?`, 'dev-earlier').toArray()))
      .toEqual([{ public_key: replaced.publicKey, connect_secret_hash: null, label: 'studio' }]);
    expect(await buyTicket(harness, 'dev-earlier', earlier, linked.handed)).toEqual({ ok: false, refusal: 'unauthorized' });
    expect(await buyTicket(harness, 'dev-earlier', replaced, '')).toMatchObject({ ok: true });

    // A device its owner removed, with an incident kept, is not brought back by a re-enrolment.
    harness.sql.exec(`UPDATE user_devices SET revoked_at = 1, clone_detected_at = 1 WHERE id = ?`, 'dev-earlier');
    await expect(harness.userDO.registerDevice(owner, { publicKey: testDeviceKey().publicKey, origin: TEST_HUB_ORIGIN, reenrol: 'dev-earlier' }))
      .rejects.toThrow('removed from your account');
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
      await expect(harness.deviceCall(harness.workspace, method, params))
        .rejects.toThrow('reads and restores only its own device checkpoints');
    }

    expect(harness.deviceFrames).toEqual([]);
    await harness.deviceCall(harness.workspace, 'checkpointList', [WORKSPACE, 50, null]);
    expect(harness.deviceFrames.map((frame) => frame.method)).toEqual(['checkpointList']);
    await harness.closeDeviceHarness();
  });

  test('a snapshot hint lands in the calling workspace\'s store, whatever store it names', async () => {
    const harness = await deviceHarness();
    harness.consentDecision = 'always';

    await harness.deviceCall(harness.workspace, 'writeFile', ['/home/ashish/work/a.txt', 'x'], {
      agentName: WORKSPACE, checkpoint: { agent: OTHER_WORKSPACE, turnId: 'turn-1', sessionId: 's', dir: null },
    });

    expect(harness.deviceFrames.map((frame) => frame.checkpoint)).toEqual([
      { agent: WORKSPACE, turnId: 'turn-1', sessionId: 's', dir: null },
    ]);
    await harness.closeDeviceHarness();
  });
});
