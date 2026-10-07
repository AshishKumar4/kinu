/**
 * The production device-command ledger across a real Durable Object activation reset (bun cannot; see
 * ./device-inflight-probe.ts), and the production UserDO's chokepoint against a machine the test plays over a real
 * socket (./device-user-probe.ts). Defends: a dead activation's claim strands the request, a stored answer is lost or
 * overwritten, an interrupted acknowledgement deletes a still-replayable row, a mispaired cancel confirms anything, a
 * completion held past its cancellation publishes anything, and withdrawing consent passes for a stop.
 */
import { env } from 'cloudflare:workers';
import { abortAllDurableObjects } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import * as v from 'valibot';
import {
  DEVICE_CANCEL_METHOD, DEVICE_CANCEL_MISPAIRED, DEVICE_CONNECT_PATH, DEVICE_CONSENT_DENIED, DEVICE_EXEC_ACK_METHOD,
  DEVICE_FEATURES, DEVICE_PROTOCOL_VERSION, JsonValueSchema, TUNNEL_DISCONNECTED, nextDeviceRequestId, type JsonValue,
} from '@kinu.run/core';

/** A stub held across a reset is broken by it; re-acquire from the id, as a real caller does. */
const probe = (name: string) => env.DEVICE_LEDGER_PROBE.get(env.DEVICE_LEDGER_PROBE.idFromName(name));

const TURN = 'turn-1';

describe('a cancellation claim the activation died holding', () => {
  it('is expired by the next activation, and the request is live work again', async () => {
    const request = 'rpc-workerdprobe-1';
    await probe('abandoned-claim').admit(request, TURN);

    // A sweep claims the row and is interrupted before storing an answer; the claim hides the row.
    const claimed = await probe('abandoned-claim').claimTurn(TURN);
    expect(claimed).toMatchObject([{ requestId: request, settled: null }]);
    expect(claimed[0].claim).not.toBe('');
    // Negative control: the claim is exclusive within one activation.
    expect(await probe('abandoned-claim').claimTurn(TURN)).toEqual([]);

    await abortAllDurableObjects();

    // The fresh activation released the dead claim.
    const reclaimed = await probe('abandoned-claim').claimTurn(TURN);
    expect(reclaimed).toMatchObject([{ requestId: request, settled: null }]);
    expect(reclaimed[0].claim).not.toBe(claimed[0].claim);

    expect(await probe('abandoned-claim').held(request, claimed[0].claim)).toBeNull();
    expect(await probe('abandoned-claim').settle(request, claimed[0].claim, 'terminated')).toBeNull();
  });
});

describe('the first stored answer', () => {
  it('survives the reset, and the next authority reports it instead of killing again', async () => {
    const request = 'rpc-workerdprobe-2';
    await probe('first-writer').admit(request, TURN);
    const claimed = await probe('first-writer').claimTurn(TURN);

    // The answer is stored before the acknowledgement, which is the step that can fail.
    expect(await probe('first-writer').settle(request, claimed[0].claim, 'terminated')).toBe('terminated');
    expect(await probe('first-writer').rows())
      .toEqual([{ requestId: request, claim: claimed[0].claim, settled: 'terminated' }]);

    await abortAllDurableObjects();

    // Settled: owes only cleanup and must never be cancelled a second time.
    const later = await probe('first-writer').claimTurn(TURN);
    expect(later).toMatchObject([{ requestId: request, settled: 'terminated' }]);
    expect(await probe('first-writer').held(request, later[0].claim))
      .toEqual({ settled: 'terminated' });
    expect(await probe('first-writer').transfer(request, 'job-1')).toEqual({ transferred: false });

    await probe('first-writer').deleteHeld(request, later[0].claim);
    expect(await probe('first-writer').rows()).toEqual([]);
  });
});

describe('an answer that lands while the sweep is still waiting on the device', () => {
  it('is the answer reported, not the sweep\'s later guess', async () => {
    const request = 'rpc-workerdprobe-4';
    await probe('answer-race').admit(request, TURN);
    const claimed = await probe('answer-race').claimTurn(TURN);
    expect(claimed).toMatchObject([{ requestId: request, settled: null }]);

    // While the sweep awaits the device, the tool's own abort stores the confirmed kill unclaimed.
    await probe('answer-race').settleUnclaimed(request, 'terminated');

    // The sweep's late `unknown` is a guess; reporting a dead command as 'may have' stopped is the defect pinned.
    expect(await probe('answer-race').settle(request, claimed[0].claim, 'unknown'))
      .toBe('terminated');
    expect(await probe('answer-race').rows())
      .toEqual([{ requestId: request, claim: claimed[0].claim, settled: 'terminated' }]);

    await abortAllDurableObjects();

    expect(await probe('answer-race').claimTurn(TURN))
      .toMatchObject([{ requestId: request, settled: 'terminated' }]);
  });
});

describe('an acknowledgement interrupted between its read and its delete', () => {
  it('leaves the record intact, so the daemon result stays replayable', async () => {
    const request = 'rpc-workerdprobe-3';
    await probe('ack-ordering').admit(request, TURN);

    // Acknowledged the daemon; the activation ended before the delete.
    const held = await probe('ack-ordering').acknowledgeable(request);
    expect(held).toEqual({ deviceId: 'dev-probe' });

    await abortAllDurableObjects();

    expect(await probe('ack-ordering').rows())
      .toEqual([{ requestId: request, claim: '', settled: null }]);

    // The retry's delete is compare-guarded against the row it read.
    await probe('ack-ordering').deleteAcknowledged(request, 'dev-probe');
    expect(await probe('ack-ordering').rows()).toEqual([]);
  });

  it('never deletes a replacement command that reused the request id', async () => {
    const request = 'rpc-workerdprobe-4';
    await probe('ack-replacement').admit(request, TURN);
    expect(await probe('ack-replacement').acknowledgeable(request)).toEqual({ deviceId: 'dev-probe' });

    // The acknowledgement's delete may not touch a row a cancellation now holds.
    const claimed = await probe('ack-replacement').claimTurn(TURN);
    await probe('ack-replacement').deleteAcknowledged(request, 'dev-probe');
    expect(await probe('ack-replacement').rows())
      .toEqual([{ requestId: request, claim: claimed[0].claim, settled: null }]);
  });
});

/** The account object, addressed by its owner's id as the product addresses it. */
const account = (name: string) => env.DEVICE_USER_PROBE.get(env.DEVICE_USER_PROBE.idFromName(name));

const FrameSchema = v.object({ id: v.string(), method: v.string(), params: v.array(JsonValueSchema) });

/** What the machine says of a command, or that it holds it until the test lets it finish. */
type Answer = { readonly said: JsonValue } | { readonly hold: true };

interface Machine {
  readonly deviceId: string;
  /** Every request the machine was sent, in order. */
  readonly frames: Array<v.InferOutput<typeof FrameSchema>>;
  /** Resolves once the machine was asked `method`. */
  asked(method: string): Promise<void>;
  /** Finishes the held command the way a build ends. */
  release(): void;
  /** Resolves once the account closed the machine's socket. */
  readonly dropped: Promise<void>;
  close(): void;
}

/** A paired machine with its daemon connected, and `workspace` bound to it; `answer` is its daemon. */
async function machine(owner: string, workspace: string, answer: (frame: v.InferOutput<typeof FrameSchema>) => Answer): Promise<Machine> {
  const { deviceId, ticket } = await account(owner).pair('ashish@studio');
  const upgraded = await account(owner).fetch(`http://probe${DEVICE_CONNECT_PATH}?ticket=${encodeURIComponent(ticket)}`, { headers: { Upgrade: 'websocket' } });
  const socket = upgraded.webSocket;

  if (socket === null) throw new Error(`the account refused the machine: ${String(upgraded.status)}`);
  socket.accept();
  const frames: Array<v.InferOutput<typeof FrameSchema>> = [];
  const watchers: Array<{ readonly method: string; readonly heard: () => void }> = [];
  const held: string[] = [];
  const dropped = Promise.withResolvers<void>();

  socket.addEventListener('close', () => { dropped.resolve(); });

  socket.addEventListener('message', (event) => {
    const frame = v.safeParse(FrameSchema, JSON.parse(String(event.data)));

    if (!frame.success) return;
    frames.push(frame.output);

    for (const watcher of watchers.splice(0)) {
      if (watcher.method === frame.output.method) watcher.heard();
      else watchers.push(watcher);
    }

    const reply = answer(frame.output);

    if ('hold' in reply) held.push(frame.output.id);
    else socket.send(JSON.stringify({ id: frame.output.id, result: reply.said }));
  });

  socket.send(JSON.stringify({
    type: 'HELLO', protocolVersion: DEVICE_PROTOCOL_VERSION, features: [...DEVICE_FEATURES], os: 'linux', hostname: 'studio',
    agentRoot: '/home/ashish/.kinu/agents', sandbox: { capability: 'sandboxed', reason: null, gpu: [] },
  }));
  await account(owner).bindWorkspace(workspace, deviceId);

  return {
    deviceId,
    frames,
    asked: async (method) => {
      if (frames.some((frame) => frame.method === method)) return;
      const { promise, resolve } = Promise.withResolvers<void>();

      watchers.push({ method, heard: resolve });
      await promise;
    },
    release: () => {
      for (const id of held.splice(0)) socket.send(JSON.stringify({ id, result: { stdout: 'built', stderr: '', exitCode: 0 } }));
    },
    dropped: dropped.promise,
    close: () => { socket.close(1000, 'machine done'); },
  };
}

/** A daemon that answers each cancel as `cancelled`, holds `exec`, and answers anything else as done. */
const holding = (cancelled: 'terminated' | 'unknown') => (frame: v.InferOutput<typeof FrameSchema>): Answer => {
  if (frame.method === 'exec') return { hold: true };

  if (frame.method === DEVICE_CANCEL_METHOD) return { said: { requestId: v.parse(v.string(), frame.params[0]), cancelled } };

  return { said: frame.method === 'which' ? { present: [] } : DONE };
};

const DONE = { stdout: 'ok', stderr: '', exitCode: 0 };

/** A call's end, watched from the moment it is made: a refusal that lands while another call runs is not left unhandled. */
async function settling<T>(call: Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await call };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

/** The JSON a finished command answered with. */
const answered = (settled: { ok: true; value: string | undefined } | { ok: false; error: string }) => (settled.ok ? JSON.parse(settled.value ?? 'null') : settled.error);

const asked = (at: Machine, method: string) => at.frames.filter((frame) => frame.method === method).map((frame) => frame.params[0]);

const OWNER = '0123456789abcdef0123456789abcd01';

describe('a machine that answers a cancellation for another command', () => {
  it('confirms nothing on a Stop or on the tool\'s own abort, keeps the request live, and is counted as unstopped', async () => {
    // Believing this kill claim would delete a row whose processes are still running.
    const at = await machine(OWNER, 'ws-mispaired', (frame) => ({
      said: frame.method === DEVICE_CANCEL_METHOD ? { requestId: 'rpc-elsewhere0-4', cancelled: 'terminated' } : DONE,
    }));

    const request = nextDeviceRequestId();

    await account(OWNER).admit(request, at.deviceId, 'ws-mispaired', TURN);
    const outcomes = await account(OWNER).stopTurn('ws-mispaired', TURN);

    expect(outcomes).toEqual([expect.objectContaining({ outcome: 'failed', detail: expect.stringContaining(DEVICE_CANCEL_MISPAIRED) })]);
    expect(await settling(account(OWNER).cancelOwn('ws-mispaired', request))).toEqual({ ok: false, error: expect.stringContaining(DEVICE_CANCEL_MISPAIRED) });
    // Still live work, so the next sweep asks again.
    expect(await account(OWNER).requests()).toEqual([{ requestId: request, turnId: TURN, outcome: null, claim: null }]);
    expect(await account(OWNER).revoke(at.deviceId)).toEqual({ ok: true, unstoppedCommands: 1 });
    expect(await account(OWNER).unstoppedSince(at.deviceId)).not.toBeNull();
    at.close();
  });
});

describe('a completion held past its own cancellation', () => {
  it('publishes no row, frame or acknowledgement after the request settled; the late answer is only its caller\'s', async () => {
    const owner = '0123456789abcdef0123456789abcd02';
    // Already finished on the machine, so the daemon holds no control entry for it: the completion boundary.
    const at = await machine(owner, 'ws-held', holding('unknown'));
    const request = nextDeviceRequestId();
    const running = settling(account(owner).run('ws-held', request, TURN, 'bun run build'));

    await at.asked('exec');
    expect(await account(owner).stopTurn('ws-held', TURN)).toEqual([{ requestId: request, outcome: 'unknown' }]);
    expect(asked(at, DEVICE_EXEC_ACK_METHOD)).toContain(request);
    expect(await account(owner).requests()).toEqual([]);
    const atSettlement = at.frames.length;

    at.release();
    expect(answered(await running)).toMatchObject({ exitCode: 0 });
    await account(owner).acknowledge('ws-held', request);
    expect(at.frames).toHaveLength(atSettlement);
    expect(await account(owner).requests()).toEqual([]);
    at.close();
  });
});

describe('withdrawing a workspace\'s consent while its command runs', () => {
  it('does not stop it, and the next command waits on the owner, who refuses it', async () => {
    const owner = '0123456789abcdef0123456789abcd03';
    const at = await machine(owner, 'ws-consent', holding('terminated'));
    const running = settling(account(owner).run('ws-consent', nextDeviceRequestId(), TURN, 'bun run build'));

    await at.asked('exec');
    expect(await account(owner).withdrawConsent('ws-consent', at.deviceId)).toEqual({ ok: true });
    expect(asked(at, DEVICE_CANCEL_METHOD)).toEqual([]);
    at.release();
    expect(answered(await running)).toMatchObject({ exitCode: 0 });

    const next = settling(account(owner).run('ws-consent', nextDeviceRequestId(), TURN, 'bun run deploy'));

    await account(owner).answerConsent('ws-consent', 'deny');
    expect(await next).toEqual({ ok: false, error: expect.stringContaining(DEVICE_CONSENT_DENIED) });
    expect(asked(at, 'exec')).toEqual(['bun run build']);
    at.close();
  });

  it('revoking the machine is the stop that withdrawing consent is not', async () => {
    const owner = '0123456789abcdef0123456789abcd04';
    const at = await machine(owner, 'ws-revoked', holding('terminated'));
    const request = nextDeviceRequestId();
    const running = settling(account(owner).run('ws-revoked', request, TURN, 'bun run build'));

    await at.asked('exec');
    // Revocation stops and confirms the running command, so no unstopped-command incident.
    expect(await account(owner).revoke(at.deviceId)).toEqual({ ok: true, unstoppedCommands: 0 });
    expect(asked(at, DEVICE_CANCEL_METHOD)).toEqual([request]);
    // The socket went with the machine: the caller is told so, not handed a result.
    expect(await running).toEqual({ ok: false, error: expect.stringContaining(TUNNEL_DISCONNECTED) });
    expect(await account(owner).requests()).toEqual([]);
    // The account closed the machine's socket, so a late completion has nowhere to land.
    await at.dropped;
  });
});
