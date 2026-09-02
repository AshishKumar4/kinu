/**
 * The composer's Stop, against a command that is running on the user's machine.
 *
 * A turn can start a build, a test suite or an install on the owner's own
 * computer, and stopping that turn used to be a statement about this side only:
 * the local AbortControllers were aborted, the wait was rejected, and the
 * command kept running with nothing left that could reach it. So this suite
 * drives the whole rail as production has it — a real `OrchestratorAgent`
 * holding the capability token a real `UserDO` minted for it, a device socket
 * that answers like the daemon — and asks the three questions that make Stop a
 * stop rather than a claim:
 *
 *   1. Does the STOP reach the machine? A cancellation frame naming the very
 *      request the command was issued under, over the same tunnel the command
 *      went out on.
 *   2. Is it CONSENT-RESPECTING? The command asks the owner; the stop asks
 *      nobody, because a live process must never wait on a card at an unattended
 *      keyboard.
 *   3. Is the outcome OBSERVED and CLASSIFIED? What Stop answers, and what it
 *      broadcasts to every open tab, is the daemon's own verdict per command —
 *      never a blanket success over work nothing confirmed had ended.
 *
 * The device answers on this test's schedule (the command's result is withheld
 * until after its own cancellation), because that is the ordering a real machine
 * produces and an always-immediate double cannot express.
 */
import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';
import { DEVICE_CANCEL_METHOD, DEVICE_EXEC_ACK_METHOD, type JsonValue } from '@kinu.run/core';
import {
  createTestUserDO, provisionTestWorkspace, testOwner,
  type DeviceFrame, type TestUserDO,
} from './helpers/user-do';
import { CAPABLE_HELLO, daemon, type DeviceResponder } from './helpers/device-harness';
import {
  orchestratorHarness, type ActorHarness, type HarnessOrchestratorAgent,
} from './helpers/actor-harness';

const OWNER_USER_ID = '0123456789abcdef0123456789abcdef';
const WORKSPACE = 'jarvis';
const TURN = 'u-turn-with-a-laptop-command';

/** The `work_cancelled` frame, parsed rather than cast: `deviceCommands` is the
 *  part of Stop's answer that says what happened on the user's machine, so the
 *  wire shape is asserted, not assumed. */
const WorkCancelledSchema = v.object({
  type: v.literal('work_cancelled'),
  abortedTools: v.number(),
  deviceCommands: v.array(v.object({
    requestId: v.optional(v.string()),
    outcome: v.picklist(['terminated', 'unknown', 'failed']),
    detail: v.optional(v.string()),
  })),
  timestamp: v.number(),
});

interface StopRail {
  user: TestUserDO;
  actor: ActorHarness<HarnessOrchestratorAgent>;
  /** Frames the actor pushed to connected clients. */
  broadcasts: string[];
  /** What the device was asked, in order. */
  askedMethods: () => string[];
  /** The command or request id each `method` frame named. */
  askedAbout: (method: string) => JsonValue[];
  /** Durable in-flight device rows, as the authority holds them. */
  inflightRows: () => Array<{ request_id: string; turn_id: string | null }>;
  close: () => Promise<void>;
}

/**
 * The rail, standing up: one owner, one registered+connected device, one claimed
 * workspace whose actor holds the token that workspace's own UserDO minted.
 *
 * `responder` is the machine. A turn is OPEN on the actor, because a durable
 * device command is stamped with the turn that issued it and that stamp is what
 * a Stop sweeps by.
 */
async function stopRail(responder: DeviceResponder): Promise<StopRail> {
  const user = createTestUserDO({ durableObjectId: OWNER_USER_ID, deviceResponder: responder });
  const { deviceId } = await user.userDO.registerDevice(await testOwner(), 'ashish@studio');
  user.attachDevice(deviceId);
  // A real daemon proves what it can sandbox the moment its socket opens; a
  // machine that says nothing is one the hub correctly refuses to run on.
  await user.sendDeviceHello(CAPABLE_HELLO);
  const token = await provisionTestWorkspace(user, WORKSPACE, 'Jarvis');
  const actor = orchestratorHarness(undefined, {
    userDO: user.userDO, workspace: WORKSPACE, ownerUserId: OWNER_USER_ID,
  });
  actor.agent.harnessHoldsCapability(token);
  // The turn-start refresh production detaches, awaited: it is what makes the
  // connected device visible to this actor's laptop runtime.
  await actor.agent.harnessRefreshDeviceStatus();
  // The turn the command belongs to, opened through the same seam production
  // opens it with, so the durable row carries a turn a Stop can name.
  actor.agent.harnessBeginTurn(TURN);
  const broadcasts: string[] = [];
  Reflect.set(actor.agent, 'broadcast', (payload: string) => { broadcasts.push(payload); });
  return {
    user,
    actor,
    broadcasts,
    askedMethods: () => user.deviceFrames.map((frame) => frame.method),
    askedAbout: (method) => user.deviceFrames
      .filter((frame) => frame.method === method)
      .map((frame) => frame.params[0]),
    inflightRows: () => user.db.prepare<{ request_id: string; turn_id: string | null }, []>(
      'SELECT request_id, turn_id FROM device_inflight_requests',
    ).all(),
    close: async () => {
      await user.joinFibers();
      user.close();
    },
  };
}

/** Wait until the device has actually been asked `method`, so the test acts on a
 *  command genuinely in flight rather than on one it hopes is. Each hop is one
 *  event-loop turn; nothing here reads the clock. */
async function asked(rail: StopRail, method: string): Promise<void> {
  for (let hop = 0; hop < 200; hop += 1) {
    if (rail.askedMethods().includes(method)) return;
    const { promise, resolve } = Promise.withResolvers<void>();
    setImmediate(resolve);
    await promise;
  }
  throw new Error(`the device was never asked to ${method}`);
}

/** A machine whose command finishes when this test says so — which is how a
 *  completion can be put on the far side of its own cancellation. */
function holdingDaemon(cancelled: 'terminated' | 'unknown' = 'terminated') {
  const held = Promise.withResolvers<JsonValue>();
  return {
    responder: (frame: DeviceFrame): JsonValue | Promise<JsonValue> => {
      if (frame.method === 'exec') return held.promise;
      if (frame.method === DEVICE_CANCEL_METHOD) {
        return { requestId: String(frame.params[0]), cancelled };
      }
      return daemon(frame);
    },
    release: () => held.resolve({ stdout: 'partial build output', stderr: '', exitCode: 0 }),
  };
}

describe('stopping the turn stops the command running on the owner\'s machine', () => {
  test('the stop crosses the consent tunnel and its outcome is classified per command', async () => {
    const machine = holdingDaemon('terminated');
    const rail = await stopRail(machine.responder);
    // The owner let this workspace touch their machine. Consent decides what may
    // RUN — and it is the tunnel the command and its stop both travel.
    rail.user.consentDecision = 'always';

    // A command the model started, still running: the daemon holds its result.
    const running = rail.actor.agent.executeInExecutor('laptop', 'bun run build');
    await asked(rail, 'exec');
    const requestId = rail.inflightRows()[0]?.request_id;
    if (requestId === undefined) throw new Error('the command left no durable row to stop');
    expect(rail.inflightRows()).toEqual([{ request_id: requestId, turn_id: TURN }]);
    expect(rail.user.consentPrompts.map((prompt) => prompt.method)).toEqual(['exec']);

    // Stop, as the composer's button calls it.
    const outcome = await rail.actor.agent.cancelCurrentWork();

    // 1. It reached the machine, naming the command's own request identity.
    expect(rail.askedAbout(DEVICE_CANCEL_METHOD)).toEqual([requestId]);
    // 2. It asked nobody: only the command raised a card.
    expect(rail.user.consentPrompts.map((prompt) => prompt.method)).toEqual(['exec']);
    // 3. The answer carries the daemon's verdict for that command, not a blanket
    //    success — and the same verdict reaches every open tab.
    expect(outcome.deviceCommands).toEqual([{ requestId, outcome: 'terminated' }]);
    const frames = rail.broadcasts.map((payload) => v.safeParse(WorkCancelledSchema, JSON.parse(payload)));
    const cancelled = frames.filter((frame) => frame.success).map((frame) => frame.output);
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]?.deviceCommands).toEqual([{ requestId, outcome: 'terminated' }]);
    // The stopped command's supervisor was released and its row is gone, so a
    // second Stop has nothing to kill twice.
    expect(rail.askedAbout(DEVICE_EXEC_ACK_METHOD)).toContain(requestId);
    expect(rail.inflightRows()).toEqual([]);
    expect(await rail.actor.agent.cancelCurrentWork()).toMatchObject({ deviceCommands: [] });
    expect(rail.askedAbout(DEVICE_CANCEL_METHOD)).toEqual([requestId]);

    // The machine's own late answer belongs to the caller that asked for it and
    // to nothing else.
    machine.release();
    await running;
    await rail.close();
  }, 20_000);

  test('a stop nothing confirmed is reported as failed rather than as a stopped command', async () => {
    // The machine cannot perform the kill — the kernel refused it, or the
    // supervisor that owned the command's process group is gone. Nothing
    // observed the work end, so Stop must not report a stopped command: the
    // command may still be executing on the owner's computer.
    let killWorks = false;
    const held = Promise.withResolvers<JsonValue>();
    const rail = await stopRail((frame: DeviceFrame) => {
      if (frame.method === 'exec') return held.promise;
      if (frame.method === DEVICE_CANCEL_METHOD) {
        if (!killWorks) throw new Error('the kernel refused the kill');
        return { requestId: String(frame.params[0]), cancelled: 'terminated' };
      }
      return daemon(frame);
    });
    rail.user.consentDecision = 'always';

    const running = rail.actor.agent.executeInExecutor('laptop', 'bun run build');
    await asked(rail, 'exec');
    const requestId = rail.inflightRows()[0]?.request_id;
    if (requestId === undefined) throw new Error('the command left no durable row to stop');

    const outcome = await rail.actor.agent.cancelCurrentWork();

    expect(outcome.deviceCommands).toHaveLength(1);
    expect(outcome.deviceCommands[0]?.outcome).toBe('failed');
    expect(outcome.deviceCommands[0]?.detail).toContain('refused the kill');
    // The owner-facing frame says the same thing: no tab is told this stopped.
    const cancelled = rail.broadcasts
      .map((payload) => v.safeParse(WorkCancelledSchema, JSON.parse(payload)))
      .filter((frame) => frame.success)
      .map((frame) => frame.output);
    expect(cancelled[0]?.deviceCommands[0]?.outcome).toBe('failed');
    // Still live work: the claim went back, so the row is there for the next
    // sweep — a failed stop is retryable, never forgotten.
    expect(rail.inflightRows()).toEqual([{ request_id: requestId, turn_id: TURN }]);

    // And the retry, once the machine can kill again, is the confirmed stop.
    killWorks = true;
    expect((await rail.actor.agent.cancelCurrentWork()).deviceCommands)
      .toEqual([{ requestId, outcome: 'terminated' }]);
    expect(rail.inflightRows()).toEqual([]);

    held.resolve({ stdout: '', stderr: '', exitCode: 0 });
    await running;
    await rail.close();
  }, 20_000);
});
