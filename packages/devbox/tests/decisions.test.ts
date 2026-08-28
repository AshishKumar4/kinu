// The decision gate.
//
// Every rule a devbox runs on, at its boundary. These are pure functions on
// purpose: a container lifecycle cannot be driven from a unit test, so the
// reasoning is separated from the platform and the reasoning is what is pinned
// here. A table beats reading the same condition twice.
//
// The defect class this exists for: a durability path that silently did
// nothing. A wrapper reported a restore it had not performed, and nothing
// observed the difference, so an agent ran against an empty directory for the
// rest of the container's life. So every test below asserts an OUTCOME rather
// than that a function was reachable.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// Imported from the modules that hold them, NOT from the barrel. The barrel
// pulls in the Devbox class, which imports the Sandbox runtime and therefore
// `cloudflare:workers`, which does not exist outside a Worker. That the
// decisions are reachable without the platform is the point of separating them,
// so this import is the property rather than a workaround. The barrel's own
// coherence is checked by `tsc`.
import { DEVBOX_RUNTIME_DIR, parseDevboxStrategyName } from '../src/storage';
import {
  DEFAULT_DEVBOX_POLICY,
  describeThrown,
  findMount,
  generatePortToken,
  healthProbeCommand,
  healthProbeSilent,
  incidentRetryDelayMs,
  needsArming,
  PORT_TOKEN_ALPHABET,
  admissionStep,
  classifyRecovery,
  ContainerStartOverrun,
  openStartBudget,
  runRestoreStep,
  parseRecoveryRow,
  quiesceStep,
  recoveryStep,
  restartPlan,
  withContainerStartDeadline,
  type DevboxIncident,
  type IncidentDisposition,
  type PortExposureSpec,
  type RecoveryClass,
  type RecoveryStage,
  type SupervisedProcessSpec,
} from '../src/lifecycle';
import {
  assertChainId,
  baseObjectKey,
  chainBackupOptions,
  CHAIN_EXCLUDES,
  deltaObjectKey,
  isChainId,
  layerIntegrityFailure,
  metadataObjectKey,
  normalizeChainState,
  isOverlayMounted,
  shouldCheckpoint,
  type ChainLayer,
} from '../src/snapshot-chain';
import { isS3fsMounted } from '../src/r2fs';

const CHAIN_ID = 'a1b2c3d4-0000-4000-8000-000000000001';
/** The generation a record retains as its restore fallback. */
const FALLBACK_ID = 'a1b2c3d4-0000-4000-8000-0000000000fb';

/** What the PRODUCTION image really reports. fuse-overlayfs publishes NO
 *  lowerdir/upperdir/workdir options; only kernel overlay does. */
const OVERLAY_MOUNTS = [
  'sysfs /sys sysfs rw,nosuid,nodev,noexec,relatime 0 0',
  `/dev/sqsh ${DEVBOX_RUNTIME_DIR}/lower-base squashfs ro,relatime 0 0`,
  'fuse-overlayfs /workspace fuse.fuse-overlayfs rw,nosuid,nodev,relatime,user_id=0 0 0',
].join('\n');
/** Kernel overlay, which DOES publish the dirs. Both must read as mounted. */
const KERNEL_OVERLAY_MOUNTS =
  'overlay /workspace overlay rw,lowerdir=/a:/b,upperdir=/c,workdir=/d 0 0';

const FUSE_MOUNTS = [
  'proc /proc proc rw,relatime 0 0',
  's3fs /workspace fuse.s3fs rw,nosuid,nodev,relatime,user_id=0 0 0',
].join('\n');

const NO_MOUNTS = 'proc /proc proc rw,relatime 0 0\n/dev/vdc / ext4 rw 0 0';

// ── the activity lease ──────────────────────────────────────────────────────

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
    // And the stretch is FORGOTTEN, so the confirmation starts over once the
    // work finishes. A remembered stretch would stop the box on the first tick
    // after a long job, which is the worst possible moment.
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

  test('the heartbeat samples often enough for both windows to be observable', () => {
    const beat = DEFAULT_DEVBOX_POLICY.heartbeatSeconds * 1_000;
    // Each window has to span several heartbeats or "confirmed across
    // heartbeats" is one sample wearing a plural.
    expect(DEFAULT_DEVBOX_POLICY.idleMs).toBeGreaterThan(beat * 5);
    expect(DEFAULT_DEVBOX_POLICY.quietConfirmMs).toBeGreaterThan(beat * 2);
  });

  test('the attach budget is bounded, and short enough to be a bound', () => {
    // The attach runs in a scheduled callback, so this budget is entirely ours
    // and it can actually fire. It still sits under the platform's 30 s
    // blockConcurrencyWhile cancel window, because a box whose attach takes
    // longer than that has a problem a longer budget does not fix.
    expect(DEFAULT_DEVBOX_POLICY.attachBudgetMs).toBeGreaterThan(20_000);
    expect(DEFAULT_DEVBOX_POLICY.attachBudgetMs).toBeLessThan(30_000);
  });

  test('the retry cadence is the heartbeat, so a refused box is retried but not spun', () => {
    // A failed attach re-arms the startup schedule at this cadence and refuses
    // operations in between, instead of re-attaching once per call and
    // recording an incident each time.
    expect(DEFAULT_DEVBOX_POLICY.heartbeatSeconds).toBeGreaterThan(10);
    expect(DEFAULT_DEVBOX_POLICY.heartbeatSeconds).toBeLessThanOrEqual(120);
  });
});

// ── restart ordering ────────────────────────────────────────────────────────

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
    // The SHAPE is the guard. There is no op that exposes a port, so there is no
    // way to write an executor that exposes one whose listener was never probed
    // — which is exactly what the flat three-op list allowed.
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

// ── the recovery taxonomy ───────────────────────────────────────────────────

/**
 * A failure as `@cloudflare/sandbox` really presents one: the code is a GETTER
 * on the class, not an own property, and none of its error classes is exported.
 * A stand-in carrying the code as a plain field would pass a check the shipped
 * SDK fails.
 */
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
    // The snapshot chain rethrows a mount failure as its own sentence with the
    // SDK's error as `cause`. A classifier that read only the outermost value
    // would answer `unclassified` for every wrapped failure, which is the one
    // generic policy this taxonomy exists to end.
    const wrapped = new Error('chain abc is stored as lazy layers and could not be mounted', {
      cause: coded('MISSING_CREDENTIALS'),
    });
    expect(classifyRecovery({ cause: wrapped })).toBe('permanent');
  });

  test('an outer classified failure wins over an inner one', () => {
    const wrapped = new Error('abandoned', {
      cause: new ContainerStartOverrun('Devbox.attach', 1),
    });
    // The overrun is the outer fact here only when it IS outermost; wrapped the
    // other way round the inner one still answers, which is the chain walk.
    expect(classifyRecovery({ cause: wrapped })).toBe('abandoned');
  });

  test('a message that merely MENTIONS a classified condition is not classified', () => {
    // The whole reason the codes are the authority: an application error saying
    // "no space left in the plan" is not NO_SPACE, and a taxonomy built on
    // regexes would refuse a box over a sentence.
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
    // Absent means "nothing has failed" and leads to a retry, so reading an
    // unreadable row as absent would restart the ladder every time — and a box
    // that restarts the ladder can destroy its container identity repeatedly.
    const rejected = [
      null, 'retry', 3, {}, [],
      // No owner: a row nothing can be conditioned on.
      { stage: 'retry' },
      // A stage outside the vocabulary, and an owner of the wrong type.
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
    // THE RESET CASE. A container start, an eviction and a replacement all mint
    // a new owner, and none of them may forget how far the ladder has gone.
    expect(admissionStep({ kind: 'row', row: { owner: OWNER } }))
      .toEqual({ admit: true, stage: undefined });
    for (const stage of ['retry', 'replace'] as const) {
      expect(admissionStep({ kind: 'row', row: { owner: OWNER, stage } }))
        .toEqual({ admit: true, stage });
    }
  });

  test('an unreadable row refuses the attempt and normalises to the terminal stage', () => {
    // Refusing is the safe half: nothing is destroyed on evidence nobody can
    // read. Normalising is the other half — a row left unreadable would refuse
    // for ever, and a permanent brick is its own defect.
    expect(admissionStep({ kind: 'malformed' })).toEqual({ admit: false, stage: 'replace' });
  });
});

describe('recovery is one decision per failure, with no count and no timeout', () => {
  const CLASSES: readonly RecoveryClass[] = [
    'abandoned', 'stale-owner', 'exhausted', 'permanent', 'transient', 'unclassified',
  ];
  const STAGES: readonly (RecoveryStage | undefined)[] = [undefined, 'retry', 'replace'];

  test('a superseded attempt is INERT for every class and every stage', () => {
    // KINU-030/031: the stale continuation must not publish readiness, file a
    // failure, re-arm a startup or destroy an identity it did not start on.
    for (const failure of CLASSES) {
      for (const stage of STAGES) {
        expect(recoveryStep({ owned: false, failure, stage }))
          .toEqual({ action: 'inert', stage });
      }
    }
  });

  test('exhaustion refuses, repeats nothing, destroys nothing and moves nothing', () => {
    for (const stage of STAGES) {
      expect(recoveryStep({ owned: true, failure: 'exhausted', stage }))
        .toEqual({ action: 'refuse', stage });
    }
  });

  test('permanent configuration refuses on the first failure', () => {
    // Nothing a retry reaches changes it, so spending the ladder on it would
    // only destroy a container over a mount option.
    for (const stage of STAGES) {
      expect(recoveryStep({ owned: true, failure: 'permanent', stage }))
        .toEqual({ action: 'refuse', stage });
    }
  });

  test('a stale owner retries and does NOT advance the container-fault ladder', () => {
    // The identity it failed on is already gone, so it is no evidence against
    // the one that replaced it.
    for (const stage of STAGES) {
      expect(recoveryStep({ owned: true, failure: 'stale-owner', stage }))
        .toEqual({ action: 'retry', stage });
    }
  });

  test('abandoned work enters at REPLACE, because destruction is its cancellation', () => {
    // KINU-031: the work is `exec` calls inside the container, so no token can
    // fence it. The identity has to go before anything attaches again.
    for (const stage of [undefined, 'retry'] as const) {
      expect(recoveryStep({ owned: true, failure: 'abandoned', stage }))
        .toEqual({ action: 'replace', stage: 'replace' });
    }
  });

  test('a failure at REPLACE is terminal AND KEEPS the stage, so nothing loops', () => {
    // Both halves matter. Terminal stops a second destruction now; keeping the
    // stage stops the next eviction from restarting a destructive ladder from
    // scratch. Only a successful attach clears it.
    for (const failure of CLASSES) {
      expect(recoveryStep({ owned: true, failure, stage: 'replace' }))
        .toEqual({ action: failure === 'stale-owner' ? 'retry' : 'refuse', stage: 'replace' });
    }
  });

  for (const failure of ['transient', 'unclassified'] as const) {
    test(`${failure} walks the ladder once: retry, replace, then refuse for ever`, () => {
      // KINU-032: repeated failure of ONE identity ends by replacing it. The
      // bound is the ladder's length, not a tuned retry count — each stage is a
      // different action, so nothing harmful is repeated. And the walk does not
      // wrap: a fourth failure is still a refusal.
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
    // A response of any kind proves a listener exists. Whether it is happy is a
    // different question and not this one.
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

// ── incidents ───────────────────────────────────────────────────────────────

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

// ── the container-start budget ──────────────────────────────────────────────

describe('readiness is per container, not per Durable Object', () => {
  test('the startup callback turns the lifecycle over before admitting a stopped container', () => {
    const source = readFileSync(join(import.meta.dir, '..', 'src', 'devbox.ts'), 'utf8');
    const startup = source.slice(source.indexOf('async devboxStartup('));
    const body = startup.slice(0, startup.indexOf('\n  }'));
    expect(body).toContain('this.#invalidateGeneration();');
    expect(body).toContain('await this.start(undefined, {');
    const invalidate = source.slice(source.indexOf('#invalidateGeneration(): void {'));
    const reset = invalidate.slice(0, invalidate.indexOf('\n  }'));
    expect(reset).toContain('this.#generation += 1;');
    expect(reset).toContain('this.#startup = undefined;');
    expect(reset).toContain("this.#restoration = { phase: 'unstarted' };");
  });
});

describe('every self-re-arming schedule needs a first link', () => {
  // Three of this class's four schedule rows re-arm themselves, so each one is a
  // chain that runs forever once started and never starts on its own. `onStart`
  // is the one hook that fires per container start, so it is the only place a
  // first link can be. A missing link is silent: the callback exists, its
  // re-arm is correct, and the row simply never appears.
  //
  // Caught live by deployed probe P5: `devboxHeartbeat` re-arms itself at three
  // sites and nothing armed it, so the activity lease never ticked and quiesce
  // was unreachable. The probe's /heartbeatSchedules answered [].
  //
  // Pinned as source shape because the property is about a platform hook no unit
  // harness can fire: there is no way to start a container from a test. What is
  // checked is exactly the rule — `onStart` arms all three.
  const source = readFileSync(join(import.meta.dir, '..', 'src', 'devbox.ts'), 'utf8');
  const bodyOf = (signature: string): string => {
    const from = source.indexOf(signature);
    expect(from).toBeGreaterThan(-1);
    const tail = source.slice(from);
    return tail.slice(0, tail.indexOf('\n  }'));
  };

  test('onStart arms all three self-re-arming rows', () => {
    const schedules = bodyOf('async #armContainerSchedules(');
    for (const callback of ['STARTUP_CALLBACK', 'CHECKPOINT_CALLBACK', 'HEARTBEAT_CALLBACK']) {
      expect(schedules).toContain(`this.#arm(${callback}`);
    }
  });

  test('onStart only arms schedule chains, under the start deadline', () => {
    // Arming is the WHOLE body — no attach, no restore — and it rides the
    // container-start budget because `onStart` runs inside
    // `blockConcurrencyWhile`, whose platform cancel resets the object
    // (scripts/do-init-gate.test.ts holds the routing from the other side).
    const hook = bodyOf('override onStart(');
    expect(hook).toContain('return withContainerStartDeadline(');
    expect(hook).toContain('this.#armContainerSchedules()');
  });

  test('the incident row is armed on demand, not at start', () => {
    // The fourth row is deliberately NOT a start link: an incident schedule with
    // no incidents to deliver is a wakeup that does nothing forever.
    expect(bodyOf('override onStart(')).not.toContain('INCIDENT_CALLBACK');
    expect(source).toContain('this.#arm(INCIDENT_CALLBACK');
  });

  test('quiesce arms NOTHING, so no row outlives the stop', () => {
    // The reconciliation between "the heartbeat must always be armed" and the
    // lease's own rule. Once the box is stopped there is nothing to heartbeat
    // for, and a row that survived would wake a sleeping container forever.
    // The next container start is what re-arms all three.
    const quiesce = bodyOf('async quiesce(');
    expect(quiesce).not.toContain('#arm(');
    expect(quiesce).toContain("this.stop('SIGTERM')");
  });

  test('every self-re-arming callback re-arms through ONE guard, not by hand', () => {
    // This used to count the occurrences of `#arm(HEARTBEAT_CALLBACK)` in the
    // heartbeat and require exactly five, one per path that leaves the box
    // alive. That pin held the right property with the wrong instrument: it
    // could not see a SIXTH path added without a re-arm, it broke on any
    // refactor that did not change behaviour, and it said nothing at all about
    // the other way the chain dies — a throw, which the alarm loop reduces to a
    // console line before deleting the row.
    //
    // Both failures are now one wrapper's job, except a failed container
    // admission: that callback must record its classified refusal and leave a
    // startup successor before it returns. The remaining calls are first links:
    // the container-start hook forges one per self-re-arming chain, the recovery
    // ladder re-arms the startup for the ONE action that asks the same container
    // again, the incident recorder starts delivery on demand, and the guard
    // maintains every chain thereafter.
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
      startupAdmission: armSites(bodyOf('async devboxStartup(')),
      startupRetry: armSites(bodyOf('async #recover(')),
      onKick: armSites(bodyOf('async kickStartup(')),
      onRecord: armSites(bodyOf('async #record(')),
      guard: armSites(bodyOf('async #scheduled(')),
    }).toEqual({
      total: 8, onStart: 3, startupAdmission: 1, startupRetry: 1, onKick: 1, onRecord: 1, guard: 1,
    });
    // And the ONE re-arm is reachable only from the action that means "ask this
    // same identity again". A refusal or a replacement that armed a startup
    // would be the loop the ladder exists to end.
    const recover = bodyOf('async #recover(');
    expect(recover.slice(recover.indexOf("decision.action === 'retry'")))
      .toContain('await this.#arm(STARTUP_CALLBACK');
    expect(bodyOf('async #scheduled(')).toContain('await this.#arm(callback, nextSeconds)');
    // And the guard re-arms after a throw as well as after a return, which is
    // the half the old pin could not express.
    expect(bodyOf('async #scheduled(')).toContain('} catch (error) {');
    // The clock the SDK actually reads is renewed on entry: its alarm chain
    // ends WITHOUT a successor when `sleepAfterMs` passes, so a tick that does
    // not renew it is the last tick there will ever be.
    expect(bodyOf('async devboxHeartbeat(')).toContain('this.renewActivityTimeout();');
  });

  test('the liveness ping passes NO port, because that argument is a port', () => {
    // `containerFetch(request, port)` takes a PORT second, not a timeout. A
    // millisecond value there pointed every ping at a port nothing serves and
    // waited for it to become ready, so every tick took the ping-failed path and
    // the quiesce decision never ran. Omitting it uses the SDK's defaultPort.
    const heartbeat = bodyOf('async devboxHeartbeat(');
    expect(heartbeat).toContain("this.containerFetch(new Request('http://127.0.0.1/'))");
    expect(heartbeat).not.toContain('HEARTBEAT_PING_TIMEOUT');
  });

  test('a replaced container instance is detected and re-driven, not waited on', () => {
    // The platform can reclaim an instance mid-idle and nothing announces it:
    // measured on a deployed probe where the chain ticked healthily through an
    // 11-minute idle while the instance underneath was replaced. The boot id is
    // the only reliable signal, and the tick is the only place it can be read.
    const heartbeat = bodyOf('async devboxHeartbeat(');
    expect(heartbeat).toContain('#readBootId()');
    expect(heartbeat).toContain('this.devboxStartup()');
    // The COUNTER lives where the evidence is, not where it is noticed. Every
    // restoration passes through the stamp, whether the container-start hook or
    // a heartbeat drove it. Counting only in the heartbeat under-reported the
    // case worth measuring: a replacement handled through `onStart` incremented
    // nothing, measured locally as a boot id that changed while the count
    // stayed at zero.
    expect(heartbeat).not.toContain('REPLACED_COUNT_KEY');
    expect(bodyOf('async #stampBootId(')).toContain('REPLACED_COUNT_KEY');
    // The id must die with the instance, or it proves nothing.
    expect(source).toContain("BOOT_ID_PATH = '/tmp/devbox-boot-id'");
  });

  test('keepAlive is never enabled, because it kills the alarm chain', () => {
    // Audited in the SDK source: the activity branch of the container alarm loop
    // returns without setting a successor, and Sandbox.onActivityExpired only
    // LOGS when keepAlive is on. So keepAlive turns a clean stop into a dead
    // chain plus a container the platform reclaims anyway, losing the final
    // checkpoint and every future tick. Probe P5 measured exactly that.
    expect(source).not.toContain('await this.setKeepAlive(');
    // The replacement is the SDK's own expiry hook, which checkpoints first.
    expect(source).toContain('override async onActivityExpired(');
    expect(bodyOf('override async onActivityExpired(')).toContain("checkpoint('quiesce')");
  });
});

describe('arming must ignore the row being dispatched', () => {
  // The container SDK deletes a fired row AFTER its callback returns, so during
  // the callback the firing row is still in the table. A guard that counted
  // every row let a self-re-arming callback see itself, decide it had nothing to
  // do, and get deleted a moment later with the chain dead and no error
  // anywhere. Two deployed probe runs died on it.
  const NOW = 1_700_000_000;

  test('the firing row does not count, so a successor is still armed', () => {
    // Due exactly now, and overdue: both are the dispatch case.
    expect(needsArming([{ time: NOW }], NOW)).toBe(true);
    expect(needsArming([{ time: NOW - 30 }], NOW)).toBe(true);
  });

  test('a genuine future row does count, so a restart does not double the period', () => {
    expect(needsArming([{ time: NOW + 1 }], NOW)).toBe(false);
    expect(needsArming([{ time: NOW + 3_600 }], NOW)).toBe(false);
  });

  test('no rows at all needs arming', () => {
    expect(needsArming([], NOW)).toBe(true);
  });

  test('the firing row alongside a future row does not suppress the future one', () => {
    // The old guard and the new one agree here, and they must: arming again
    // would double the period.
    expect(needsArming([{ time: NOW }, { time: NOW + 60 }], NOW)).toBe(false);
  });

  test('the guard the class uses is this one, not a row count', () => {
    // The whole defect was `length > 0`. Pinned so it cannot come back.
    const devbox = readFileSync(join(import.meta.dir, '..', 'src', 'devbox.ts'), 'utf8');
    const armed = devbox.slice(devbox.indexOf('async #arm('));
    const body = armed.slice(0, armed.indexOf('\n  }'));
    expect(body).toContain('needsArming(');
    expect(body).not.toContain('.length > 0');
  });
});

describe('an incident is written off only when the host says it LANDED', () => {
  /** The ledger, as the class's storage presents it to `deliverIncidents`: the
   *  rows a test reads back, and the four operations the delivery pass uses. */
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
    // THE DEFECT: a host that could not announce an incident still answered
    // `queued`, this side stamped `deliveredAt`, and the box stopped retrying an
    // incident nobody had seen — while the host's own ledger still held it as
    // re-deliverable. Only a landed announcement may write the row off.
    const { rows, store } = ledger();
    await recordIncident(store, 'attach', 'the mount refused');
    const answers: IncidentDisposition[] = ['undelivered', 'queued'];
    const ordinals: number[] = [];
    const answer = async (_incident: DevboxIncident, attempt: number): Promise<IncidentDisposition> => {
      ordinals.push(attempt);
      return answers.shift() ?? 'queued';
    };

    const retryIn = await deliverIncidents(store, answer);

    // Pending, counted, and a retry scheduled.
    expect(retryIn).not.toBeNull();
    const pending = only(rows);
    expect({
      attempts: pending?.attempts,
      delivered: pending?.deliveredAt,
      rejected: pending?.rejectedAt,
    }).toEqual({ attempts: 1, delivered: undefined, rejected: undefined });

    const settled = await deliverIncidents(store, answer);

    // The second pass announced it, so nothing is left to wake for.
    expect(settled).toBeNull();
    expect(only(rows)?.deliveredAt).toBeNumber();
    // Each pass told the host which announcement it was making.
    expect(ordinals).toEqual([1, 2]);
  });

  test('a THROWN handler is the same case, not a special one', async () => {
    // The disposition's own contract says a throw is `undelivered`, so it takes
    // that path rather than a copy of it.
    const { rows, store } = ledger();
    await recordIncident(store, 'checkpoint', 'the commit failed');
    const retryIn = await deliverIncidents(store, () => {
      throw new Error('the host was unreachable');
    });
    expect(retryIn).not.toBeNull();
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
  test('work that finishes inside the budget resolves normally', async () => {
    const done = await withContainerStartDeadline(
      't', openStartBudget(25_000), () => Promise.resolve('ok'), () => {},
    );
    expect(done).toBe('ok');
  });

  test('work that overruns is abandoned, and its late failure is still reported', async () => {
    const late: string[] = [];
    const { promise: work, reject: failWork } = Promise.withResolvers<never>();
    const run = withContainerStartDeadline('t', openStartBudget(0), () => work, failure => {
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
    await expect(withContainerStartDeadline(
      't', openStartBudget(25_000), () => Promise.reject(new Error('bad layer')),
      failure => { late.push(describeThrown({ cause: failure.cause })); },
    )).rejects.toThrow('bad layer');
    expect(late).toEqual([]);
    expect(classifyRecovery({ cause: new Error('bad layer') })).not.toBe('abandoned');
  });

  test('the remainder only ever falls', async () => {
    // ONE CLOCK FOR THE WHOLE RESTORATION. Every phase after the attach used to
    // run outside any budget, and the listener proof carried a window per port,
    // so three silent ports added about ninety seconds and nothing bounded the
    // sum.
    const budget = openStartBudget(25_000);
    const first = budget.remainingMs();
    await Promise.resolve();
    const second = budget.remainingMs();
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThanOrEqual(25_000);
    expect(second).toBeLessThanOrEqual(first);
  });

  test('a spent budget answers zero rather than a negative remainder', () => {
    // A step that clamps its own wait on this must never be handed a negative
    // window, which would make `Date.now() + remaining` a deadline in the past
    // for one caller and a wait forever for another.
    expect(openStartBudget(0).remainingMs()).toBe(0);
    expect(openStartBudget(-5).remainingMs()).toBe(0);
  });

  test('the allowance divides what is left by the work still declared', () => {
    // NOT THE PORTS ALONE. Every step of the restoration is declared — each
    // probe, each exposure and the boot stamp — so a port's probe cannot spend
    // what its own exposure and the stamp still need. Nothing is reserved: the
    // last step is welcome to the whole remainder.
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
    // The post-attach policy, and the whole point of the split: a listener that
    // never answers or a process that will not start must not look like an
    // abandoned attach, because the container is fine and replacing it would
    // destroy a healthy box over a slow app.
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
    // The post-attach policy again: a walk that threw here would abandon the
    // rest of the restoration over one dead spec, and the caller wants a reason
    // it can put in `unready` rather than an exception.
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
    // The recovery for abandoned work is not a retry: the work is still running
    // inside the container, where no token can reach it, so the identity is
    // replaced instead. That decision is made from the class of the thrown
    // value, so the class is the contract — a caller matching the sentence
    // would silently stop recognising it the day the sentence is reworded.
    let overrun: { readonly cause: unknown } | undefined;
    try {
      await withContainerStartDeadline(
        'Devbox.attach', openStartBudget(0),
        () => Promise.withResolvers<never>().promise, () => {},
      );
    } catch (error) {
      overrun = { cause: error };
    }
    expect(overrun?.cause).toBeInstanceOf(ContainerStartOverrun);
    expect(classifyRecovery(overrun ?? { cause: undefined })).toBe('abandoned');
    expect(recoveryStep({ owned: true, failure: 'abandoned', stage: undefined }))
      .toEqual({ action: 'replace', stage: 'replace' });
  });
});

// ── mount facts ─────────────────────────────────────────────────────────────

describe('mount facts — the kernel is asked, not a marker', () => {
  test('DEPLOYED DEFECT: a fuse-overlayfs mount reads as mounted with NO dir options', () => {
    // A deployed container answered "produced an overlay whose upper directory
    // (unnamed) does not exist" because an earlier version parsed `upperdir` out
    // of the mount line. fuse-overlayfs never publishes it. Both overlay
    // families must read as mounted, and neither answer may depend on options.
    expect(isOverlayMounted(OVERLAY_MOUNTS, '/workspace')).toBe(true);
    expect(isOverlayMounted(KERNEL_OVERLAY_MOUNTS, '/workspace')).toBe(true);
    expect(OVERLAY_MOUNTS).not.toContain('upperdir');
  });

  test('an octal-escaped space in the mountpoint survives the parse', () => {
    const escaped = 'fuse-overlayfs /my\\040box fuse.fuse-overlayfs rw 0 0';
    expect(isOverlayMounted(escaped, '/my box')).toBe(true);
  });

  test('a non-overlay mount at the same path is NOT an overlay', () => {
    // This is the whole reason the fstype is checked: an s3fs mount at
    // /workspace is a real mount and a real filesystem, and reading it as an
    // overlay would make the chain archive a directory that has no upper.
    expect(isOverlayMounted(FUSE_MOUNTS, '/workspace')).toBe(false);
    expect(isS3fsMounted(FUSE_MOUNTS, '/workspace')).toBe(true);
    // And the reverse, which a bare `fuse` test would get wrong: fuse-overlayfs
    // reports `fuse.fuse-overlayfs`, so each strategy would claim the other's
    // box.
    expect(isS3fsMounted(OVERLAY_MOUNTS, '/workspace')).toBe(false);
  });

  test('nothing mounted reads as nothing mounted, for both strategies', () => {
    expect(isOverlayMounted(NO_MOUNTS, '/workspace')).toBe(false);
    expect(isS3fsMounted(NO_MOUNTS, '/workspace')).toBe(false);
    expect(findMount(NO_MOUNTS, '/workspace')).toBeUndefined();
    expect(findMount(NO_MOUNTS, '/')?.fstype).toBe('ext4');
  });
});

// ── identity ────────────────────────────────────────────────────────────────

describe('chain identity — UUID keys refuse traversal by construction', () => {
  test('only a UUID is a chain id', () => {
    for (const bad of [
      '../../etc', '', 'backups/x/data.sqsh', 'a/b/c/d-e-f-g-h',
      'ZZZZZZZZ-0000-4000-8000-000000000009', `${CHAIN_ID}/..`, ` ${CHAIN_ID}`,
    ]) {
      expect(isChainId(bad)).toBe(false);
      expect(() => assertChainId(bad)).toThrow(/is not a UUID/);
    }
    expect(isChainId(CHAIN_ID)).toBe(true);
    expect(assertChainId(CHAIN_ID)).toBe(CHAIN_ID);
  });

  test('every key builder validates, so no path can be assembled from a guess', () => {
    for (const build of [baseObjectKey, deltaObjectKey, metadataObjectKey]) {
      expect(() => build('../../etc/passwd')).toThrow(/is not a UUID/);
      expect(build(CHAIN_ID)).toStartWith(`backups/${CHAIN_ID}/`);
    }
    // Three distinct objects under one prefix, so a discard can name all of
    // them and a delta can be replaced without touching the base.
    const keys = [baseObjectKey(CHAIN_ID), deltaObjectKey(CHAIN_ID), metadataObjectKey(CHAIN_ID)];
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
    // A sound row parses, and every field survives the parse.
    const sound = { mode: 'chain', rev: 2, base: { id: CHAIN_ID, bytes: 9 }, at: 5 };
    expect(normalizeChainState(sound)).toEqual({
      mode: 'chain', rev: 2, at: 5,
      base: { id: CHAIN_ID, bytes: 9, digest: undefined, objectVersion: undefined },
      delta: undefined, changeVersion: undefined, upperMark: undefined, orphans: undefined,
      fallback: undefined, lastFailure: undefined,
    });
    // A row written before layer identities existed parses with both absent,
    // which reads as UNKNOWN rather than unsound: those rows are live, and
    // refusing them would be the data loss the chain exists to prevent.
    expect(normalizeChainState(sound)?.base.digest).toBeUndefined();
    expect(normalizeChainState(sound)?.base.objectVersion).toBeUndefined();
    // Identities that ARE there survive, and a digest that is not 64 lowercase
    // hex characters takes the row down rather than being carried as something
    // nothing can compare. The store's version is the store's own format, so it
    // is asked only to be a non-empty string.
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
    // A retained fallback survives it too, delta and all: a candidate the
    // reader cannot check is a candidate a restore cannot use.
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
    // And a fallback whose id is not a UUID takes the whole row down, for the
    // same reason a bad `base` does: every object key is built from one.
    expect(normalizeChainState({ ...sound, fallback: { base: { id: 'nope', bytes: 7 } } }))
      .toBeNull();
  });
});

// ── integrity and the interval gate ─────────────────────────────────────────

describe('integrity probe — each unsound shape names itself', () => {
  /** A layer known only by its size, which is every row that predates the
   *  content digest and the store version. */
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
    // Agreement is sound, and so is a digest the store cannot answer for: R2
    // reports one only for an object it was given a checksum for, and UNKNOWN
    // must not read as unsound or every multipart archive would be refused.
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
    // A record written before digests existed is UNKNOWN in the other
    // direction, and those rows are live: `Devbox.strategy` defaults to the
    // chain and the product's sandbox class is deployed on it.
    expect(layerIntegrityFailure({
      declared: { bytes: 4_096, digest: undefined, objectVersion: undefined },
      stored: { bytes: 4_096, digest: other, objectVersion: undefined },
      label: 'base',
    })).toBeNull();
  });

  test('KINU-N025: with no digest to compare, a different store version is a DIFFERENT '
    + 'upload', () => {
      // The multipart case, which no checksum can reach: the Workers multipart
      // API takes none, so R2 reports no digest for a large archive. What it
      // always reports is the version it minted for the upload that wrote the
      // object, so that is what catches a replacement carrying identical length
      // — even one whose own digest metadata was written to match.
      const big = 512 * 1024 * 1024;
      const refusal = layerIntegrityFailure({
        declared: { bytes: big, digest: undefined, objectVersion: 'upload-one' },
        stored: { bytes: big, digest: undefined, objectVersion: 'upload-two' },
        label: 'base',
      });
      expect(refusal).toContain('written by a different upload');
      expect(refusal).toContain('upload-one');
      expect(refusal).toContain('upload-two');
      // The same object passes: same size, same version, no digest either side,
      // which is exactly what a sound multipart archive looks like.
      expect(layerIntegrityFailure({
        declared: { bytes: big, digest: undefined, objectVersion: 'upload-one' },
        stored: { bytes: big, digest: undefined, objectVersion: 'upload-one' },
        label: 'base',
      })).toBeNull();
      // And a pre-version row is UNKNOWN, not unsound.
      expect(layerIntegrityFailure({
        declared: { bytes: 4_096, digest: undefined, objectVersion: undefined },
        stored: { bytes: 4_096, digest: undefined, objectVersion: 'upload-two' },
        label: 'base',
      })).toBeNull();
    });

  test('KINU-N025: agreeing content outranks a new store version, because a re-upload '
    + 'is not a replacement', () => {
      // A version is minted per UPLOAD, not per content. This chain can re-put
      // byte-identical bytes: a write under an excluded path moves the skip-gate
      // fingerprint while the archive bytes stay the same, so a commit whose
      // state write is then lost to a crash leaves the store one version ahead
      // of the record with the SAME content. Refusing that would spend the
      // fallback on a healthy object, so agreement on content wins and the
      // version is only consulted when no digest can decide.
      const digest = 'a'.repeat(64);
      expect(layerIntegrityFailure({
        declared: { bytes: 4_096, digest, objectVersion: 'upload-one' },
        stored: { bytes: 4_096, digest, objectVersion: 'upload-two' },
        label: 'delta',
      })).toBeNull();
      // Disagreeing content is still a refusal, whatever the versions say.
      expect(layerIntegrityFailure({
        declared: { bytes: 4_096, digest, objectVersion: 'upload-one' },
        stored: { bytes: 4_096, digest: 'b'.repeat(64), objectVersion: 'upload-one' },
        label: 'delta',
      })).toContain('different archive of the same length');
    });
});

describe('the checkpoint interval gate', () => {
  const interval = DEFAULT_DEVBOX_POLICY.checkpointIntervalMs;

  test('an unchanged directory is never archived, however long it has been', () => {
    expect(shouldCheckpoint('unchanged', 0, Number.MAX_SAFE_INTEGER, interval)).toBe(false);
  });

  test('a change inside the interval waits; on the boundary it commits', () => {
    expect(shouldCheckpoint('changed', 1_000, 1_000 + interval - 1, interval)).toBe(false);
    expect(shouldCheckpoint('changed', 1_000, 1_000 + interval, interval)).toBe(true);
  });

  test('lost change state counts as changed, because it cannot prove otherwise', () => {
    expect(shouldCheckpoint('resync', 0, interval, interval)).toBe(true);
  });
});

describe('archive options', () => {
  test('derived trees never travel, git metadata always does, and the archive '
    + 'outlives a long weekend', () => {
    const options = chainBackupOptions(false, CHAIN_EXCLUDES);
    expect(options.dir).toBe('/workspace');
    expect(options.excludes).toContain('node_modules');
    // `.git` holds the only copy of an unpushed commit, and for a linked
    // worktree the only thing that makes the tree a repository. It is not
    // reproducible from a lockfile, which is the only test this list applies.
    expect(options.excludes).not.toContain('.git');
    // The SDK's own default is three days and it is enforced at restore time,
    // so a shorter TTL is a box that refuses to come back after a break.
    expect(options.ttl).toBeGreaterThanOrEqual(7 * 24 * 60 * 60);
    expect(chainBackupOptions(true, CHAIN_EXCLUDES).localBucket).toBe(true);
  });

  test('the excludes come from the caller, so both modes obey one policy', () => {
    // This function used to spell CHAIN_EXCLUDES itself while the chain path
    // asked the box for `archiveExcludes`, so a box that replaced the policy was
    // obeyed in one mode and ignored in the other.
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
  test('missing and unknown strategy names never become snapshot-chain', () => {
    expect(parseDevboxStrategyName(undefined)).toBeNull();
    expect(parseDevboxStrategyName(null)).toBeNull();
    expect(parseDevboxStrategyName('unknown')).toBeNull();
    expect(parseDevboxStrategyName('overlay-cas')).toBe('overlay-cas');
  });

  test('the deployed worker routes through the fail-closed parser', () => {
    const worker = readFileSync(join(import.meta.dir, '../bench/worker.ts'), 'utf8');
    expect(worker).toContain('const strategy = parseDevboxStrategyName(requested);');
    expect(worker).toContain('if (strategy === null)');
    expect(worker).not.toContain(": 'snapshot-chain';");
  });
});

describe('the storage dispatch is exhaustive over the strategy union', () => {
  // A Durable Object cannot be constructed in a unit test, so this is pinned as
  // source shape for the same reason `onStart`'s arming is. The rule is what
  // matters: every name the union admits has an EXPLICIT arm in `#buildStorage`.
  //
  // The defect it exists for is silence, not a crash. The dispatch used to end
  // in `: snapshotChainStorage(...)`, so a strategy nobody had wired still
  // produced a working box — the chain, wearing the other strategy's name. A
  // benchmark arm in that state reports a full column of numbers that are the
  // chain measured twice, and nothing looks wrong anywhere.
  const devboxSource = readFileSync(join(import.meta.dir, '..', 'src', 'devbox.ts'), 'utf8');
  const storageSource = readFileSync(join(import.meta.dir, '..', 'src', 'storage.ts'), 'utf8');
  const dispatch = (() => {
    // The DECLARATION, not the call in `#requireStorage` a few lines above it:
    // matching the bare name found the call site and sliced the wrong method.
    const from = devboxSource.indexOf('\n  #buildStorage(');
    const tail = devboxSource.slice(from);
    return tail.slice(0, tail.indexOf('\n  }'));
  })();

  /** The union, read from its declaration rather than restated here: a member
   *  added there must show up as a missing arm, not as a stale duplicate. */
  const strategies = [...(
    /export type DevboxStrategyName =([^;]+);/.exec(storageSource)?.[1] ?? ''
  ).matchAll(/'([^']+)'/g)].map(match => match[1]!);

  test('the union is read, not restated', () => {
    expect(strategies.length).toBeGreaterThan(1);
    expect(strategies).toContain('snapshot-chain');
  });

  test('every strategy the union admits is dispatched explicitly', () => {
    const unwired = strategies.filter(name => !dispatch.includes(`=== '${name}'`));
    expect(unwired).toEqual([]);
  });

  test('an unrecognised strategy is refused by name, never served as the chain', () => {
    expect(dispatch).toContain('throw new Error(');
    // The refusal names what it did not recognise, or a reader cannot tell
    // which of three strategies the box was actually asked for.
    expect(dispatch).toContain('${String(this.strategy)}');
    // And no arm is reachable by falling through to it.
    expect(dispatch).not.toContain(': snapshotChainStorage(');
  });
});

// ── accepted review findings ────────────────────────────────────────────────

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

describe('the checkpoint lane — one strategy checkpoint at a time', () => {
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
    // A quiesce that joined an in-flight tick could inherit a `skipped` answer
    // and stop the container over work that only just landed; it waits and
    // runs its own final commit instead.
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

// ── incident ledger retention ───────────────────────────────────────────────

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

function seedIncident(store: ReturnType<typeof fakeIncidentStore>, id: string): void {
  store.rows.set(`devbox:incident:${id}`, {
    incidentId: id, stage: 'checkpoint', reason: 'r',
    processId: undefined, port: undefined, at: 0, attempts: 0,
  });
}

describe('incident ledger retention — delivered rows are bounded, pending never dropped', () => {
  test('reaping keeps the newest settled rows within the cap and every pending row', async () => {
    const box = fakeIncidentStore();
    for (let at = 0; at < INCIDENT_LEDGER_MAX_ROWS + 50; at += 1) {
      seedIncident(box, `d${String(at).padStart(4, '0')}`);
      const row = box.rows.get(`devbox:incident:d${String(at).padStart(4, '0')}`)!;
      box.rows.set(row.incidentId && `devbox:incident:${row.incidentId}`, {
        ...row, deliveredAt: at,
      });
    }
    for (let p = 0; p < 5; p += 1) seedIncident(box, `pending${p}`);

    const deleted = await reapDeliveredIncidents(box.store);

    expect(deleted).toBe(55);
    expect(box.rows.size).toBe(INCIDENT_LEDGER_MAX_ROWS);
    // Oldest DELIVERED go first...
    expect(box.rows.has('devbox:incident:d0000')).toBe(false);
    expect(box.rows.has('devbox:incident:d0054')).toBe(false);
    expect(box.rows.has(`devbox:incident:d${String(55).padStart(4, '0')}`)).toBe(true);
    // ...and PENDING is never a candidate, however far over the cap they push.
    for (let p = 0; p < 5; p += 1) {
      expect(box.rows.has(`devbox:incident:pending${p}`)).toBe(true);
    }
  });

  test('recording goes through the shared writer bound to INCIDENT_REASON_MAX_CHARS', () => {
    // The producer once hardcoded its own literal here while the exported
    // constant claimed producer and validator "cannot drift". The class now
    // calls recordIncident itself.
    const source = readFileSync(join(import.meta.dir, '..', 'src', 'devbox.ts'), 'utf8');
    const from = source.indexOf('async #record(');
    const body = source.slice(from, source.indexOf('\n  }', from));
    expect(body).toContain('recordIncident(this.ctx.storage');
    expect(body).not.toContain('.slice(0, 2000)');
    expect(source).not.toContain('reason.slice(0, 2000)');
  });
});

// ── ambient checkpoints and the serialization point ─────────────────────────

describe('ambient checkpoints belong to product boxes, never the bench fixture', () => {
  const devboxSource = readFileSync(join(import.meta.dir, '..', 'src', 'devbox.ts'), 'utf8');
  const workerSource = readFileSync(
    join(import.meta.dir, '..', 'bench', 'worker.ts'), 'utf8',
  );

  test('the schedule is armed and re-armed only behind the seam', () => {
    const schedules = devboxSource.slice(
      devboxSource.indexOf('async #armContainerSchedules('),
      devboxSource.indexOf('\n  }', devboxSource.indexOf('async #armContainerSchedules(')),
    );
    expect(schedules).toContain('if (this.ambientCheckpoints)');
    const scheduled = devboxSource.slice(
      devboxSource.indexOf('async devboxCheckpoint('),
      devboxSource.indexOf('\n  }', devboxSource.indexOf('async devboxCheckpoint(')),
    );
    expect(scheduled).toContain('if (!this.ambientCheckpoints) return;');
  });

  test('the bench box disables it; the interval gate still guards driver ticks', () => {
    expect(workerSource).toContain('protected override get ambientCheckpoints(): boolean');
    expect(workerSource).toContain('return false;');
    // policy.checkpointIntervalMs stays — it is the guard the driver waits out.
    expect(devboxSource).toContain('this.policy.checkpointIntervalMs / 1000');
  });

  test('every strategy checkpoint funnels through ONE lane call site', () => {
    // Two overlapping runs would share staging directories and stamp
    // overlapping journal sequences; the funnel makes that unrepresentable.
    const direct = [...devboxSource.matchAll(/#requireStorage\(\)\.checkpoint\(/g)].length;
    expect(direct).toBe(1);
    expect(devboxSource).toContain('#lane.run(kind, async () => await this.#withStorageMutation(async () => {');
    for (const entry of ['async checkpointNow(', 'async quiesce(', 'async devboxCheckpoint(',
      'override async onActivityExpired(']) {
      const at = devboxSource.indexOf(entry);
      const body = devboxSource.slice(at, at + 2_000);
      expect(body).toContain('#checkpoint(');
    }
  });
});
