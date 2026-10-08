// Lifecycle contracts not already exercised by the box flows, and incident delivery effects.
import { describe, expect, test } from 'bun:test';

import { startOverrun } from '../src/errors';
import {
  describeThrown,
  healthProbeCommand,
  healthProbeSilent,
  classifyRecovery,
  openStartBudget,
  racedRestoreSteps,
  runRestoreStep,
  parseRecoveryRow,
  recoveryStep,
  restartPlan,
  type DevboxIncident,
  type IncidentDisposition,
  type PortExposureSpec,
  type RecoveryClass,
  type RecoveryStage,
  type SupervisedProcessSpec,
} from '../src/lifecycle';

describe('restart plan — processes serve ports, so processes go first', () => {
  const procs: readonly SupervisedProcessSpec[] = [
    { processId: 'p2', command: 'node b.js', cwd: '/workspace/app', createdAt: 2 },
    { processId: 'p1', command: 'python3 a.py', cwd: undefined, createdAt: 1 },
  ];

  const ports: readonly PortExposureSpec[] = [
    { port: 8080, name: 'web', token: 'tok8080', createdAt: 3 },
    { port: 3000, name: undefined, token: 'tok3000', createdAt: 4 },
  ];

  test('the registered process order is preserved', () => {
    const plan = restartPlan(procs, ports);

    expect(plan.start.map(spec => spec.processId)).toEqual(['p2', 'p1']);
  });

  test('ports are served in ascending order, so a restart is the same restart twice', () => {
    expect(restartPlan(procs, ports).serve.map(spec => spec.port)).toEqual([3000, 8080]);
  });

  test('two specs for one port collapse to one exposure', () => {
    const duplicated: readonly PortExposureSpec[] = [
      { port: 8080, name: 'first', token: 'a', createdAt: 1 },
      { port: 8080, name: 'second', token: 'b', createdAt: 2 },
    ];

    // Last write wins, which matches the storage the specs came from.
    expect(restartPlan([], duplicated).serve).toEqual([duplicated[1]]);
  });
});

/** Mirrors `@cloudflare/sandbox`: `code` is a getter, not an own property, and no error class is
 *  exported; a plain-field stand-in would pass a check the shipped SDK fails. */
class Coded extends Error {
  constructor(readonly errorResponse: { readonly code: string; readonly message: string }) {
    super(errorResponse.message);
    this.name = 'SandboxError';
  }

  get code(): string {
    return this.errorResponse.code;
  }
}

const coded = (code: string, message = 'the container said so'): Coded =>
  new Coded({ code, message });

describe('classifying a lifecycle failure — the SDK\'s own codes, never its prose', () => {
  const table: readonly [string, RecoveryClass][] = [
    ['ENOSPC', 'exhausted'],
    ['EACCES', 'permanent'],
    ['FILE_TOO_LARGE', 'exhausted'],
    ['TOO_MANY_FILES', 'exhausted'],
    ['COMMAND_NOT_FOUND', 'permanent'],
    ['PERMISSION_DENIED', 'permanent'],
    ['READ_ONLY', 'permanent'],
    ['SESSION_TERMINATED', 'stale-owner'],
  ];

  for (const [code, expected] of table) {
    test(`${code} is ${expected}`, () => {
      expect(classifyRecovery({ cause: coded(code) })).toBe(expected);
    });
  }

  test('THE CAUSE CHAIN is classified, because this package wraps its failures', () => {
    // The snapshot chain rethrows a mount failure with the SDK's error as `cause`;
    // reading only the outermost value would answer `unclassified` for every wrapped failure.
    const wrapped = new Error('chain abc is stored as lazy layers and could not be mounted', {
      cause: coded('MISSING_CREDENTIALS'),
    });

    expect(classifyRecovery({ cause: wrapped })).toBe('permanent');
  });

  test('an outer classified failure wins over an inner one', () => {
    const wrapped = new Error('abandoned', {
      cause: startOverrun('Devbox.attach', 1),
    });

    expect(classifyRecovery({ cause: wrapped })).toBe('abandoned');
  });

  test('a message that merely MENTIONS a classified condition is not classified', () => {
    // Codes are the authority: a message saying "no space left in the plan" is not NO_SPACE,
    // and regex classification would refuse a box over a sentence.
    expect(classifyRecovery({ cause: new Error('no space left in the plan; connection reset') }))
      .toBe('unclassified');
  });

  test('a code the table does not name is unclassified, not guessed', () => {
    expect(classifyRecovery({ cause: coded('UNKNOWN_ERROR') })).toBe('unclassified');
    expect(classifyRecovery({ cause: coded('S3FS_MOUNT_ERROR') })).toBe('unclassified');
  });

  test('a thrown value that is not an error at all is unclassified', () => {
    expect(classifyRecovery({ cause: 'a string' })).toBe('unclassified');
    expect(classifyRecovery({ cause: undefined })).toBe('unclassified');
    expect(classifyRecovery({ cause: { code: 42 } })).toBe('unclassified');
  });
});

describe('the ladder row is parsed strictly, and an unreadable one is not an absent one', () => {
  const OWNER = 'a1b2c3d4-0000-4000-8000-00000000abcd';

  test('anything else is malformed rather than absent', () => {
    // Absent means "nothing has failed" and restarts the ladder; reading an unreadable row as
    // absent could destroy the container identity repeatedly.
    const rejected = [
      null, 'retry', 3, {}, [],
      // No owner: a row nothing can be conditioned on.
      { stage: 'retry' },
      { owner: OWNER, stage: 'refuse' }, { owner: OWNER, stage: 1 }, { owner: 7 },
      // An unknown key: this row has exactly one builder, so a second shape is
      // evidence of something else writing here.
      { owner: OWNER, stage: 'retry', attempts: 4 },
    ];

    for (const stored of rejected) expect(parseRecoveryRow(stored)).toEqual({ kind: 'malformed' });
  });
});

describe('recovery is one decision per failure, with no count and no timeout', () => {
  const CLASSES: readonly RecoveryClass[] = [
    'abandoned', 'stale-owner', 'exhausted', 'permanent', 'transient', 'unclassified',
  ];

  test('a failure at REPLACE is terminal AND KEEPS the stage, so nothing loops', () => {
    // Terminal stops a second destruction now; keeping the stage stops the next eviction
    // from restarting the destructive ladder. Only a successful attach clears it.
    for (const failure of CLASSES) {
      expect(recoveryStep({ owned: true, failure, stage: 'replace' }))
        .toEqual({ action: failure === 'stale-owner' ? 'retry' : 'refuse', stage: 'replace' });
    }
  });

  for (const failure of ['transient', 'unclassified'] as const) {
    test(`${failure} walks the ladder once: retry, replace, then refuse for ever`, () => {
      // The bound is the ladder's length, not a tuned retry count: each stage is a different
      // action, so nothing harmful repeats. The walk does not wrap.
      const walk: string[] = [];
      let stage: RecoveryStage | undefined;

      for (let step = 0; step < 4; step += 1) {
        const decision = recoveryStep({ owned: true, failure, stage });
        walk.push(decision.action);
        stage = decision.stage;
      }

      expect(walk).toEqual(['retry', 'replace', 'refuse', 'refuse']);
    });
  }

});

describe('port tokens and listener probes', () => {
  test('the probe reads curl verdicts, and treats an unparsable answer as silence', () => {
    // A response of any kind, even an error status, proves a listener exists;
    // whether it is healthy is a separate question.
    expect(healthProbeSilent('404|0')).toBe(false);
    expect(healthProbeSilent('503|0')).toBe(false);
    expect(healthProbeSilent('200|0')).toBe(false);
    // curl exit 7 is connection refused: nothing is listening.
    expect(healthProbeSilent('000|7')).toBe(true);
    // Anything unparsable cannot be evidence of a listener. Exposing a port on
    // that guess hands back a URL that answers 502.
    expect(healthProbeSilent('')).toBe(true);
    expect(healthProbeSilent('curl: (6) could not resolve host')).toBe(true);
    expect(healthProbeSilent('0|0')).toBe(true);
  });

  test('the command proves an answering listener, refuses a closed one, and ends on a silent listener', async () => {
    const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch: (request) => new URL(request.url).pathname === '/'
      ? new Response(null, { status: 503 }) : Promise.withResolvers<Response>().promise });

    const probe = async (command: string) => {
      const child = Bun.spawn(['bash', '-c', command], { stdout: 'pipe', stderr: 'pipe' });
      const stdout = await new Response(child.stdout).text();
      await new Response(child.stderr).text();
      expect(await child.exited).toBe(0);

      return stdout;
    };

    const port = server.port ?? 0;

    try {
      expect(healthProbeSilent(await probe(healthProbeCommand(port)))).toBe(false);
      expect(await probe(healthProbeCommand(port).replace('/ 2>&1', '/silent 2>&1'))).toContain('000|28');
    } finally { await server.stop(true); }

    expect(healthProbeSilent(await probe(healthProbeCommand(port)))).toBe(true);
  });
});

describe('an incident is written off only when the host says it LANDED', () => {
  interface Ledger {
    readonly rows: Map<string, IncidentRow>;
    readonly store: IncidentStore;
  }

  function ledger(): Ledger {
    const rows = new Map<string, IncidentRow>();

    return {
      rows,
      store: {
        get: (key) => Promise.resolve(rows.get(key)),
        put: (key, value) => {
          rows.set(key, value);

          return Promise.resolve();
        },
        delete: (key) => Promise.resolve(rows.delete(key)),
        list: (options) => Promise.resolve(
          new Map([...rows].filter(([key]) => key.startsWith(options.prefix))),
        ),
      },
    };
  }

  const only = (rows: Map<string, IncidentRow>): IncidentRow | undefined =>
    [...rows.values()][0];

  test('an UNDELIVERED answer leaves the row pending, and the next pass lands it', async () => {
    const { rows, store } = ledger();
    await recordIncident(store, 'attach', 'the mount refused');
    const answers: IncidentDisposition[] = ['undelivered', 'queued'];
    const ordinals: number[] = [];

    const answer = async (_incident: DevboxIncident, attempt: number): Promise<IncidentDisposition> => {
      ordinals.push(attempt);

      return answers.shift() ?? 'queued';
    };

    const retryIn = await deliverIncidents(store, answer);

    expect(retryIn).toBe(10);
    const pending = only(rows);
    expect({
      attempts: pending?.attempts,
      delivered: pending?.deliveredAt,
      rejected: pending?.rejectedAt,
    }).toEqual({ attempts: 1, delivered: undefined, rejected: undefined });

    const settled = await deliverIncidents(store, answer);

    expect(settled).toBeNull();
    expect(only(rows)?.deliveredAt).toBeNumber();
    expect(ordinals).toEqual([1, 2]);
  });

  test('a THROWN handler is the same case, not a special one', async () => {
    const { rows, store } = ledger();
    await recordIncident(store, 'checkpoint', 'the commit failed');

    const retryIn = await deliverIncidents(store, () => {
      throw new Error('the host was unreachable');
    });

    expect(retryIn).toBe(10);
    expect({ attempts: only(rows)?.attempts, delivered: only(rows)?.deliveredAt })
      .toEqual({ attempts: 1, delivered: undefined });
  });

  test('a REJECTED shape is recorded and never retried', async () => {
    // A shape the host refuses is a defect in this package, not a transient, so
    // repeating it could only produce the same refusal.
    const { rows, store } = ledger();
    await recordIncident(store, 'port', 'nothing listens');
    const retryIn = await deliverIncidents(store, () => Promise.resolve('rejected'));
    expect(retryIn).toBeNull();
    expect(only(rows)?.rejectedAt).toBeNumber();
    expect(only(rows)?.deliveredAt).toBeUndefined();
  });

  test('an undelivered incident backs off to five minutes and remains pending', async () => {
    const { rows, store } = ledger();
    await recordIncident(store, 'checkpoint', 'the commit failed');

    for (const delay of [10, 20, 40, 80, 160, 300, 300]) {
      expect(await deliverIncidents(store, () => Promise.resolve('undelivered'))).toBe(delay);
      expect(only(rows)?.deliveredAt).toBeUndefined();
      expect(only(rows)?.rejectedAt).toBeUndefined();
    }

    expect(only(rows)?.attempts).toBe(7);
  });
});

describe('the attach budget', () => {
  const attachWithin = <T>(
    budgetMs: number, work: () => Promise<T>, onOverrun: (failure: { readonly cause: unknown }) => void,
  ): Promise<T> => racedRestoreSteps(openStartBudget(budgetMs)).attach(work, onOverrun);

  test('work that overruns is abandoned, and its late failure is still reported', async () => {
    const late: string[] = [];
    const { promise: work, reject: failWork } = Promise.withResolvers<never>();

    const run = attachWithin(0, () => work, failure => {
      late.push(describeThrown({ cause: failure.cause }));
    });

    await expect(run).rejects.toMatchObject({ code: 'start-overrun' });
    // Abandoning a value is not the same as discarding an error: the late
    // rejection is usually the only diagnostic there is.
    failWork(new Error('the mount never came back'));
    await Promise.resolve();
    await Promise.resolve();
    expect(late).toEqual(['the mount never came back']);
  });

  test('a failure inside the budget propagates rather than becoming an overrun', async () => {
    const late: string[] = [];
    await expect(attachWithin(
      25_000, () => Promise.reject(new Error('bad layer')),
      failure => { late.push(describeThrown({ cause: failure.cause })); },
    )).rejects.toThrow('bad layer');
    expect(late).toEqual([]);
  });

  test('a step that outruns its allowance REPORTS, and its late failure is still told', async () => {
    // Post-attach policy: a silent listener or a process that will not start must not read as
    // an abandoned attach; the container is healthy and replacing it destroys a good box.
    const late: string[] = [];
    const { promise: work, reject: failWork } = Promise.withResolvers<never>();

    const outcome = await runRestoreStep(0, () => work, (failure) => {
      late.push(describeThrown({ cause: failure.cause }));
    });

    expect(outcome).toEqual({ kind: 'late' });
    failWork(new Error('the server never bound'));
    await Promise.resolve();
    await Promise.resolve();
    expect(late).toEqual(['the server never bound']);
  });

});

describe('thrown values', () => {
  test('a cause chain is rendered, and a non-Error is not assumed to have a message', () => {
    const described = describeThrown({ cause: new Error('outer', { cause: new Error('inner') }) });

    expect(described).toContain('outer');
    expect(described).toContain('inner');
    expect(describeThrown({ cause: 'plain string' })).toBe('plain string');
    expect(describeThrown({ cause: undefined })).toBe('undefined');
  });
});

import { createCheckpointLane } from '../src/operation-lanes';
import {
  deliverIncidents,
  reapDeliveredIncidents,
  recordIncident,
  type IncidentRow,
  type IncidentStore,
} from '../src/incidents';
import type { CheckpointOutcome } from '../src/storage';

describe('the checkpoint lane — one checkpoint at a time', () => {
  const ok = (): Promise<CheckpointOutcome> => Promise.resolve({
    kind: 'committed', reason: undefined, bytes: 1, movedBytes: 1,
  });

  test('concurrent callers of the SAME kind JOIN one operation', async () => {
    const lane = createCheckpointLane();
    let calls = 0;
    const release = Promise.withResolvers<void>();

    const op = async (): Promise<CheckpointOutcome> => {
      calls += 1;
      await release.promise;

      return Promise.resolve(ok());
    };

    const first = lane.run('tick', op);
    expect(lane.busy()).toBe(true);
    expect(Bun.peek.status(first)).toBe('pending');
    const second = lane.run('tick', op);
    release.resolve();
    const [a, b] = await Promise.all([first, second]);
    expect(calls).toBe(1);
    expect(a).toBe(b); // the same run, not two interleaved ones
  });

  test('reports busy from admission until a checkpoint settles', async () => {
    const lane = createCheckpointLane();
    const parked = Promise.withResolvers<void>();

    const running = lane.run('tick', async () => {
      await parked.promise;

      return await ok();
    });

    expect(lane.busy()).toBe(true);
    parked.resolve();
    await running;
    await Promise.resolve();
    expect(lane.busy()).toBe(false);
  });

  test('a different kind QUEUES behind the running one; nothing interleaves', async () => {
    const lane = createCheckpointLane();
    const events: string[] = [];
    const release = Promise.withResolvers<void>();

    const slowTick = async (): Promise<CheckpointOutcome> => {
      events.push('tick:start');
      await release.promise;
      events.push('tick:end');

      return Promise.resolve(ok());
    };

    const quiesce = async (): Promise<CheckpointOutcome> => {
      events.push('quiesce:start');
      events.push('quiesce:end');

      return Promise.resolve(ok());
    };

    const first = lane.run('tick', slowTick);
    expect(lane.busy()).toBe(true);
    expect(Bun.peek.status(first)).toBe('pending');
    const second = lane.run('quiesce', quiesce);
    release.resolve();
    await Promise.all([first, second]);
    // A quiesce joining an in-flight tick could inherit `skipped` and stop over just-landed work;
    // it waits and runs its own final commit.
    expect(events).toEqual([
      'tick:start', 'tick:end', 'quiesce:start', 'quiesce:end',
    ]);
  });

  test('a rejected run rejects its joiners and leaves the gate usable', async () => {
    const lane = createCheckpointLane();

    const failing = (): Promise<CheckpointOutcome> =>
      Promise.reject(new Error('store unreachable'));

    const joiner = lane.run('tick', failing);
    await expect(lane.run('tick', failing)).rejects.toThrow('store unreachable');
    await expect(joiner).rejects.toThrow('store unreachable');
    await expect(lane.run('tick', ok)).resolves.toHaveProperty('kind', 'committed');
  });
});

function fakeIncidentStore() {
  const rows = new Map<string, IncidentRow>();

  const store: IncidentStore = {
    get: (key) => Promise.resolve(rows.get(key)),
    put: (key, value) => {
      rows.set(key, value);

      return Promise.resolve();
    },
    delete: (key) => Promise.resolve(rows.delete(key)),
    list: (options) => Promise.resolve(
      new Map([...rows].filter(([key]) => key.startsWith(options.prefix))
        .sort(([a], [b]) => (a < b ? -1 : 1))),
    ),
  };

  return { store, rows };
}

function seedIncident(store: ReturnType<typeof fakeIncidentStore>, id: string): IncidentRow {
  const row: IncidentRow = {
    incidentId: id, stage: 'checkpoint', reason: 'r',
    processId: undefined, port: undefined, at: 0, attempts: 0,
  };

  store.rows.set(`devbox:incident:${id}`, row);

  return row;
}

describe('incident ledger retention — delivered rows are bounded, pending never dropped', () => {
  test('reaping keeps the newest settled rows within the cap and every pending row', async () => {
    const box = fakeIncidentStore();

    for (let at = 0; at < 150; at += 1) {
      const row = seedIncident(box, `d${String(at).padStart(4, '0')}`);
      box.rows.set(`devbox:incident:${row.incidentId}`, { ...row, deliveredAt: at });
    }

    for (let p = 0; p < 5; p += 1) seedIncident(box, `pending${p}`);

    const deleted = await reapDeliveredIncidents(box.store);

    expect(deleted).toBe(55);
    expect(box.rows.size).toBe(100);
    expect(box.rows.has('devbox:incident:d0000')).toBe(false);
    expect(box.rows.has('devbox:incident:d0054')).toBe(false);
    expect(box.rows.has(`devbox:incident:d${String(55).padStart(4, '0')}`)).toBe(true);

    for (let p = 0; p < 5; p += 1) {
      expect(box.rows.has(`devbox:incident:pending${p}`)).toBe(true);
    }
  });
});

