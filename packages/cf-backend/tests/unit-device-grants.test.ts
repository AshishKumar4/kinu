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
import type { UserCaller } from '../src/user/workspace-capability';
import {
  DEVICE_CONNECT_PATH, DEVICE_CONSENT_DENIED, DEVICE_PROVISION_METHOD, DEVICE_TOKEN_ROTATION,
  NO_DEVICE_CONNECTED, type JsonValue,
} from '@kinu.run/core';

const WORKSPACE = 'workspace-a';
const OTHER_WORKSPACE = 'workspace-b';

/** A daemon that answers `exec` with an exit-0 result and the toolchain probe
 *  with "nothing found", so a status read costs no wall clock. */
function daemon(frame: { method: string }): JsonValue {
  if (frame.method === 'which') return { present: [] };
  return { stdout: 'ok', stderr: '', exitCode: 0 };
}

interface DeviceHarness extends TestUserDO {
  deviceId: string;
  workspace: UserCaller;
  sibling: UserCaller;
}

/**
 * A registered device, connected, with two workspaces holding real capability
 * tokens. The id comes from `registerDevice` and is then attached to the live
 * socket, so the row the grant is keyed on is the row the hub sees.
 */
async function deviceHarness(name = 'ashish@studio'): Promise<DeviceHarness> {
  const harness = createTestUserDO({ deviceResponder: daemon });
  const { deviceId } = await harness.userDO.registerDevice(await testOwner(), name);
  harness.attachDevice(deviceId);
  const workspace = await provisionTestWorkspace(harness, WORKSPACE, 'Workspace A');
  const sibling = await provisionTestWorkspace(harness, OTHER_WORKSPACE, 'Workspace B');
  return Object.assign(harness, {
    deviceId,
    workspace: { workspaceToken: workspace } satisfies UserCaller,
    sibling: { workspaceToken: sibling } satisfies UserCaller,
  });
}

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
    expect(harness.consentPrompts).toEqual([
      { workspace: WORKSPACE, method: 'exec', command: 'rm -rf ~/work', workspaceName: WORKSPACE },
    ]);
    harness.close();
  });

  test('once the owner grants the workspace, calls run without asking again', async () => {
    const harness = await deviceHarness();
    harness.consentDecision = 'always';

    const first = await harness.userDO.deviceRpc(harness.workspace, 'exec', ['git status'], {
      agentName: WORKSPACE,
    });
    expect(first).toContain('"exitCode":0');
    expect(harness.consentPrompts).toHaveLength(1);

    // The grant is remembered, so the second call asks nobody and still runs.
    const second = await harness.userDO.deviceRpc(harness.workspace, 'exec', ['git log -1'], {
      agentName: WORKSPACE,
    });
    expect(second).toContain('"exitCode":0');
    expect(harness.consentPrompts).toHaveLength(1);
    expect(harness.deviceFrames.filter((f) => f.method === 'exec').map((f) => f.params[0]))
      .toEqual(['git status', 'git log -1']);
    harness.close();
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
    harness.close();
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
    harness.close();
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
    harness.close();
  });
});

describe('a device is visible before it is usable', () => {
  test('an ungranted workspace sees the machine by name, platform and liveness', async () => {
    const harness = await deviceHarness('ashish@studio');
    // Nobody has granted anything, and no consent prompt is raised by looking.
    const status = await harness.userDO.deviceRuntimeStatus(harness.workspace);

    expect(status.connected).toBe(true);
    expect(status.workspaceGranted).toBe(false);
    expect(status.devices).toEqual([
      { id: harness.deviceId, name: 'ashish@studio', os: null, hostname: null, connected: true },
    ]);
    expect(harness.consentPrompts).toEqual([]);
    harness.close();
  });

  test('the same read reports the grant once it exists', async () => {
    const harness = await deviceHarness();
    await harness.userDO.setDeviceConsentScope(await testOwner(), WORKSPACE, harness.deviceId, 'all_local_actions');

    expect((await harness.userDO.deviceRuntimeStatus(harness.workspace)).workspaceGranted).toBe(true);
    // A sibling's view is its own: the grant is not a property of the device.
    expect((await harness.userDO.deviceRuntimeStatus(harness.sibling)).workspaceGranted).toBe(false);
    harness.close();
  });

  test('a renamed device is renamed everywhere, because there is one name', async () => {
    const harness = await deviceHarness('ashish@studio');
    expect(await harness.userDO.renameDevice(await testOwner(), harness.deviceId, '  studio tower  '))
      .toEqual({ ok: true });

    expect((await harness.userDO.listDevices(await testOwner()))[0].label).toBe('studio tower');
    expect((await harness.userDO.deviceRuntimeStatus(harness.workspace)).devices?.[0].name)
      .toBe('studio tower');

    // An empty name is not a name, and an unknown device is not renamed.
    expect(await harness.userDO.renameDevice(await testOwner(), harness.deviceId, '   ')).toEqual({ ok: false });
    expect(await harness.userDO.renameDevice(await testOwner(), 'dev-nope', 'x')).toEqual({ ok: false });
    expect((await harness.userDO.listDevices(await testOwner()))[0].label).toBe('studio tower');
    harness.close();
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
    harness.close();
  });

  test('a card still waiting is not raised twice by a retrying agent', async () => {
    const harness = createTestUserDO();
    const workspace = await provisionTestWorkspace(harness, WORKSPACE, 'Workspace A');
    harness.pendingConsents.push({ consentId: 'cons-1', method: DEVICE_PROVISION_METHOD });

    await expect(harness.userDO.deviceRpc({ workspaceToken: workspace }, 'exec', ['make build'], {
      agentName: WORKSPACE,
    })).rejects.toThrow(NO_DEVICE_CONNECTED);

    expect(harness.consentPrompts).toEqual([]);
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
    const { deviceId } = await harness.userDO.registerDevice(await testOwner(), 'ashish@studio');
    harness.attachDevice(deviceId);
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
    harness.close();
  });
});

/**
 * A stolen `device.json` used to be an indefinite credential: the token never
 * changed and its window slid forward on every use, so a copy stayed valid for
 * as long as the thief kept connecting. These pin the three properties that
 * make it a race instead.
 */
describe('a copied device.json goes stale', () => {
  /** The daemon's own connect handshake, as `pc-handler` drives it: exchange the
   *  stored token for a ticket, then upgrade with that ticket. Answers the
   *  rotated token the hub pushes down the accepted socket. */
  async function connectDaemon(harness: TestUserDO, token: string): Promise<string | null> {
    const issued = await harness.userDO.issueDeviceConnectTicket(await testOwner(), token);
    if (!issued.ok || !issued.ticket) return null;
    const sent: string[] = [];
    const response = await harness.userDO.fetch(new Request(
      `https://kinu.example.com${DEVICE_CONNECT_PATH}?ticket=${issued.ticket}`,
      { headers: { Upgrade: 'websocket', 'cf-connecting-ip': '203.0.113.7', 'user-agent': 'kinu-daemon/1' } },
    ));
    expect(response.status).toBe(101);
    // The rotation frame rides the socket the hub just accepted.
    const socket = harness.acceptedSockets.at(-1);
    for (const frame of socket?.sent ?? []) sent.push(frame);
    const rotation = sent
      .map((raw) => v.safeParse(v.object({ type: v.string(), token: v.string() }), JSON.parse(raw)))
      .find((parsed) => parsed.success && parsed.output.type === DEVICE_TOKEN_ROTATION);
    return rotation?.success ? rotation.output.token : null;
  }

  test('the token rotates on every accepted connect, and the old copy dies', async () => {
    const harness = createTestUserDO({ deviceResponder: daemon });
    const { deviceId, token: first } = await harness.userDO.registerDevice(await testOwner(), 'ashish@studio');

    const second = await connectDaemon(harness, first);
    expect(second).toBeTruthy();
    expect(second).not.toBe(first);

    // The real daemon persisted the rotation and reconnects with it. That USE
    // is what ends the grace on the superseded secret.
    const third = await connectDaemon(harness, second ?? '');
    expect(third).toBeTruthy();

    // The thief still holds the file as it was written at link time.
    expect(await harness.userDO.verifyDeviceToken(await testOwner(), first)).toEqual({ ok: false });
    expect(await harness.userDO.issueDeviceConnectTicket(await testOwner(), first)).toEqual({ ok: false });
    // And the device itself is unharmed: its current secret works.
    expect(await harness.userDO.verifyDeviceToken(await testOwner(), third ?? ''))
      .toEqual({ ok: true, deviceId });
    harness.close();
  });

  test('a rotation lost with the socket does not brick the machine', async () => {
    const harness = createTestUserDO({ deviceResponder: daemon });
    const { deviceId, token: first } = await harness.userDO.registerDevice(await testOwner(), 'ashish@studio');

    // The hub rotated, but the daemon never saw the frame (socket died first),
    // so it redials with the secret it still has on disk.
    await connectDaemon(harness, first);
    expect(await harness.userDO.verifyDeviceToken(await testOwner(), first))
      .toEqual({ ok: true, deviceId });
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

    expect(await harness.userDO.verifyDeviceToken(await testOwner(), token)).toEqual({ ok: true, deviceId });
    expect(expiry()).toBe(anchor);

    // An elapsed window is refused, however recently the token was used.
    harness.sql.exec(`UPDATE user_devices SET expires_at = ? WHERE id = ?`, 1, deviceId);
    expect(await harness.userDO.verifyDeviceToken(await testOwner(), token)).toEqual({ ok: false });
    harness.close();
  });

  test('a second claimant on one device is recorded where the owner reads it', async () => {
    const harness = createTestUserDO({ deviceResponder: daemon });
    const { deviceId, token } = await harness.userDO.registerDevice(await testOwner(), 'ashish@studio');

    const rotated = await connectDaemon(harness, token);
    expect((await harness.userDO.listDevices(await testOwner()))[0]).toMatchObject({
      id: deviceId, lastIp: '203.0.113.7', lastAgent: 'kinu-daemon/1', replacedAt: null,
    });

    // A second socket for the same device — a redial, or somebody with a copy.
    await connectDaemon(harness, rotated ?? '');
    const [row] = await harness.userDO.listDevices(await testOwner());
    expect(row.replacedAt).not.toBeNull();
    harness.close();
  });
});

describe('the owner-session device bypass stays unreachable from HTTP', () => {
  test('no /api/user route forwards an arbitrary method to deviceRpc', () => {
    const source = readFileSync(new URL('../src/user/routes.ts', import.meta.url).pathname, 'utf8');
    // `deviceRpc` skips consent when the caller is the owner and no agentName
    // is passed (user-do.ts). That is correct for DO-to-DO bookkeeping and
    // catastrophic if an HTTP route ever exposes it: the owner's browser
    // session would become a shell on their own machine, ungated.
    expect(source).not.toContain('deviceRpc');
  });
});
