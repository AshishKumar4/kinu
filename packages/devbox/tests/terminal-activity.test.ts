// The ready+activity bridge lives on `Devbox`, so every host inherits it: a terminal lane
// stamps the durable interaction only after the readiness gate admits the box.
import { describe, expect, setSystemTime, test, vi } from 'bun:test';

import * as v from 'valibot';

import { INCIDENT_PREFIX } from '../src/incidents';
import { DEFAULT_DEVBOX_POLICY, LAST_INTERACTION_KEY, QUIET_SINCE_KEY, type DevboxPolicy } from '../src/lifecycle';
import { Processes } from '../src/processes';
import type { StoredValue } from '../src/storage';
import { Devbox, harness, wakeWhileArmed } from './support/devbox-harness';

/** The shipped policy with a test-length probe: nothing here is about budgets. */
class TestBox extends Devbox<unknown> {
  protected override get policy(): DevboxPolicy {
    return { ...DEFAULT_DEVBOX_POLICY, portWaitMs: 4, portProbeIntervalMs: 1 };
  }

  protected override get ambientCheckpoints(): boolean {
    return false;
  }
}

describe('noteTerminalActivity refuses before it stamps', () => {
  test('a box the platform admitted nothing to stamps no interaction', async () => {
    const { box, container } = harness(TestBox);
    await container.stop();
    container.containerUnavailable = new Error(
      'there is no container instance that can be provided to this durable object',
    );

    // The value is the refusal that survives the RPC boundary; the throw is the strict gate's.
    // Both shapes must name unreadiness, not some other failure.
    expect(await box.resolveReadiness()).toEqual({
      kind: 'pending',
      reason: expect.stringContaining('not ready'),
    });
    await expect(box.noteTerminalActivity()).rejects.toThrow(/(not ready|no attached work directory)/);
    expect((await box.devboxState()).lastInteractionAt).toBeUndefined();
  });

  test('an admitted box stamps the interaction the heartbeat reads', async () => {
    const { box } = harness(TestBox);
    await box.devboxStartup();
    expect((await box.devboxState()).ready).toBe(true);
    // Startup is maintenance traffic and stamps nothing, so the stamp below comes only from
    // the inherited method.
    expect((await box.devboxState()).lastInteractionAt).toBeUndefined();

    await box.noteTerminalActivity();

    expect((await box.devboxState()).lastInteractionAt).toEqual(expect.any(Number));
  });
});

// D56, as the owner corrected it: a box rests on its own use only. Its workspace's turns never reach it, so a box
// whose workspace keeps working without touching it rests one idle window after its own last use.
describe("only the box's own use holds it", () => {
  test('a box last used a minute ago holds through its idle window and rests once the quiet is confirmed', async () => {
    const start = Date.now();
    const { box, rows } = harness(TestBox);

    try {
      await box.devboxStartup();
      rows.set(LAST_INTERACTION_KEY, start - 60_000);
      setSystemTime(start);
      await box.devboxHeartbeat();
      const holding = (await box.devboxState()).lastTick?.decision;

      setSystemTime(start - 60_000 + DEFAULT_DEVBOX_POLICY.idleMs);
      await box.devboxHeartbeat();
      setSystemTime(start - 60_000 + DEFAULT_DEVBOX_POLICY.idleMs + DEFAULT_DEVBOX_POLICY.quietConfirmMs);
      await box.devboxHeartbeat();
      const resting = (await box.devboxState()).lastTick?.decision;

      expect({ holding, resting }).toEqual({ holding: 'hold', resting: 'quiesce' });
    } finally {
      setSystemTime();
    }
  });

  // What its workspace reads when a job settles or a port moves, to record which job serves an exposed port.
  test('reading its exposed ports and the listeners on them is not use', async () => {
    const { box } = harness(TestBox);
    await box.devboxStartup();

    await box.getExposedPorts('previews.example');
    await box.portListeners('KINU_JOB_ID', [8001]);

    expect((await box.devboxState()).lastInteractionAt).toBeUndefined();
  });
});

// D59.
describe('a box with work still running asks before it rests', () => {
  const { idleMs, quietConfirmMs } = DEFAULT_DEVBOX_POLICY;

  function readyToRest(rows: Map<string, StoredValue>, start: number): void {
    rows.set(LAST_INTERACTION_KEY, start - idleMs - 60_000);
    rows.set(QUIET_SINCE_KEY, start - quietConfirmMs - 60_000);
  }

  function restAsks(rows: Map<string, StoredValue>): string[] {
    return [...rows.entries()]
      .filter(([key]) => key.startsWith(INCIDENT_PREFIX))
      .map(([, row]) => v.parse(v.object({ stage: v.string(), reason: v.string(), at: v.number() }), row))
      .filter((row) => row.stage === 'rest')
      .sort((a, b) => a.at - b.at)
      .map((row) => row.reason);
  }

  test('a command still running is listed in one ask, and the box holds until it is answered', async () => {
    const start = Date.now();
    const { box, container, rows } = harness(TestBox);

    try {
      await box.devboxStartup();
      await new Processes(container.handle()).start('npm test', { processId: 'cmd-npm-test' });
      readyToRest(rows, start);
      const decisions = [];

      for (let beat = 0; beat < 3; beat++) {
        setSystemTime(start + beat * 60_000);
        await box.devboxHeartbeat();
        decisions.push((await box.devboxState()).lastTick?.decision);
      }

      const asks = restAsks(rows);

      expect({ decisions, asks: asks.length, running: container.running.running }).toEqual({ decisions: ['ask', 'ask', 'ask'], asks: 1, running: true });
      expect(asks[0]).toContain('npm test');
    } finally {
      setSystemTime();
    }
  });

  test('a supervised server alone asks too, and the ask says it restarts cold on its next use', async () => {
    const start = Date.now();
    const { box, container, rows } = harness(TestBox);

    try {
      await box.devboxStartup();
      await box.startSupervised('python3 -m http.server 8000');
      setSystemTime(start + idleMs + 60_000);
      await box.devboxHeartbeat();
      setSystemTime(start + idleMs + quietConfirmMs + 120_000);
      await box.devboxHeartbeat();

      expect({ decision: (await box.devboxState()).lastTick?.decision, running: container.running.running }).toEqual({ decision: 'ask', running: true });
      expect(restAsks(rows)[0]).toContain('restarts cold');
    } finally {
      setSystemTime();
    }
  });

  test('a box with nothing running rests without asking', async () => {
    const start = Date.now();
    const { box, container, rows } = harness(TestBox);

    try {
      await box.devboxStartup();
      await new Processes(container.handle()).start('npm test', { processId: 'cmd-npm-test' });
      container.processes.set('cmd-npm-test', { id: 'cmd-npm-test', pid: 4242, status: 'completed', command: 'npm test' });
      readyToRest(rows, start);
      setSystemTime(start);
      await box.devboxHeartbeat();

      expect({ decision: (await box.devboxState()).lastTick?.decision, asks: restAsks(rows).length, running: container.running.running })
        .toEqual({ decision: 'quiesce', asks: 0, running: false });
    } finally {
      setSystemTime();
    }
  });

  test('a process list that never reads asks, and the box never rests without an answer', async () => {
    const start = Date.now();
    const { box, container, rows } = harness(TestBox);
    await box.devboxStartup();
    container.fileFaults.set('/var/tmp/devbox/processes', { errno: 13, message: 'the process directory cannot be read' });

    try {
      rows.set(LAST_INTERACTION_KEY, start - idleMs - 60_000);
      const decisions = [];

      for (let beat = 1; beat <= 40; beat++) {
        setSystemTime(start + quietConfirmMs + beat * 60_000);
        await box.devboxHeartbeat();
        decisions.push((await box.devboxState()).lastTick?.decision);
      }

      const asks = restAsks(rows);

      expect({ rested: decisions.includes('quiesce'), running: container.running.running, asked: asks.length >= 1 })
        .toEqual({ rested: false, running: true, asked: true });
      expect(asks[0]).toContain('could not be read');
    } finally {
      container.fileFaults.clear();
      setSystemTime();
    }
  });

  test("'keep' clears the ask and the box asks again one idle window later; 'now' saves and stops it", async () => {
    const start = Date.now();
    const { box, container, rows } = harness(TestBox);

    try {
      await box.devboxStartup();
      await new Processes(container.handle()).start('npm test', { processId: 'cmd-npm-test' });
      readyToRest(rows, start);
      setSystemTime(start);
      await box.devboxHeartbeat();
      const kept = await box.answerRest('keep');
      setSystemTime(start + 60_000);
      await box.devboxHeartbeat();
      const heldAfterKeep = (await box.devboxState()).lastTick?.decision;
      setSystemTime(start + idleMs + 60_000);
      await box.devboxHeartbeat();
      setSystemTime(start + idleMs + quietConfirmMs + 120_000);
      await box.devboxHeartbeat();
      const askedAgain = restAsks(rows).length;
      const now = await box.answerRest('now');

      expect({ kept: kept.kind, heldAfterKeep, askedAgain, now: now.kind, running: container.running.running })
        .toEqual({ kept: 'kept', heldAfterKeep: 'hold', askedAgain: 2, now: 'resting', running: false });
    } finally {
      setSystemTime();
    }
  });

  test('an answer with no ask pending is refused, so it cannot stop a box in use', async () => {
    const { box, container } = harness(TestBox);
    await box.devboxStartup();

    expect({ answer: (await box.answerRest('now')).kind, running: container.running.running }).toEqual({ answer: 'refused', running: true });
  });

  test('an unreadable supervised-spec store is an unknown too: the beat asks, it does not throw', async () => {
    const { box, rows, storage } = harness(TestBox);
    await box.devboxStartup();
    readyToRest(rows, Date.now());
    storage.failListOn('devbox:proc:', new Error('storage read failed'));

    await box.devboxHeartbeat();
    storage.failListOn('devbox:proc:', undefined);

    expect((await box.devboxState()).lastTick?.decision).toBe('ask');
  });
});

// Staging, 2026-09-28: a box whose own startup got a container after its caller had gone was never
// used, so its idle clock read "now" on every beat and it never rested.
describe('a box no caller used rests from its start', () => {
  test('a box its own startup started rests after the idle window and quiet confirmation', async () => {
    let now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);

    try {
      const { box, container } = harness(TestBox);
      await box.devboxStartup();

      // The shipped policy rests an idle box after about forty beats.
      await wakeWhileArmed(container, (to) => { now = Math.max(now, to); }, 120);

      expect({ running: container.running.running, alarm: container.alarmAt }).toEqual({ running: false, alarm: null });
    } finally {
      clock.mockRestore();
    }
  });
});

describe('every admitted operation is an interaction', () => {
  test('a file write on an admitted box stamps the lease the heartbeat reads', async () => {
    const { box } = harness(TestBox);
    await box.devboxStartup();
    expect((await box.devboxState()).lastInteractionAt).toBeUndefined();

    await box.writeFile('/workspace/witness.txt', 'bytes a caller put there');

    expect((await box.devboxState()).lastInteractionAt).toEqual(expect.any(Number));
  });
});

/** Workers' socket pair, which Bun lacks: each end delivers its sends and its close to the other. */
class FakeSocket extends EventTarget {
  peer: FakeSocket | undefined;
  closed = false;
  readonly heard: string[] = [];
  heardClose: { readonly code: number; readonly reason: string } | undefined;

  accept(): void {}

  send(data: string): void {
    if (this.closed) throw new TypeError('send after close');
    this.peer?.heard.push(data);
    this.peer?.dispatchEvent(new MessageEvent('message', { data }));
  }

  close(code: number, reason: string): void {
    if (this.closed) return;
    this.closed = true;

    if (this.peer === undefined) return;
    this.peer.heardClose = { code, reason };
    this.peer.dispatchEvent(new CloseEvent('close', { code, reason }));
  }
}

function socketPair(): [FakeSocket, FakeSocket] {
  const ends: [FakeSocket, FakeSocket] = [new FakeSocket(), new FakeSocket()];
  ends[0].peer = ends[1];
  ends[1].peer = ends[0];

  return ends;
}

class PreviewBox extends TestBox {
  protected override get previewHost(): string | undefined {
    return 'preview.test';
  }
}

// SDK audit (b), 2026-10-01: a preview's WebSocket is the box's use for as long as it is open.
describe('an open preview socket is the box\'s use', () => {
  test('a box holds while a preview socket is open, relays both ways, and rests one idle window after it closes', async () => {
    const pairs: [FakeSocket, FakeSocket][] = [];
    const app = socketPair();

    const opened = (): [FakeSocket, FakeSocket] => {
      const ends = socketPair();
      pairs.push(ends);

      return ends;
    };

    Object.assign(globalThis, { WebSocketPair: function WebSocketPair() { return opened(); } });
    const start = Date.now();
    const { box, rows, container } = harness(PreviewBox);
    rows.set('devbox:port:5173', { port: 5173, name: 'web', token: 'tok5173', createdAt: 1 });
    container.listening.add(5173);
    container.portAnswer = (_port, request) => (request.headers.get('upgrade') === 'websocket'
      ? Object.assign(new Response(null, { status: 101 }), { webSocket: app[0] })
      : new Response('', { status: 200 }));

    const { idleMs, quietConfirmMs } = DEFAULT_DEVBOX_POLICY;

    const beat = async (at: number): Promise<string | undefined> => {
      setSystemTime(at);
      await box.devboxHeartbeat();

      return (await box.devboxState()).lastTick?.decision;
    };

    try {
      setSystemTime(start);
      await box.devboxStartup();
      await box.fetch(new Request('https://box/_devbox/preview/5173/tok5173/hmr', { headers: { upgrade: 'websocket' } }));
      const visitor = pairs[0]?.[0];
      visitor?.send('from the visitor');
      app[1].send('from the app');

      await beat(start + idleMs);
      const open = await beat(start + idleMs + quietConfirmMs);
      const closedAt = start + idleMs + quietConfirmMs + 60_000;

      setSystemTime(closedAt);
      visitor?.close(1001, 'tab closed');
      const closing = await beat(closedAt + idleMs - 60_000);

      await beat(closedAt + idleMs);
      const closed = await beat(closedAt + idleMs + quietConfirmMs);

      expect({ bridged: pairs.length, app: app[1].heard, visitor: visitor?.heard, appClosed: app[1].heardClose, open, closing, closed }).toEqual({
        bridged: 1, app: ['from the visitor'], visitor: ['from the app'], appClosed: { code: 1001, reason: 'tab closed' },
        open: 'hold', closing: 'hold', closed: 'quiesce',
      });
    } finally {
      setSystemTime();
      Reflect.deleteProperty(globalThis, 'WebSocketPair');
    }
  });
});
