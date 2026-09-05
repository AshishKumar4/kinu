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
 *   4. The refusal carries what the daemon actually said. Every status the
 *      shipped daemon can report lands on the row as itself, with the
 *      daemon's own words beside it, and the sentence "the daemon reported
 *      no reason" survives only where the daemon really said nothing.
 */
import { describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import * as v from 'valibot';
import {
  DEVICE_SANDBOX_REASONS, SANDBOX_UNAVAILABLE, parseSandboxReason, sandboxReasonFix,
  type JsonValue,
} from '@kinu.run/core';
import { testOwner, type DeviceFrame } from './helpers/user-do';
import { WORKSPACE, OTHER_WORKSPACE, daemon, deviceHarness } from './helpers/device-harness';
import { CapabilityDeniedError } from '../src/user/workspace-capability';

/** The shipped daemon's own sandbox module: the statuses its probe can answer
 *  and the HELLO block it builds from one. Loaded rather than restated, so a
 *  status the daemon gains is a status this suite sends. */
const DaemonSandboxModuleSchema = v.object({
  SANDBOX_STATUS: v.record(v.string(), v.string()),
  PROBE_HINTS: v.record(v.string(), v.string()),
  helloCapability: v.function(),
});
const DaemonHelloSandboxSchema = v.object({
  capability: v.string(),
  reason: v.nullable(v.string()),
  reasonDetail: v.optional(v.nullable(v.string())),
});
const require_ = createRequire(import.meta.url);
const daemonSandbox = v.parse(
  DaemonSandboxModuleSchema, require_(join(import.meta.dir, '../../pc-agent/src/sandbox.js')),
);

/** One of the daemon's status words, by the daemon's own name for it. */
function daemonStatus(key: 'OK' | 'PROBE_FAILED'): string {
  const word = daemonSandbox.SANDBOX_STATUS[key];
  if (word === undefined) throw new Error(`the daemon's SANDBOX_STATUS has no ${key}`);
  return word;
}

/** The sandbox block the shipped daemon sends for one probe result, as JSON. */
function daemonHello(status: string, detail: string | null): JsonValue {
  const wire = v.parse(DaemonHelloSandboxSchema, daemonSandbox.helloCapability({ status, detail }));
  return {
    capability: wire.capability,
    reason: wire.reason,
    reasonDetail: wire.reasonDetail ?? null,
    gpu: [],
  };
}

/** The line the daemon's probe answered on the first-run tier's runner,
 *  measured 2026-09-04. */
const PROBE_FAILED_DETAIL =
  "sandbox probe failed: bwrap: Can't chdir to /tmp/kinu-first-run-probe-6B5G: No such file or directory";

const NO_REASON = 'the daemon reported no reason';

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

  test('a daemon that claims a sandbox but names no agent root is not sandboxed, and is told which build to fix', async () => {
    // There is nowhere to put the agent's home, so there is no frame to build.
    // Recorded as incapable at the HELLO boundary rather than discovered by a
    // command that has already been promised a sandbox. The verdict is the
    // hub's, so its words are the hub's, and the fix is the build, because
    // every daemon that sends a verdict also sends the root.
    const harness = await deviceHarness('ashish@studio', daemon, { hello: null });
    harness.consentDecision = 'always';
    await harness.sendDeviceHello({ type: 'HELLO', os: 'linux', sandbox: CAPABLE });

    const refusal = harness.userDO.deviceRpc(harness.workspace, 'exec', ['ls'], { agentName: WORKSPACE });
    await expect(refusal).rejects.toThrow(SANDBOX_UNAVAILABLE);
    await expect(refusal).rejects.toThrow('daemon_outdated: the daemon proved a sandbox but did not say where agent homes live');
    await expect(refusal).rejects.toThrow(sandboxReasonFix('daemon_outdated'));
    await expect(refusal).rejects.not.toThrow(NO_REASON);
    expect(execFrames(harness)).toEqual([]);
    expect((await harness.userDO.listDevices(await testOwner()))[0]?.sandbox).toEqual({
      tier: 'sandboxed', capability: 'files_only', reason: 'daemon_outdated',
      detail: 'the daemon proved a sandbox but did not say where agent homes live', gpu: CAPABLE.gpu,
    });
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
      tier: 'sandboxed', capability: 'files_only', reason: 'daemon_outdated', detail: null, gpu: [],
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
      detail: null,
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
      detail: null,
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

  test('a reason outside the vocabulary is recorded as no reason, and the HELLO still lands', async () => {
    // The word is unknown to this hub; the machine is not. Everything else the
    // daemon said (platform, verdict, its own words for the failure) is
    // recorded, and the refusal repeats those words because they are the only
    // cause there is.
    const harness = await deviceHarness('ashish@studio', daemon, { hello: null });
    harness.consentDecision = 'always';
    await harness.sendDeviceHello(hello({
      capability: 'files_only', reason: 'gremlins', reasonDetail: 'the gremlins ate the namespace', gpu: [],
    }));
    const device = (await harness.userDO.listDevices(await testOwner()))[0];
    expect(device?.os).toBe('linux');
    expect(device?.sandbox).toEqual({
      tier: 'sandboxed', capability: 'files_only', reason: null,
      detail: 'gremlins: the gremlins ate the namespace', gpu: [],
    });

    const refusal = harness.userDO.deviceRpc(harness.workspace, 'exec', ['ls'], { agentName: WORKSPACE });
    await expect(refusal).rejects.toThrow('gremlins: the gremlins ate the namespace');
    await expect(refusal).rejects.toThrow(sandboxReasonFix(null));
    await expect(refusal).rejects.not.toThrow(NO_REASON);
    await harness.closeDeviceHarness();
  });
});

describe('the refusal carries what the daemon actually said', () => {
  test('a probe that failed in words the daemon does not classify reaches the model verbatim', async () => {
    // THE FIRST-RUN DEFECT. The daemon's probe ran bwrap and bwrap failed in a
    // way the daemon has no word for, so it reported `probe_failed` and the
    // one line that says what happened. The hub had no such word, refused the
    // whole HELLO for it, recorded nothing, and told the model "the daemon
    // reported no reason" while the daemon's log held the reason.
    const harness = await deviceHarness('ashish@studio', daemon, { hello: null });
    harness.consentDecision = 'always';
    await harness.sendDeviceHello(hello(daemonHello(daemonStatus('PROBE_FAILED'), PROBE_FAILED_DETAIL)));

    const refusal = harness.userDO.deviceRpc(harness.workspace, 'exec', ['rm -r doomed'], { agentName: WORKSPACE });
    await expect(refusal).rejects.toThrow(SANDBOX_UNAVAILABLE);
    await expect(refusal).rejects.toThrow(`probe_failed: ${PROBE_FAILED_DETAIL}`);
    await expect(refusal).rejects.toThrow(sandboxReasonFix('probe_failed'));
    await expect(refusal).rejects.not.toThrow(NO_REASON);
    expect(execFrames(harness)).toEqual([]);

    // The row holds the same words, so the Settings row and `kinu connect`
    // show the owner what the model was told.
    const device = (await harness.userDO.listDevices(await testOwner()))[0];
    expect(device?.os).toBe('linux');
    expect(device?.sandbox).toEqual({
      tier: 'sandboxed', capability: 'files_only', reason: 'probe_failed',
      detail: PROBE_FAILED_DETAIL, gpu: [],
    });
    await harness.closeDeviceHarness();
  });

  test('every status the shipped daemon can report lands on the row as itself, with its hint', async () => {
    // Measured against the daemon's own status table, not a copy of it. The
    // hub's vocabulary minus the one word the hub assigns must be exactly the
    // words the daemon can send, in both directions.
    const statuses = Object.values(daemonSandbox.SANDBOX_STATUS).filter((status) => status !== daemonStatus('OK'));
    expect([...statuses].sort())
      .toEqual(DEVICE_SANDBOX_REASONS.filter((reason) => reason !== 'daemon_outdated').sort());
    for (const status of statuses) {
      const reason = parseSandboxReason(status);
      expect(reason).not.toBeNull();
      const detail = daemonSandbox.PROBE_HINTS[status] ?? PROBE_FAILED_DETAIL;
      const harness = await deviceHarness('ashish@studio', daemon, { hello: null });
      harness.consentDecision = 'always';
      await harness.sendDeviceHello(hello(daemonHello(status, detail)));
      const sandbox = (await harness.userDO.listDevices(await testOwner()))[0]?.sandbox;
      expect(sandbox?.reason).toBe(reason);
      expect(sandbox?.detail).toBe(detail);
      // `raw_only` is a platform fact and the switch is the owner's only move;
      // it is still refused while the switch is on, naming the platform.
      const refusal = harness.userDO.deviceRpc(harness.workspace, 'exec', ['ls'], { agentName: WORKSPACE });
      await expect(refusal).rejects.toThrow(`${status}: ${detail}`);
      await expect(refusal).rejects.toThrow(sandboxReasonFix(reason));
      await harness.closeDeviceHarness();
    }
  });

  test('"the daemon reported no reason" survives only where the daemon said nothing', async () => {
    // Two machines with nothing behind the verdict: one whose daemon answered
    // `files_only` with no reason and no words, and one whose daemon has not
    // said HELLO at all. The sentence is true of both and of nothing else.
    const silent = await deviceHarness('ashish@studio', daemon, { hello: null });
    silent.consentDecision = 'always';
    await silent.sendDeviceHello(hello({ capability: 'files_only', reason: null, gpu: [] }));
    const silentRefusal = silent.userDO.deviceRpc(silent.workspace, 'exec', ['ls'], { agentName: WORKSPACE });
    await expect(silentRefusal).rejects.toThrow(`(${NO_REASON})`);
    await expect(silentRefusal).rejects.toThrow(sandboxReasonFix(null));
    expect((await silent.userDO.listDevices(await testOwner()))[0]?.sandbox.detail).toBeNull();
    await silent.closeDeviceHarness();

    const unheard = await deviceHarness('ashish@studio', daemon, { hello: null });
    unheard.consentDecision = 'always';
    const unheardRefusal = unheard.userDO.deviceRpc(unheard.workspace, 'exec', ['ls'], { agentName: WORKSPACE });
    await expect(unheardRefusal).rejects.toThrow(`(${NO_REASON})`);
    expect(execFrames(unheard)).toEqual([]);
    await unheard.closeDeviceHarness();
  });
});

