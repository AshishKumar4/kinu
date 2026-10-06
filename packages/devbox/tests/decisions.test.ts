// Pure lifecycle decisions, pinned apart from the platform a unit test cannot drive.
// Tests assert outcomes, not reachability: a silent no-op durability path must fail here.
import { describe, expect, test } from 'bun:test';

// Import from the defining modules, not the barrel: it pulls in `cloudflare:workers` via
// Sandbox, absent outside a Worker. Platform-free reachability is the property tested.
import { startOverrun } from '../src/errors';
import {
  DEFAULT_DEVBOX_POLICY,
  describeThrown,
  generatePortToken,
  healthProbeCommand,
  healthProbeSilent,
  incidentRetryDelayMs,
  admissionStep,
  classifyRecovery,
  openStartBudget,
  racedRestoreSteps,
  runRestoreStep,
  parseRecoveryRow,
  quiesceStep,
  recoveryStep,
  restartPlan,
  type DevboxIncident,
  type IncidentDisposition,
  type PortExposureSpec,
  type RecoveryClass,
  type RecoveryStage,
  type SupervisedProcessSpec,
} from '../src/lifecycle';
import { requireShellAccepts } from "./support/container-shell";

describe('quiesce timing matrix — three gates and a confirmed quiet window', () => {
  const T = 1_000_000_000;

  const base = {
    now: T,
    containerRunning: true,
    backgroundWork: false,
    lastInteractionAt: T - DEFAULT_DEVBOX_POLICY.idleMs,
    quietSince: undefined,
    idleMs: DEFAULT_DEVBOX_POLICY.idleMs,
    quietConfirmMs: DEFAULT_DEVBOX_POLICY.quietConfirmMs,
  } as const;

  test('a fresh interaction holds and remembers no quiet', () => {
    expect(quiesceStep({ ...base, lastInteractionAt: T - 60_000 }))
      .toEqual({ action: 'hold', quietSince: undefined });
  });

  test('going idle opens the quiet window but does not stop on the first observation', () => {
    const step = quiesceStep(base);
    expect(step.action).toBe('hold');
    expect(step.quietSince).toBe(T);
  });

  test('quiet confirmed across the window quiesces', () => {
    expect(quiesceStep({ ...base, quietSince: T - DEFAULT_DEVBOX_POLICY.quietConfirmMs }).action)
      .toBe('quiesce');
  });

  test('one millisecond short of either boundary holds', () => {
    expect(quiesceStep({ ...base, lastInteractionAt: T - DEFAULT_DEVBOX_POLICY.idleMs + 1 }).action)
      .toBe('hold');
    expect(quiesceStep({
      ...base, quietSince: T - DEFAULT_DEVBOX_POLICY.quietConfirmMs + 1,
    }).action).toBe('hold');
  });

  test('background work holds however long the silence has lasted', () => {
    const step = quiesceStep({
      ...base,
      backgroundWork: true,
      quietSince: T - DEFAULT_DEVBOX_POLICY.quietConfirmMs * 10,
    });

    expect(step.action).toBe('hold');
    // Background work forgets the quiet stretch so confirmation restarts after it; a remembered
    // stretch would stop the box on the first tick after a long job.
    expect(step.quietSince).toBeUndefined();
  });

  test('a new interaction resets the observed quiet window', () => {
    expect(quiesceStep({
      ...base,
      lastInteractionAt: T - 1_000,
      quietSince: T - DEFAULT_DEVBOX_POLICY.quietConfirmMs,
    })).toEqual({ action: 'hold', quietSince: undefined });
  });

  test('a stopped container neither acts nor remembers quiet', () => {
    expect(quiesceStep({ ...base, containerRunning: false, quietSince: T - 9_999 }))
      .toEqual({ action: 'hold', quietSince: undefined });
  });

  test('a quiet stretch older than the last interaction ended with it, however long ago it began', () => {
    const step = quiesceStep({
      ...base,
      lastInteractionAt: T - DEFAULT_DEVBOX_POLICY.idleMs - 13_000,
      quietSince: T - DEFAULT_DEVBOX_POLICY.idleMs - 13_000 - 24_000,
    });

    expect(step).toEqual({ action: 'hold', quietSince: T });
  });

  test('a quiet stretch that began after the last interaction still confirms', () => {
    expect(quiesceStep({
      ...base,
      lastInteractionAt: T - DEFAULT_DEVBOX_POLICY.idleMs - DEFAULT_DEVBOX_POLICY.quietConfirmMs,
      quietSince: T - DEFAULT_DEVBOX_POLICY.quietConfirmMs,
    }).action).toBe('quiesce');
  });

  test('the heartbeat samples often enough for both windows to be observable', () => {
    const beat = DEFAULT_DEVBOX_POLICY.heartbeatSeconds * 1_000;
    // Each window has to span several heartbeats or "confirmed across
    // heartbeats" is one sample wearing a plural.
    expect(DEFAULT_DEVBOX_POLICY.idleMs).toBeGreaterThan(beat * 5);
    expect(DEFAULT_DEVBOX_POLICY.quietConfirmMs).toBeGreaterThan(beat * 2);
  });

  test('the attach budget is bounded, and short enough to be a bound', () => {
    // The attach runs in a scheduled callback, so this budget is ours and can actually fire.
    // It stays under the blockConcurrencyWhile cancel window; a longer budget fixes nothing.
    expect(DEFAULT_DEVBOX_POLICY.attachBudgetMs).toBeGreaterThan(20_000);
    expect(DEFAULT_DEVBOX_POLICY.attachBudgetMs).toBeLessThan(30_000);
  });

  test('the retry cadence is the heartbeat, so a refused box is retried but not spun', () => {
    // A failed attach re-arms the startup schedule at this cadence and refuses operations
    // in between, rather than re-attaching and recording an incident on every call.
    expect(DEFAULT_DEVBOX_POLICY.heartbeatSeconds).toBeGreaterThan(10);
    expect(DEFAULT_DEVBOX_POLICY.heartbeatSeconds).toBeLessThanOrEqual(120);
  });
});

describe('restart plan — processes serve ports, so processes go first', () => {
  const procs: readonly SupervisedProcessSpec[] = [
    { processId: 'p2', command: 'node b.js', cwd: '/workspace/app', createdAt: 2 },
    { processId: 'p1', command: 'python3 a.py', cwd: undefined, createdAt: 1 },
  ];

  const ports: readonly PortExposureSpec[] = [
    { port: 8080, name: 'web', token: 'tok8080', createdAt: 3 },
    { port: 3000, name: undefined, token: 'tok3000', createdAt: 4 },
  ];

  test('the plan is two phases, so no exposure can be reached before the starts', () => {
    // The plan's shape is the guard: with no expose op, no executor can expose a port
    // whose listener was never probed.
    const plan = restartPlan(procs, ports);
    expect(Object.keys(plan).sort()).toEqual(['serve', 'start']);
    expect(plan.start.map(spec => spec.processId)).toEqual(['p2', 'p1']);
  });

  test('ports are served in ascending order, so a restart is the same restart twice', () => {
    expect(restartPlan(procs, ports).serve.map(spec => spec.port)).toEqual([3000, 8080]);
  });

  test('a port is re-exposed with its PERSISTED token, so its URL is unchanged', () => {
    expect(restartPlan([], ports).serve.map(spec => spec.token)).toEqual(['tok3000', 'tok8080']);
  });

  test('nothing registered means an empty plan, not a plan of no-ops', () => {
    expect(restartPlan([], [])).toEqual({ start: [], serve: [] });
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
    ['NO_SPACE', 'exhausted'],
    ['FILE_TOO_LARGE', 'exhausted'],
    ['TOO_MANY_FILES', 'exhausted'],
    ['MISSING_CREDENTIALS', 'permanent'],
    ['INVALID_MOUNT_CONFIG', 'permanent'],
    ['COMMAND_NOT_FOUND', 'permanent'],
    ['PERMISSION_DENIED', 'permanent'],
    ['READ_ONLY', 'permanent'],
    ['OPERATION_INTERRUPTED', 'stale-owner'],
    ['SESSION_TERMINATED', 'stale-owner'],
    ['RPC_TRANSPORT_ERROR', 'transient'],
    ['CONTAINER_UNAVAILABLE', 'transient'],
  ];

  for (const [code, expected] of table) {
    test(`${code} is ${expected}`, () => {
      expect(classifyRecovery({ cause: coded(code) })).toBe(expected);
    });
  }

  test('an overrun is its own class, read from the type and not from the sentence', () => {
    expect(classifyRecovery({ cause: startOverrun('Devbox.attach', 25_000) }))
      .toBe('abandoned');
  });

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

  test('no row means no attempt has failed', () => {
    expect(parseRecoveryRow(undefined)).toEqual({ kind: 'absent' });
  });

  test('a claim with no stage round-trips, and so does each stage', () => {
    expect(parseRecoveryRow({ owner: OWNER })).toEqual({ kind: 'row', row: { owner: OWNER } });

    for (const stage of ['retry', 'replace'] as const) {
      expect(parseRecoveryRow({ owner: OWNER, stage }))
        .toEqual({ kind: 'row', row: { owner: OWNER, stage } });
    }
  });

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

describe('admission claims the row, and refuses on evidence it cannot read', () => {
  const OWNER = 'a1b2c3d4-0000-4000-8000-00000000abcd';

  test('an absent row admits an attempt with no stage to preserve', () => {
    expect(admissionStep({ kind: 'absent' })).toEqual({ admit: true, stage: undefined });
  });

  test('a readable row admits the attempt and hands it the stage to preserve', () => {
    // A container start, an eviction and a replacement each mint a new owner; none may
    // reset how far the recovery ladder has gone.
    expect(admissionStep({ kind: 'row', row: { owner: OWNER } }))
      .toEqual({ admit: true, stage: undefined });

    for (const stage of ['retry', 'replace'] as const) {
      expect(admissionStep({ kind: 'row', row: { owner: OWNER, stage } }))
        .toEqual({ admit: true, stage });
    }
  });

  test('an unreadable row refuses the attempt and normalises to the terminal stage', () => {
    // Refusing destroys nothing on unreadable evidence; normalising matters because a row left
    // unreadable would refuse for ever and brick the devbox.
    expect(admissionStep({ kind: 'malformed' })).toEqual({ admit: false, stage: 'replace' });
  });
});

describe('recovery is one decision per failure, with no count and no timeout', () => {
  const CLASSES: readonly RecoveryClass[] = [
    'abandoned', 'stale-owner', 'exhausted', 'permanent', 'transient', 'unclassified',
  ];

  const STAGES: readonly (RecoveryStage | undefined)[] = [undefined, 'retry', 'replace'];

  test('a superseded attempt is INERT for every class and every stage', () => {
    // A stale continuation must not publish readiness, file a failure, re-arm a startup
    // or destroy an identity it did not start on.
    for (const failure of CLASSES) {
      for (const stage of STAGES) {
        expect(recoveryStep({ owned: false, failure, stage }))
          .toEqual({ action: 'inert', stage });
      }
    }
  });

  const SETTLED: readonly { name: string; failure: RecoveryClass; action: 'refuse' | 'retry' }[] = [
    { name: 'exhaustion refuses, repeats nothing, destroys nothing and moves nothing', failure: 'exhausted', action: 'refuse' },
    // Nothing a retry reaches changes a permanent configuration, so spending
    // the ladder on it would only destroy a container over a mount option.
    { name: 'permanent configuration refuses on the first failure', failure: 'permanent', action: 'refuse' },
    // The identity a stale owner failed on is already gone, so it is no
    // evidence against the one that replaced it.
    { name: 'a stale owner retries and does NOT advance the container-fault ladder', failure: 'stale-owner', action: 'retry' },
  ];

  for (const settled of SETTLED) {
    test(settled.name, () => {
      for (const stage of STAGES) {
        expect(recoveryStep({ owned: true, failure: settled.failure, stage }))
          .toEqual({ action: settled.action, stage });
      }
    });
  }

  test('abandoned work enters at REPLACE, because destruction is its cancellation', () => {
    // The work is `exec` calls inside the container, so no token can fence it.
    // The identity has to go before anything attaches again.
    for (const stage of [undefined, 'retry'] as const) {
      expect(recoveryStep({ owned: true, failure: 'abandoned', stage }))
        .toEqual({ action: 'replace', stage: 'replace' });
    }
  });

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

  test('no decision ever deletes the row, and every written stage parses back', () => {
    for (const failure of CLASSES) {
      for (const stage of STAGES) {
        const decision = recoveryStep({ owned: true, failure, stage });
        expect(['retry', 'replace', 'refuse']).toContain(decision.action);

        // A stage that was set is never unset by a failure: the delete belongs
        // to success alone.
        if (stage !== undefined) expect(decision.stage).not.toBeUndefined();

        if (decision.stage !== undefined) {
          expect(parseRecoveryRow({ owner: 'o', stage: decision.stage }))
            .toEqual({ kind: 'row', row: { owner: 'o', stage: decision.stage } });
        }
      }
    }
  });
});

describe('port tokens and listener probes', () => {
  test('a token is 16 characters drawn only from the alphabet the SDK accepts', () => {
    const token = generatePortToken(n => Uint8Array.from({ length: n }, (_, i) => i * 7));
    expect(token).toMatch(/^[a-z0-9_]{16}$/u);
  });

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

describe('incident retry schedule', () => {
  test('five seconds doubling to a five-minute ceiling', () => {
    expect(incidentRetryDelayMs(0)).toBe(5_000);
    expect(incidentRetryDelayMs(1)).toBe(10_000);
    expect(incidentRetryDelayMs(4)).toBe(80_000);
    expect(incidentRetryDelayMs(6)).toBe(300_000);
    expect(incidentRetryDelayMs(60)).toBe(300_000);
  });

  test('a negative attempt count cannot produce a shorter delay than the first', () => {
    expect(incidentRetryDelayMs(-5)).toBe(5_000);
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

    expect(retryIn).toBe(Math.ceil(incidentRetryDelayMs(1) / 1000));
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

    expect(retryIn).toBe(Math.ceil(incidentRetryDelayMs(1) / 1000));
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
});

describe('the attach budget', () => {
  const attachWithin = <T>(
    budgetMs: number, work: () => Promise<T>, onOverrun: (failure: { readonly cause: unknown }) => void,
  ): Promise<T> => racedRestoreSteps(openStartBudget(budgetMs)).attach(work, onOverrun);

  test('work that finishes inside the budget resolves normally', async () => {
    const done = await attachWithin(25_000, () => Promise.resolve('ok'), () => {});
    expect(done).toBe('ok');
  });

  test('work that overruns is abandoned, and its late failure is still reported', async () => {
    const late: string[] = [];
    const { promise: work, reject: failWork } = Promise.withResolvers<never>();

    const run = attachWithin(0, () => work, failure => {
      late.push(describeThrown({ cause: failure.cause }));
    });

    await expect(run).rejects.toThrow(/exceeded its 0ms budget and was abandoned/);
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
    expect(classifyRecovery({ cause: new Error('bad layer') })).not.toBe('abandoned');
  });

  test('the remainder only ever falls', async () => {
    // One budget bounds the whole restoration; per-port listener windows would sum unbounded.
    const budget = openStartBudget(25_000);
    const first = budget.remainingMs();
    await Promise.resolve();
    const second = budget.remainingMs();
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThanOrEqual(25_000);
    expect(second).toBeLessThanOrEqual(first);
  });

  test('a spent budget answers zero rather than a negative remainder', () => {
    // A negative window would make `Date.now() + remaining` a past deadline for one caller
    // and a wait forever for another, so a clamping step must never receive one.
    expect(openStartBudget(0).remainingMs()).toBe(0);
    expect(openStartBudget(-5).remainingMs()).toBe(0);
  });

  test('the allowance divides what is left by the work still declared', () => {
    // Every restoration step is declared (each probe, each exposure, the boot stamp) so a probe
    // cannot spend what its exposure and the stamp still need; the last step may take the rest.
    const budget = openStartBudget(1_000);
    budget.declare(4);
    const first = budget.nextAllowanceMs();
    expect(first).toBeGreaterThan(200);
    expect(first).toBeLessThanOrEqual(250);
    // Three declared steps left, so the next share is a third of the remainder
    // rather than a quarter — a step that finished early leaves its share behind.
    const second = budget.nextAllowanceMs();
    expect(second).toBeGreaterThan(first);
  });

  test('the last declared step may have the whole remainder, and an undeclared one too', () => {
    const budget = openStartBudget(1_000);
    budget.declare(1);
    expect(budget.nextAllowanceMs()).toBeGreaterThan(900);
    // Past the declared work the divisor floors at one, so an extra step is
    // bounded by the clock rather than by a division by zero.
    expect(budget.nextAllowanceMs()).toBeGreaterThan(900);
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

  test('a step that finishes inside its allowance answers its value', async () => {
    expect(await runRestoreStep(25_000, () => Promise.resolve(7), () => {}))
      .toEqual({ kind: 'done', value: 7 });
  });

  test('a step that THROWS inside its allowance REPORTS the failure, never throws', async () => {
    // A throw here would abandon the rest of the restoration over one dead spec; the caller
    // needs a reason it can put in `unready`, not an exception.
    const late: string[] = [];

    const outcome = await runRestoreStep(
      25_000, () => Promise.reject(new Error('the port is in use')),
      (failure) => { late.push(describeThrown({ cause: failure.cause })); },
    );

    expect(outcome.kind).toBe('failed');
    expect(describeThrown(outcome.kind === 'failed' ? outcome : { cause: undefined }))
      .toBe('the port is in use');
    // `onLate` is for work abandoned at the deadline, and this was not.
    expect(late).toEqual([]);
  });

  test('the budget rejects with the overrun code used by recovery', async () => {
    // Abandoned work can still mutate the container, so recovery must replace its identity.
    let overrun: { readonly cause: unknown } | undefined;

    try {
      await attachWithin(0, () => Promise.withResolvers<never>().promise, () => {});
    } catch (error) {
      overrun = { cause: error };
    }

    expect(overrun?.cause).toMatchObject({ code: 'start-overrun' });
    expect(classifyRecovery(overrun ?? { cause: undefined })).toBe('abandoned');
    expect(recoveryStep({ owned: true, failure: 'abandoned', stage: undefined }))
      .toEqual({ action: 'replace', stage: 'replace' });
  });
});

describe('a composed container command is one a POSIX shell will run', () => {
  test('the listener probe parses', () => {
    requireShellAccepts(healthProbeCommand(8080));
  });
});

describe('thrown values', () => {
  test('a cause chain is rendered, and a non-Error is not assumed to have a message', () => {
    expect(describeThrown({ cause: new Error('outer', { cause: new Error('inner') }) }))
      .toBe('outer: inner');
    expect(describeThrown({ cause: 'plain string' })).toBe('plain string');
    expect(describeThrown({ cause: undefined })).toBe('undefined');
  });
});

import { createCheckpointLane } from '../src/operation-lanes';
import {
  deliverIncidents,
  INCIDENT_LEDGER_MAX_ROWS,
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

    for (let at = 0; at < INCIDENT_LEDGER_MAX_ROWS + 50; at += 1) {
      const row = seedIncident(box, `d${String(at).padStart(4, '0')}`);
      box.rows.set(`devbox:incident:${row.incidentId}`, { ...row, deliveredAt: at });
    }

    for (let p = 0; p < 5; p += 1) seedIncident(box, `pending${p}`);

    const deleted = await reapDeliveredIncidents(box.store);

    expect(deleted).toBe(55);
    expect(box.rows.size).toBe(INCIDENT_LEDGER_MAX_ROWS);
    expect(box.rows.has('devbox:incident:d0000')).toBe(false);
    expect(box.rows.has('devbox:incident:d0054')).toBe(false);
    expect(box.rows.has(`devbox:incident:d${String(55).padStart(4, '0')}`)).toBe(true);

    for (let p = 0; p < 5; p += 1) {
      expect(box.rows.has(`devbox:incident:pending${p}`)).toBe(true);
    }
  });
});

