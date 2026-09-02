/**
 * The per-device Sandbox switch, at the boundary that enforces it.
 *
 * Two facts decide what a command does on the owner's machine: the switch the
 * owner set, and what that machine PROVED it can do when its daemon started.
 * The hub owns the decision — it computes the frame the daemon enforces, and
 * the daemon never picks a tier for itself. So these tests drive the real
 * UserDO over bun:sqlite with a connected device, deliver a real HELLO through
 * the real socket handler, and read the frame that did or did not leave.
 *
 * The claims, each provable in both directions:
 *   1. A machine that cannot sandbox runs NO command while the switch is on.
 *   2. The switch is the owner's. A workspace cannot turn it off.
 *   3. Every command carries the CALLING workspace's own home, not a shared
 *      one — one machine, many workspaces, one home each.
 *   4. A UserDO created before these columns existed gets them.
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import * as v from 'valibot';
import {
  DEVICE_SANDBOX_REASONS, SANDBOX_UNAVAILABLE, sandboxReasonFix,
  type JsonValue,
} from '@kinu.run/core';
import { sqlExec, testOwner, type DeviceFrame } from './helpers/user-do';
import { WORKSPACE, OTHER_WORKSPACE, daemon, deviceHarness } from './helpers/device-harness';
import { initUserTables } from '../src/user/schema';
import { CapabilityDeniedError } from '../src/user/workspace-capability';

/** The sandbox block of an EXEC frame, as the daemon reads it off the wire. */
const ExecSandboxSchema = v.object({
  tier: v.picklist(['sandboxed', 'raw']),
  agentHome: v.string(),
  roots: v.array(v.string()),
});

const FrameSandboxSchema = v.optional(ExecSandboxSchema);

/** A daemon that reports what this test wants it to have proved. `agentRoot`
 *  is where it keeps agent homes; the hub composes one home per workspace
 *  under it and never guesses a path on the machine. */
function hello(sandbox: JsonValue, extra: Record<string, JsonValue> = {}): JsonValue {
  return {
    type: 'HELLO', os: 'linux', hostname: 'studio',
    agentRoot: '/home/ashish/.kinu/agents',
    sandbox,
    ...extra,
  };
}

const CAPABLE = { capability: 'sandboxed', reason: null, gpu: ['/dev/nvidia0', '/dev/nvidiactl'] };

/** The exec frames that actually left, with their sandbox block. A refused
 *  command leaves none, which is the difference the first test rests on. */
function execFrames(harness: { deviceFrames: DeviceFrame[] }) {
  return harness.deviceFrames.filter((frame) => frame.method === 'exec');
}

describe('a machine that cannot sandbox runs no command', () => {
  test('a files_only HELLO refuses exec by name, and no frame reaches the machine', async () => {
    const harness = await deviceHarness('ashish@studio', daemon, { hello: null });
    harness.consentDecision = 'always';
    await harness.sendDeviceHello(hello({ capability: 'files_only', reason: 'no_userns', gpu: [] }));

    const refusal = harness.userDO.deviceRpc(harness.workspace, 'exec', ['make build'], {
      agentName: WORKSPACE,
    });
    await expect(refusal).rejects.toThrow(SANDBOX_UNAVAILABLE);
    // The reason the machine gave, and the fix the owner can act on, both reach
    // the model — a refusal nobody can act on is a dead end.
    await expect(refusal).rejects.toThrow('no_userns');
    await expect(refusal).rejects.toThrow(sandboxReasonFix('no_userns'));
    expect(execFrames(harness)).toEqual([]);
    await harness.closeDeviceHarness();
  });

  test('the file plane stays open on the same machine', async () => {
    // Files are not commands. A machine that cannot sandbox a shell can still
    // serve reads and writes under the view the daemon enforces, and cutting
    // that off would punish the owner twice for one missing package.
    const harness = await deviceHarness('ashish@studio', daemon, { hello: null });
    harness.consentDecision = 'always';
    await harness.sendDeviceHello(hello({ capability: 'files_only', reason: 'no_bwrap', gpu: [] }));

    await harness.userDO.deviceRpc(harness.workspace, 'readFile', ['/home/ashish/notes.md'], {
      agentName: WORKSPACE,
    });
    expect(harness.deviceFrames.map((frame) => frame.method)).toContain('readFile');
    await harness.closeDeviceHarness();
  });

  test('a daemon that claims a sandbox but names no agent root is not sandboxed', async () => {
    // There is nowhere to put the agent's home, so there is no frame to build.
    // Recorded as incapable at the HELLO boundary rather than discovered by a
    // command that has already been promised a sandbox.
    const harness = await deviceHarness('ashish@studio', daemon, { hello: null });
    harness.consentDecision = 'always';
    await harness.sendDeviceHello({ type: 'HELLO', sandbox: CAPABLE });

    await expect(harness.userDO.deviceRpc(harness.workspace, 'exec', ['ls'], { agentName: WORKSPACE }))
      .rejects.toThrow(SANDBOX_UNAVAILABLE);
    expect(execFrames(harness)).toEqual([]);
    await harness.closeDeviceHarness();
  });

  test('a daemon too old to say anything about sandboxing names its own age', async () => {
    // Silence is not proof. The owner turns the switch off, or the machine
    // runs no commands — it is never quietly given the whole computer. And
    // "it did not say" is not something an owner can act on, so the hub names
    // the build: every daemon deployed before this contract sends no sandbox
    // field at all, and the one fix is to update the CLI.
    const harness = await deviceHarness('ashish@studio', daemon, { hello: null });
    harness.consentDecision = 'always';
    await harness.sendDeviceHello({ type: 'HELLO', os: 'linux', hostname: 'studio' });

    const refusal = harness.userDO.deviceRpc(harness.workspace, 'exec', ['ls'], { agentName: WORKSPACE });
    await expect(refusal).rejects.toThrow(SANDBOX_UNAVAILABLE);
    await expect(refusal).rejects.toThrow('daemon_outdated');
    await expect(refusal).rejects.toThrow(sandboxReasonFix('daemon_outdated'));
    expect(execFrames(harness)).toEqual([]);

    // The Settings row reads the same reason, so the owner sees the same fix.
    expect((await harness.userDO.listDevices(await testOwner()))[0]?.sandbox).toEqual({
      tier: 'sandboxed', capability: 'files_only', reason: 'daemon_outdated', gpu: [],
    });
    await harness.closeDeviceHarness();
  });

  test('turning Sandbox off runs the command the sandbox refused', async () => {
    const harness = await deviceHarness('ashish@studio', daemon, { hello: null });
    harness.consentDecision = 'always';
    await harness.sendDeviceHello(hello({ capability: 'files_only', reason: 'wsl1', gpu: [] }));

    expect(await harness.userDO.setDeviceTier(await testOwner(), harness.deviceId, 'raw'))
      .toEqual({ ok: true });
    await harness.userDO.deviceRpc(harness.workspace, 'exec', ['make build'], { agentName: WORKSPACE });

    const frames = execFrames(harness);
    expect(frames).toHaveLength(1);
    await harness.closeDeviceHarness();
  });
});

describe('the Sandbox switch belongs to the owner', () => {
  test('a workspace caller cannot turn its own device sandbox off', async () => {
    const harness = await deviceHarness('ashish@studio', daemon, { hello: null });
    await harness.sendDeviceHello(hello(CAPABLE));

    await expect(harness.userDO.setDeviceTier(harness.workspace, harness.deviceId, 'raw'))
      .rejects.toThrow(CapabilityDeniedError);
    // And the refusal is not cosmetic: the row still says the sandbox is on.
    const devices = await harness.userDO.listDevices(await testOwner());
    expect(devices[0]?.sandbox.tier).toBe('sandboxed');
    await harness.closeDeviceHarness();
  });

  test('the owner sets it, and the device listing reports what the machine proved', async () => {
    const harness = await deviceHarness('ashish@studio', daemon, { hello: null });
    await harness.sendDeviceHello(hello(CAPABLE));

    expect(await harness.userDO.setDeviceTier(await testOwner(), harness.deviceId, 'raw'))
      .toEqual({ ok: true });
    expect((await harness.userDO.listDevices(await testOwner()))[0]?.sandbox).toEqual({
      tier: 'raw',
      capability: 'sandboxed',
      reason: null,
      gpu: ['/dev/nvidia0', '/dev/nvidiactl'],
    });
    await harness.closeDeviceHarness();
  });

  test('an unknown device is not silently accepted', async () => {
    const harness = await deviceHarness('ashish@studio', daemon, { hello: null });
    expect(await harness.userDO.setDeviceTier(await testOwner(), 'dev-nope', 'raw'))
      .toEqual({ ok: false });
    await harness.closeDeviceHarness();
  });
});

describe('the frame carries the calling workspace own home', () => {
  test('two workspaces on one machine get two homes and the consented roots', async () => {
    const harness = await deviceHarness('ashish@studio', daemon, { hello: null });
    harness.consentDecision = 'always';
    await harness.sendDeviceHello(hello(CAPABLE, { root: '/home/ashish/projects/kinu' }));

    await harness.userDO.deviceRpc(harness.workspace, 'exec', ['pwd'], { agentName: WORKSPACE });
    await harness.userDO.deviceRpc(harness.sibling, 'exec', ['pwd'], { agentName: OTHER_WORKSPACE });

    const sandboxes = harness.deviceFrames
      .filter((frame) => frame.method === 'exec')
      .map((frame) => v.parse(FrameSandboxSchema, frame.sandbox));
    expect(sandboxes).toEqual([
      {
        tier: 'sandboxed',
        agentHome: `/home/ashish/.kinu/agents/${WORKSPACE}/home`,
        roots: ['/home/ashish/projects/kinu'],
      },
      {
        tier: 'sandboxed',
        agentHome: `/home/ashish/.kinu/agents/${OTHER_WORKSPACE}/home`,
        roots: ['/home/ashish/projects/kinu'],
      },
    ]);
    await harness.closeDeviceHarness();
  });

  test('a machine that consented no directory sends an empty root list, never a guess', async () => {
    const harness = await deviceHarness('ashish@studio', daemon, { hello: null });
    harness.consentDecision = 'always';
    await harness.sendDeviceHello(hello(CAPABLE));

    await harness.userDO.deviceRpc(harness.workspace, 'exec', ['pwd'], { agentName: WORKSPACE });
    expect(v.parse(FrameSandboxSchema, execFrames(harness)[0]?.sandbox)?.roots).toEqual([]);
    await harness.closeDeviceHarness();
  });

  test('the runtime status hands the model the same home the frame carries', async () => {
    const harness = await deviceHarness('ashish@studio', daemon, { hello: null });
    harness.consentDecision = 'always';
    await harness.sendDeviceHello(hello(CAPABLE, { root: '/home/ashish/projects/kinu' }));

    const status = await harness.userDO.deviceRuntimeStatus(harness.workspace);
    expect(status.sandbox).toEqual({
      tier: 'sandboxed',
      capability: 'sandboxed',
      reason: null,
      gpu: ['/dev/nvidia0', '/dev/nvidiactl'],
      agentHome: `/home/ashish/.kinu/agents/${WORKSPACE}/home`,
      roots: ['/home/ashish/projects/kinu'],
    });
    await harness.closeDeviceHarness();
  });

  test('a later HELLO from an older daemon cannot erase the paths, but can withdraw the sandbox', async () => {
    // The paths are facts about the MACHINE and survive a downgrade. The
    // sandbox verdict is a fact about this daemon on this boot, so silence
    // withdraws it — a machine that stops being able to sandbox must stop
    // reading as able.
    const harness = await deviceHarness('ashish@studio', daemon, { hello: null });
    await harness.sendDeviceHello(hello(CAPABLE, { root: '/home/ashish/projects/kinu' }));
    await harness.sendDeviceHello({ type: 'HELLO', os: 'linux' });

    const status = await harness.userDO.deviceRuntimeStatus(harness.workspace);
    expect(status.sandbox?.capability).toBe('files_only');
    expect(status.sandbox?.roots).toEqual(['/home/ashish/projects/kinu']);
    expect(status.sandbox?.agentHome).toBe(`/home/ashish/.kinu/agents/${WORKSPACE}/home`);
    await harness.closeDeviceHarness();
  });
});

describe('the reason vocabulary is closed and every value carries a fix', () => {
  test('each reason a daemon may report round-trips onto the device row', async () => {
    for (const reason of DEVICE_SANDBOX_REASONS) {
      const harness = await deviceHarness('ashish@studio', daemon, { hello: null });
      await harness.sendDeviceHello(hello({ capability: 'files_only', reason, gpu: [] }));
      expect((await harness.userDO.listDevices(await testOwner()))[0]?.sandbox.reason).toBe(reason);
      expect(sandboxReasonFix(reason).length).toBeGreaterThan(0);
      await harness.closeDeviceHarness();
    }
  });

  test('a reason outside the vocabulary is recorded as no reason, not as itself', async () => {
    const harness = await deviceHarness('ashish@studio', daemon, { hello: null });
    await harness.sendDeviceHello(hello({ capability: 'files_only', reason: 'gremlins', gpu: [] }));
    expect((await harness.userDO.listDevices(await testOwner()))[0]?.sandbox.reason).toBeNull();
    await harness.closeDeviceHarness();
  });
});

describe('the columns reach a UserDO that predates them', () => {
  test('a pre-change user_devices gains the sandbox columns and keeps its row', () => {
    // The devices 500 of 2026-09-01 was exactly this: a column added to the
    // CREATE and not to the reconciliation object, so every older UserDO
    // answered `no such column` on a page that used to work.
    const db = new Database(':memory:');
    const sql = sqlExec(db);
    sql.exec(`
      CREATE TABLE user_devices (
        id              TEXT PRIMARY KEY,
        token_hash      TEXT NOT NULL,
        label           TEXT NOT NULL,
        os              TEXT,
        hostname        TEXT,
        created_at      INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
        connected_at    INTEGER,
        last_seen_at    INTEGER,
        revoked_at      INTEGER
      )
    `);
    sql.exec(`INSERT INTO user_devices (id, token_hash, label) VALUES ('dev-old', 'hash', 'studio')`);

    initUserTables(sql);

    const columns = sql.exec(`PRAGMA table_info(user_devices)`).toArray()
      .map((row) => v.parse(v.object({ name: v.string() }), row).name);
    for (const column of ['tier', 'sandbox_capability', 'sandbox_reason', 'sandbox_gpu', 'agent_root', 'consented_root']) {
      expect(columns).toContain(column);
    }
    // The switch is ON for a row written before the switch existed.
    const row = sql.exec(`SELECT label, tier FROM user_devices WHERE id = 'dev-old'`).toArray()[0];
    expect(v.parse(v.object({ label: v.string(), tier: v.string() }), row))
      .toEqual({ label: 'studio', tier: 'sandboxed' });
    db.close();
  });
});
