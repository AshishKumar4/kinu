// Pure lifecycle decisions, pinned apart from the platform a unit test cannot drive.
// Tests assert outcomes, not reachability: a silent no-op durability path must fail here.
import { afterAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { DEVBOX_SCRATCH_PREFIX } from './support/scratch';

const suiteRoot = mkdtempSync(join(tmpdir(), `${DEVBOX_SCRATCH_PREFIX}decisions-`));

afterAll(() => rmSync(suiteRoot, { recursive: true, force: true }));

function devboxScratchDir(label: string): string {
  return mkdtempSync(join(suiteRoot, `${label}-`));
}

// Import from the defining modules, not the barrel: it pulls in `cloudflare:workers` via
// Sandbox, absent outside a Worker. Platform-free reachability is the property tested.
import { DEVBOX_WORKDIR, parseDevboxStrategyName } from '../src/storage';
import {
  DEFAULT_DEVBOX_POLICY,
  describeThrown,
  generatePortToken,
  healthProbeCommand,
  healthProbeSilent,
  incidentRetryDelayMs,
  parseWorkdirHolders,
  releaseWorkdirHoldersCommand,
  needsArming,
  PORT_TOKEN_ALPHABET,
  admissionStep,
  classifyRecovery,
  ContainerStartOverrun,
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
import { requireSessionShellAccepts, sessionShellRefusal } from './support/session-shell';
import {
  baseObjectKey,
  chainStoreRoot,
  chainBackupOptions,
  CHAIN_EXCLUDES,
  deltaObjectKey,
  isChainId,
  layerIntegrityFailure,
  metadataObjectKey,
  normalizeChainState,
  type ChainLayer,
} from '../src/snapshot-chain';

const CHAIN_ID = 'a1b2c3d4-0000-4000-8000-000000000001';

const FALLBACK_ID = 'a1b2c3d4-0000-4000-8000-0000000000fb';

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
    expect(classifyRecovery({ cause: new ContainerStartOverrun('Devbox.attach', 25_000) }))
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
      cause: new ContainerStartOverrun('Devbox.attach', 1),
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
    expect(token).toHaveLength(16);

    for (const character of token) expect(PORT_TOKEN_ALPHABET).toContain(character);
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

  test('the probe command binds to loopback and cannot hang the restart', () => {
    const command = healthProbeCommand(8080);
    expect(command).toContain('127.0.0.1:8080');
    expect(command).toContain('-m 3');
    expect(command).toContain('--connect-timeout 2');
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

describe('readiness is per container, not per Durable Object', () => {
  test('the startup callback turns the lifecycle over before admitting a stopped container', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'src', 'devbox.ts'), 'utf8');
    const startup = source.slice(source.indexOf('async #startContainer('));
    const body = startup.slice(0, startup.indexOf('\n  }'));
    expect(body).toContain('this.#invalidateGeneration();');
    // The patched SDK marks healthy before the hook, so restore commands reach the container.
    // No app port is awaited: the restore starts the app, so that wait would block the restore.
    const admission = source.slice(source.indexOf('async #admitControlListener('));
    const admitting = admission.slice(0, admission.indexOf('\n  }'));
    expect(admitting).toContain('await this.startAndWaitForPorts({');
    expect(admitting).toContain('ports: this.defaultPort');
    const invalidate = source.slice(source.indexOf('  #invalidateGeneration('));
    const reset = invalidate.slice(0, invalidate.indexOf('\n  }'));
    expect(reset).toContain('this.#generation += 1;');
    expect(reset).toContain('this.#startup = recoveryFlight === undefined');
    expect(reset).toContain("this.#restoration = { phase: 'unstarted' };");
  });
});

describe('every self-re-arming schedule needs a first link', () => {
  // Self-re-arming schedule rows never start on their own; `onStart` must arm each first link,
  // and a missing link is silent. Pinned as source shape: no test can start a container.
  const source = readFileSync(join(import.meta.dir, '..', 'src', 'devbox.ts'), 'utf8');

  const bodyOf = (signature: string): string => {
    const from = source.indexOf(signature);
    expect(from).toBeGreaterThan(-1);
    const tail = source.slice(from);

    return tail.slice(0, tail.indexOf('\n  }'));
  };

  test('onStart forges a first link for all three self-re-arming rows', () => {
    const schedules = bodyOf('async #armContainerSchedules(');

    for (const callback of ['CHECKPOINT_CALLBACK', 'HEARTBEAT_CALLBACK']) {
      expect(schedules).toContain(`this.#arm(${callback}`);
    }

    // The startup row goes through `kickStartup`: the SDK runs this hook on every admission probe,
    // so a bare `#arm` would wake a settled box for ever; `kickStartup` refuses such phases.
    expect(schedules).toContain('await this.kickStartup();');
    expect(bodyOf('async kickStartup(')).toContain('this.#arm(STARTUP_CALLBACK, 1)');
  });

  test('the sweep of unreachable schedule rows runs at activation, before any arming', () => {
    // The start hook never fires on a wake whose container is asleep, yet the alarm loop runs;
    // the activation gate settles before any event, alarm included, so the sweep belongs there.
    const schedules = bodyOf('async #armContainerSchedules(');
    expect(schedules).not.toContain('#sweepUnknownSchedules');
    const activation = bodyOf('constructor(ctx: DurableObjectState<{}>, env: Env) {');
    expect(activation).toContain('ctx.blockConcurrencyWhile(');
    expect(activation).toContain('this.#activate()');
    const activate = bodyOf('async #activate(');
    expect(activate).toContain('this.#sweepUnknownSchedules()');
    // Activation is storage only: the gate delivers no timer, so a container command here is
    // unbounded. It notes the durable claim; the first delivered frame asks (`#resolveAdoption`).
    expect(activate).toContain('this.#durableClaim()');
    expect(activate).not.toContain('#adoptIfCurrent');
    expect(activate).not.toContain('#readBootId');
    expect(activate).not.toContain('#rawExec');
    const sweep = bodyOf('async #sweepUnknownSchedules(');
    expect(sweep).toContain('SELECT DISTINCT callback FROM container_schedules');
    expect(sweep).toContain('this.deleteSchedules(callback)');
    // By whether THIS class can call it, not by a list of retired names: a
    // subclass arms its own callbacks and a name list here would delete them.
    expect(sweep).toContain('if (callback in this) continue;');
  });

  test('the incident row is armed on demand, not at start', () => {
    // The incident row is not a start link: an incident schedule with no incidents to deliver
    // is a wakeup that does nothing forever.
    expect(bodyOf('async #armContainerSchedules(')).not.toContain('INCIDENT_CALLBACK');
    expect(source).toContain('this.#arm(INCIDENT_CALLBACK');
  });

  test('quiesce arms NOTHING, so no row outlives the stop', () => {
    // A stopped box has nothing to heartbeat; a surviving row would wake the container forever.
    // The next container start re-arms all three rows.
    const quiesce = bodyOf('async quiesce(');
    expect(quiesce).not.toContain('#arm(');
    expect(quiesce).toContain("this.stop('SIGTERM')");
  });

  test('every self-re-arming callback re-arms through ONE guard, not by hand', () => {
    // The guard re-arms every chain; a failed container admission must itself record its refusal
    // and leave a startup successor. Other `#arm(` calls are first links of a chain.
    for (const callback of ['devboxCheckpoint', 'devboxHeartbeat', 'devboxIncidents']) {
      const body = bodyOf(`async ${callback}(`);
      expect({ callback, guarded: body.includes('this.#scheduled(') }).toEqual({
        callback, guarded: true,
      });
      expect({ callback, handRolled: body.includes('this.#arm(') }).toEqual({
        callback, handRolled: false,
      });
    }

    const armSites = (body: string): number => [...body.matchAll(/this\.#arm\(/g)].length;
    expect({
      total: armSites(source),
      onStart: armSites(bodyOf('async #armContainerSchedules(')),
      startupAdmission: armSites(bodyOf('async #admitControlListener(')),
      startupRetry: armSites(bodyOf('async #recover(')),
      hookFailure: armSites(bodyOf('async #runStartHook(')),
      onKick: armSites(bodyOf('async kickStartup(')),
      onRecord: armSites(bodyOf('async #record(')),
      guard: armSites(bodyOf('async #scheduled(')),
    }).toEqual({
      total: 7, onStart: 2, startupAdmission: 1, startupRetry: 1, hookFailure: 0,
      onKick: 1, onRecord: 1, guard: 1,
    });
    // Only the `retry` action re-arms startup; a refusal or replacement that armed one
    // would recreate the loop the ladder exists to end.
    const recover = bodyOf('async #recover(');
    expect(recover.slice(recover.indexOf("decision.action === 'retry'")))
      .toContain('await this.#arm(STARTUP_CALLBACK');
    expect(bodyOf('async #scheduled(')).toContain('await this.#arm(callback, nextSeconds)');
    expect(bodyOf('async #scheduled(')).toContain('} catch (error) {');
    // The SDK's alarm chain ends without a successor once `sleepAfterMs` passes, so a tick
    // that does not renew the activity timeout is the last tick.
    expect(bodyOf('async devboxHeartbeat(')).toContain('this.renewActivityTimeout();');
  });

  test('a commit asks the same question, because a heartbeat cadence is not a fence', () => {
    // Heartbeat detection leaves operations between beats on a replaced container without the mount.
    // A commit asks: it is where bytes are claimed durable, and one boot-marker read is the cost.
    expect(bodyOf('async checkpointNow(')).toContain('#healReplacedContainer()');
    expect(bodyOf('async quiesce(')).toContain('#healReplacedContainer()');
    const heal = bodyOf('async #healReplacedContainer(');
    expect(heal).toContain('#containerWasReplaced()');
    // Re-attach through the ordinary restoration, so the recovery ladder and the
    // strategy's own residue handling are the ones that run.
    expect(heal).toContain('this.#invalidateGeneration();');
    expect(heal).toContain('await this.kickStartup();');
    expect(heal).toContain('throw new Error(');
    expect(heal).not.toContain('this.#restoreNow(');
  });

  test('keepAlive is never enabled, because it kills the alarm chain', () => {
    // The SDK alarm loop's activity branch sets no successor and `Sandbox.onActivityExpired`
    // only logs under keepAlive, so keepAlive kills the chain and loses the final checkpoint.
    expect(source).not.toContain('await this.setKeepAlive(');
    expect(source).toContain('override async onActivityExpired(');
    expect(bodyOf('override async onActivityExpired(')).toContain("checkpoint('quiesce')");
  });
});

describe('arming must ignore the row being dispatched', () => {
  // The container SDK deletes a fired row after its callback returns, so the firing row
  // is still in the table during the callback and must not count as a pending successor.
  const NOW = 1_700_000_000;

  test('the firing row does not count, so a successor is still armed', () => {
    expect(needsArming([{ time: NOW }], NOW, true)).toBe(true);
    expect(needsArming([{ time: NOW - 30 }], NOW, true)).toBe(true);
  });

  test('a genuine future row does count, so a restart does not double the period', () => {
    expect(needsArming([{ time: NOW + 1 }], NOW, true)).toBe(false);
    expect(needsArming([{ time: NOW + 3_600 }], NOW, true)).toBe(false);
  });

  test('no rows at all needs arming', () => {
    expect(needsArming([], NOW, true)).toBe(true);
    expect(needsArming([], NOW, false)).toBe(true);
  });

  test('the firing row alongside a future row does not suppress the future one', () => {
    expect(needsArming([{ time: NOW }, { time: NOW + 60 }], NOW, true)).toBe(false);
  });

  test('a caller that is not dispatching counts a due row as pending work', () => {
    // Each arm moves the platform alarm later, so re-arming a due row on every state read
    // would keep deferring its delivery (D14).
    expect(needsArming([{ time: NOW }], NOW, false)).toBe(false);
    expect(needsArming([{ time: NOW - 30 }], NOW, false)).toBe(false);
    expect(needsArming([{ time: NOW + 1 }], NOW, false)).toBe(false);
  });

  test('the guard the class uses is this one, not a row count', () => {
    // The guard has two readers, `#arm` and `resolveReadiness`, so it is pinned where it lives
    // plus the delegation that keeps it single.
    const devbox = readFileSync(join(import.meta.dir, '..', 'src', 'devbox.ts'), 'utf8');
    const guard = devbox.slice(devbox.indexOf('async #pending('));
    const body = guard.slice(0, guard.indexOf('\n  }'));
    expect(body).toContain('needsArming(');
    expect(body).not.toContain('.length > 0');
    const armed = devbox.slice(devbox.indexOf('async #arm('));
    expect(armed.slice(0, armed.indexOf('\n  }'))).toContain('await this.#pending(callback)');
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

  test('the budget rejects with the overrun TYPE, which is what the taxonomy reads', async () => {
    // Abandoned work is still running in the container, so recovery replaces the identity.
    // That choice reads the thrown class, not the message, so the class is the contract.
    let overrun: { readonly cause: unknown } | undefined;

    try {
      await attachWithin(0, () => Promise.withResolvers<never>().promise, () => {});
    } catch (error) {
      overrun = { cause: error };
    }

    expect(overrun?.cause).toBeInstanceOf(ContainerStartOverrun);
    expect(classifyRecovery(overrun ?? { cause: undefined })).toBe('abandoned');
    expect(recoveryStep({ owned: true, failure: 'abandoned', stage: undefined }))
      .toEqual({ action: 'replace', stage: 'replace' });
  });
});

// Every command runs in the SDK's one persistent session shell, so a syntax error ends it.
// Every fake exec seam runs `support/session-shell.ts` first, so a bad template fails here.
describe('a composed container command is one a POSIX shell will run', () => {
  test('the holder-release command parses, and says nothing that ends the shell', () => {
    const command = releaseWorkdirHoldersCommand(DEVBOX_WORKDIR);
    requireSessionShellAccepts(command);
    // A top-level `exit` ends the persistent session too; this command answers its empty scan
    // with `else`.
    expect(command).not.toMatch(/(?:^|[\s;&|(])exit(?:\s+\d+)?\s*(?:$|[;&|)])/);
    // The wait is read off the command the container runs: a TERM flush window before the KILL.
    expect(command).toContain('sleep 5');
  });

  test('a work directory holding a quote is still one shell word', () => {
    // `'` closes the quoted literal, so the escape must reopen it; only a real parse proves it.
    requireSessionShellAccepts(releaseWorkdirHoldersCommand("/work'dir"));
  });

  test('the listener probe parses too', () => {
    requireSessionShellAccepts(healthProbeCommand(8080));
  });

  // A top-level `set -e` persists in the SDK's one bash session, so any later failing command
  // ends it (D18); the model is checked against a real bash fed the way the SDK feeds it.
  test('a top-level set -e is refused as a session death; a subshell-scoped one is accepted', () => {
    const unscoped = ['# devbox-namespace-v2', 'set -e', 'mkdir -p /tmp/x'].join('\n');
    const scoped = ['# devbox-namespace-v2', '(', 'set -e', 'mkdir -p /tmp/x', ')'].join('\n');

    const refusal = sessionShellRefusal(unscoped);

    expect(refusal?.name).toBe('SessionTerminatedError');
    expect(refusal?.message).toContain('exit code: 1');
    expect(sessionShellRefusal(scoped)).toBeUndefined();
    expect(sessionShellRefusal(['(', 'set -o errexit', 'true', ')'].join('\n'))).toBeUndefined();
    expect(sessionShellRefusal('set -o errexit\ntrue')?.name).toBe('SessionTerminatedError');

    const session = (batch: string) => spawnSync('bash', ['--norc'], {
      input: `${batch}\nfalse\nprintf 'session=alive\\n'\n`, encoding: 'utf8',
    });

    const dead = session(unscoped);
    const alive = session(scoped);

    expect(dead.stdout).not.toContain('session=alive');
    expect(dead.status).toBe(1);
    expect(alive.stdout).toContain('session=alive');
    expect(alive.status).toBe(0);
  });

  test('the scan\'s own answers are read back: names, and the word for none', () => {
    // Real output, measured against a live holder on Linux: one ` pid:comm` token per holder,
    // on stdout and stderr both.
    expect(parseWorkdirHolders(' 1786951:sleep')).toEqual([{ pid: '1786951', comm: 'sleep' }]);
    expect(parseWorkdirHolders(' 41:bun 42:node\n')).toEqual([
      { pid: '41', comm: 'bun' },
      { pid: '42', comm: 'node' },
    ]);
    expect(parseWorkdirHolders('none')).toEqual([]);
    expect(parseWorkdirHolders('')).toEqual([]);
  });

  /** Holders start inside the namespace so the scan sees them; FIFOs sit outside the work dir,
   *  else the cwd-only holder would hold an fd there and be signalled as a stranger. */
  const HOLDER_SCENARIO = `
dir=$1; script=$2; sready=$3; cready=$4
mkfifo "$sready" "$cready"
( exec 9>"$dir/stranger.bin"; echo ready > "$sready"; exec sleep 60 ) &
stranger=$!
( cd "$dir" && { echo ready > "$cready"; exec sleep 60; } ) &
cwd=$!
read _ < "$sready"
read _ < "$cready"
exec 8>"$dir/ancestor.bin"
sh "$script"
printf 'ALIVE %s' "$$"
wait $stranger
status=$?
if kill -0 $cwd 2>/dev/null; then alive=yes; else alive=no; fi
pids=$(ls /proc | grep -cE '^[0-9]+$')
printf '\\nPIDS stranger=%s cwd=%s session=%s status=%s cwdalive=%s pidsInScan=%s\\n' \\
  "$stranger" "$cwd" "$$" "$status" "$alive" "$pids"
`;

  /** Runs the real command in its own pid namespace, as production runs in the container's:
   *  the scan walks every pid twice, and namespace exit reaps everything the scenario starts. */
  test.skipIf(process.platform !== 'linux')(
    'a stranger is signalled and unnamed; a cwd holder and the scan\'s own session are named',
    () => {
      const dir = devboxScratchDir('devbox-workdir-holders');
      const script = join(dir, 'release.sh');
      writeFileSync(script, releaseWorkdirHoldersCommand(dir));
      const scenario = join(dir, 'holders.sh');
      writeFileSync(scenario, HOLDER_SCENARIO);
      // pid 1 stands in for the container server the scan excludes, so it must not host the scan;
      // it waits on the session as a child because a pid namespace ends with its pid 1.
      const init = join(dir, 'init.sh');
      writeFileSync(init, 'inner=$1; shift; sh "$inner" "$@"\n');
      const ready = { stranger: `${dir}-ready-stranger`, cwd: `${dir}-ready-cwd` };

      const ran = spawnSync('unshare', [
        '-Ur', '--fork', '--pid', '--mount-proc',
        'sh', init, scenario, dir, script, ready.stranger, ready.cwd,
      ], { encoding: 'utf8' });

      const holders = parseWorkdirHolders(ran.stdout.split('ALIVE')[0] ?? '');

      // The scenario's own answers, since every pid in them is namespace-local.
      const reported = (name: string): string =>
        new RegExp(`(?:^|\\s)${name}=(\\S+)`).exec(ran.stdout)?.[1] ?? '';

      const named = (pid: string): boolean =>
        pid.length > 0 && holders.some((holder) => holder.pid === pid);

      expect({
        // First, because every other field reads false when the command never ran (missing
        // `unshare`, refused namespace, or the bound above firing).
        commandRan: ran.error === undefined ? 'yes' : ran.error.message,
        sessionSurvived: ran.stdout.includes('ALIVE'),
        strangerSignalled: ran.stderr.includes('signalling:'),
        strangerStillNamed: named(reported('stranger')),
        strangerSignal: Number(reported('status')) - 128,
        cwdHolderNamed: named(reported('cwd')),
        cwdHolderSurvived: reported('cwdalive'),
        cwdHolderExplained: ran.stderr.includes('cwd-only holders'),
        ancestorNamed: named(reported('session')),
        ancestorExplained: ran.stderr.includes("this session's own"),
        // The scan is scoped to a container-sized process table, which is the
        // whole reason its two walks fit inside one bounded stop.
        pidsInScan: Number(reported('pidsInScan')) < 32,
      }).toEqual({
        commandRan: 'yes',
        sessionSurvived: true,
        strangerSignalled: true,
        strangerStillNamed: false,
        strangerSignal: 15,
        cwdHolderNamed: true,
        cwdHolderSurvived: 'yes',
        cwdHolderExplained: true,
        ancestorNamed: true,
        ancestorExplained: true,
        pidsInScan: true,
      });
      rmSync(dir, { recursive: true, force: true });
      rmSync(ready.stranger, { force: true });
      rmSync(ready.cwd, { force: true });
    },
  );
});

describe('chain identity — UUID keys refuse traversal by construction', () => {
  test('only a UUID is a chain id', () => {
    for (const bad of [
      '../../etc', '', 'backups/x/data.sqsh', 'a/b/c/d-e-f-g-h',
      'ZZZZZZZZ-0000-4000-8000-000000000009', `${CHAIN_ID}/..`, ` ${CHAIN_ID}`,
    ]) {
      expect(isChainId(bad)).toBe(false);
    }

    expect(isChainId(CHAIN_ID)).toBe(true);
  });

  test('every key builder validates, so no path can be assembled from a guess', () => {
    const STORE_ROOT = chainStoreRoot('boxes/box-under-test');

    for (const build of [baseObjectKey, deltaObjectKey, metadataObjectKey]) {
      expect(() => build(STORE_ROOT, '../../etc/passwd')).toThrow(/is not a UUID/);
      // Keys nest under the box's own root, so one mount covers every generation
      // and one box's sweep never reaches another box's layers.
      expect(build(STORE_ROOT, CHAIN_ID)).toStartWith(`${STORE_ROOT}/${CHAIN_ID}/`);
      expect(build(STORE_ROOT, CHAIN_ID)).toStartWith('boxes/');
    }

    // Three distinct objects under one prefix, so a discard can name all of
    // them and a delta can be replaced without touching the base.
    const keys = [baseObjectKey(STORE_ROOT, CHAIN_ID), deltaObjectKey(STORE_ROOT, CHAIN_ID), metadataObjectKey(STORE_ROOT, CHAIN_ID)];
    expect(new Set(keys).size).toBe(3);
  });

  test('a record this code did not write reads as absent, not as a broken chain', () => {
    for (const raw of [
      null, undefined, 42, 'chain', {},
      { mode: 'chain', rev: 1 },
      { mode: 'chain', rev: 1, base: { id: 'not-a-uuid', bytes: 1 } },
      { mode: 'chain', rev: 1, base: { id: CHAIN_ID } },
      { mode: 'elsewhere', rev: 1, base: { id: CHAIN_ID, bytes: 1 } },
      { mode: 'chain', rev: '1', base: { id: CHAIN_ID, bytes: 1 } },
    ]) {
      expect(normalizeChainState(raw)).toBeNull();
    }

    const sound = { mode: 'chain', rev: 2, base: { id: CHAIN_ID, bytes: 9 }, at: 5 };
    expect(normalizeChainState(sound)).toEqual({
      mode: 'chain', rev: 2, at: 5,
      base: { id: CHAIN_ID, bytes: 9, digest: undefined, objectVersion: undefined },
      delta: undefined, changeVersion: undefined, upperMark: undefined, orphans: undefined,
      fallback: undefined, lastFailure: undefined,
    });
    // A row without layer identities parses with both absent: UNKNOWN, not unsound.
    // Such rows are live; refusing them would be the data loss the chain exists to prevent.
    expect(normalizeChainState(sound)?.base.digest).toBeUndefined();
    expect(normalizeChainState(sound)?.base.objectVersion).toBeUndefined();
    // A malformed digest rejects the row: nothing could compare it against a layer.
    // `objectVersion` is the store's own format, so only non-emptiness is checked.
    const digest = 'c'.repeat(64);
    const objectVersion = 'e2f4c1a0-upload';
    expect(normalizeChainState({
      ...sound, base: { id: CHAIN_ID, bytes: 9, digest, objectVersion },
    })?.base).toEqual({ id: CHAIN_ID, bytes: 9, digest, objectVersion });
    expect(normalizeChainState({ ...sound, base: { id: CHAIN_ID, bytes: 9, digest: 'C'.repeat(64) } }))
      .toBeNull();
    expect(normalizeChainState({ ...sound, base: { id: CHAIN_ID, bytes: 9, digest: 'abc' } }))
      .toBeNull();
    expect(normalizeChainState({ ...sound, base: { id: CHAIN_ID, bytes: 9, objectVersion: '' } }))
      .toBeNull();

    // A retained fallback keeps its digest and version, delta included: a restore cannot use a
    // generation the reader cannot check.
    const withFallback = {
      ...sound,
      fallback: {
        base: { id: FALLBACK_ID, bytes: 7, digest, objectVersion },
        delta: { bytes: 3, digest, objectVersion },
      },
    };

    expect(normalizeChainState(withFallback)?.fallback).toEqual({
      base: { id: FALLBACK_ID, bytes: 7, digest, objectVersion },
      delta: { bytes: 3, digest, objectVersion },
    });
    // A non-UUID fallback id nulls the whole row, as a bad `base` does: object keys derive from it.
    expect(normalizeChainState({ ...sound, fallback: { base: { id: 'nope', bytes: 7 } } }))
      .toBeNull();
  });
});

describe('integrity probe — each unsound shape names itself', () => {
  /** A layer known only by its size: the shape of a row stored without digest or store version. */
  const sized = (bytes: number | undefined): ChainLayer | undefined =>
    (bytes === undefined ? undefined : { bytes, digest: undefined, objectVersion: undefined });

  test('the four ways a stored layer can be unusable', () => {
    const bySize = (declared: number | undefined, stored: number | undefined, label: string) =>
      layerIntegrityFailure({ declared: sized(declared), stored: sized(stored), label });

    expect(bySize(undefined, 1, 'base')).toContain('declares no size');
    expect(bySize(1, undefined, 'base')).toContain('missing from the store');
    expect(bySize(0, 0, 'delta')).toContain('declares 0 bytes');
    expect(bySize(10, 11, 'delta')).toContain('11 bytes, state declares 10');
    expect(bySize(10, 10, 'base')).toBeNull();
  });

  test('KINU-N025: a matching size with a different digest is a DIFFERENT archive', () => {
    // The gap a byte count cannot close: same length, different content, still a
    // valid squashfs image. It mounts and serves the wrong workspace.
    const digest = 'a'.repeat(64);
    const other = 'b'.repeat(64);

    const refusal = layerIntegrityFailure({
      declared: { bytes: 4_096, digest, objectVersion: undefined },
      stored: { bytes: 4_096, digest: other, objectVersion: undefined },
      label: 'delta',
    });

    expect(refusal).toContain('different archive of the same length');
    expect(refusal).toContain(other);
    expect(refusal).toContain(digest);
    // R2 reports a digest only for objects uploaded with a checksum; a missing one must pass,
    // or every multipart archive would be refused.
    expect(layerIntegrityFailure({
      declared: { bytes: 4_096, digest, objectVersion: undefined },
      stored: { bytes: 4_096, digest, objectVersion: undefined },
      label: 'delta',
    })).toBeNull();
    expect(layerIntegrityFailure({
      declared: { bytes: 4_096, digest, objectVersion: undefined },
      stored: { bytes: 4_096, digest: undefined, objectVersion: undefined },
      label: 'base',
    })).toBeNull();
    // A declared record without a digest is also UNKNOWN, and such rows are live: `Devbox.strategy`
    // defaults to the chain, so refusing them would break deployed sandboxes.
    expect(layerIntegrityFailure({
      declared: { bytes: 4_096, digest: undefined, objectVersion: undefined },
      stored: { bytes: 4_096, digest: other, objectVersion: undefined },
      label: 'base',
    })).toBeNull();
  });

  test('KINU-N025: with no digest to compare, a different store version is a DIFFERENT '
    + 'upload', () => {
      // The Workers multipart API takes no checksum, so R2 reports no digest for a large archive;
      // the upload-minted version is what catches a same-length replacement.
      const big = 512 * 1024 * 1024;

      const refusal = layerIntegrityFailure({
        declared: { bytes: big, digest: undefined, objectVersion: 'upload-one' },
        stored: { bytes: big, digest: undefined, objectVersion: 'upload-two' },
        label: 'base',
      });

      expect(refusal).toContain('written by a different upload');
      expect(refusal).toContain('upload-one');
      expect(refusal).toContain('upload-two');
      // No digest on either side is what a sound multipart archive looks like, so size plus version must pass.
      expect(layerIntegrityFailure({
        declared: { bytes: big, digest: undefined, objectVersion: 'upload-one' },
        stored: { bytes: big, digest: undefined, objectVersion: 'upload-one' },
        label: 'base',
      })).toBeNull();
      // A row with no recorded `objectVersion` is unknown, not unsound, so it passes.
      expect(layerIntegrityFailure({
        declared: { bytes: 4_096, digest: undefined, objectVersion: undefined },
        stored: { bytes: 4_096, digest: undefined, objectVersion: 'upload-two' },
        label: 'base',
      })).toBeNull();
    });

  test('KINU-N025: agreeing content outranks a new store version, because a re-upload '
    + 'is not a replacement', () => {
      // A version is minted per upload: a lost state write can leave the store a version ahead
      // with identical content, so matching digests win and the version decides only without one.
      const digest = 'a'.repeat(64);
      expect(layerIntegrityFailure({
        declared: { bytes: 4_096, digest, objectVersion: 'upload-one' },
        stored: { bytes: 4_096, digest, objectVersion: 'upload-two' },
        label: 'delta',
      })).toBeNull();
      expect(layerIntegrityFailure({
        declared: { bytes: 4_096, digest, objectVersion: 'upload-one' },
        stored: { bytes: 4_096, digest: 'b'.repeat(64), objectVersion: 'upload-one' },
        label: 'delta',
      })).toContain('different archive of the same length');
    });
});

describe('archive options', () => {
  test('derived trees never travel, git metadata always does, and the archive '
    + 'outlives a long weekend', () => {
    const options = chainBackupOptions(false, CHAIN_EXCLUDES);
    expect(options.dir).toBe('/workspace');
    expect(options.excludes).toContain('node_modules');
    // `.git` holds unpushed commits and makes a linked worktree a repository; excludes
    // cover only what a lockfile reproduces.
    expect(options.excludes).not.toContain('.git');
    // The SDK's own default is three days and it is enforced at restore time,
    // so a shorter TTL is a box that refuses to come back after a break.
    expect(options.ttl).toBeGreaterThanOrEqual(7 * 24 * 60 * 60);
    expect(chainBackupOptions(true, CHAIN_EXCLUDES).localBucket).toBe(true);
  });

  test('the excludes come from the caller, so both modes obey one policy', () => {
    expect(chainBackupOptions(false, ['only-this']).excludes).toEqual(['only-this']);
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

describe('bench arm selection fails closed', () => {
  test('missing and unknown strategy names never become the shipped strategy', () => {
    expect(parseDevboxStrategyName(undefined)).toBeNull();
    expect(parseDevboxStrategyName(null)).toBeNull();
    expect(parseDevboxStrategyName('unknown')).toBeNull();
    // A retired format name must parse to null: no build can serve bytes written in that format.
    expect(parseDevboxStrategyName('a-retired-format')).toBeNull();
    expect(parseDevboxStrategyName('snapshot-chain')).toBe('snapshot-chain');
  });
});

import { createCheckpointLane } from '../src/lifecycle';
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

    const op = async (): Promise<CheckpointOutcome> => {
      calls += 1;
      await new Promise(resolve => setTimeout(resolve, 5));

      return Promise.resolve(ok());
    };

    const [a, b] = await Promise.all([lane.run('tick', op), lane.run('tick', op)]);
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

    const slowTick = async (): Promise<CheckpointOutcome> => {
      events.push('tick:start');
      await new Promise(resolve => setTimeout(resolve, 10));
      events.push('tick:end');

      return Promise.resolve(ok());
    };

    const quiesce = async (): Promise<CheckpointOutcome> => {
      events.push('quiesce:start');
      events.push('quiesce:end');

      return Promise.resolve(ok());
    };

    await Promise.all([lane.run('tick', slowTick), lane.run('quiesce', quiesce)]);
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

  test('recording goes through the shared writer bound to INCIDENT_REASON_MAX_CHARS', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'src', 'devbox.ts'), 'utf8');
    const from = source.indexOf('async #record(');
    const body = source.slice(from, source.indexOf('\n  }', from));
    expect(body).toContain('recordIncident(this.ctx.storage');
    expect(body).not.toContain('.slice(0, 2000)');
    expect(source).not.toContain('reason.slice(0, 2000)');
  });
});

