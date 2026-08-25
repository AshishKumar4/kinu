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
import { DEVBOX_RUNTIME_DIR } from '../src/storage';
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
  quiesceStep,
  restartPlan,
  withContainerStartDeadline,
  type PortExposureSpec,
  type SupervisedProcessSpec,
} from '../src/lifecycle';
import {
  assertChainId,
  baseObjectKey,
  chainBackupOptions,
  deltaObjectKey,
  isChainId,
  layerIntegrityFailure,
  metadataObjectKey,
  normalizeChainState,
  isOverlayMounted,
  shouldCheckpoint,
} from '../src/snapshot-chain';
import { isS3fsMounted } from '../src/r2fs';

const CHAIN_ID = 'a1b2c3d4-0000-4000-8000-000000000001';

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

  test('every process start precedes every listener probe, which precedes exposure', () => {
    const kinds = restartPlan(procs, ports).map(op => op.kind);
    expect(kinds.lastIndexOf('start-process')).toBeLessThan(kinds.indexOf('await-port'));
    expect(kinds.indexOf('await-port')).toBeLessThan(kinds.indexOf('expose-port'));
  });

  test('each port is probed immediately before it is exposed, in ascending order', () => {
    const ops = restartPlan(procs, ports);
    const pairs = ops
      .filter(op => op.kind !== 'start-process')
      .map(op => (op.kind === 'await-port' ? `probe:${op.port}` : `expose:${op.spec.port}`));
    expect(pairs).toEqual(['probe:3000', 'expose:3000', 'probe:8080', 'expose:8080']);
  });

  test('a port is re-exposed with its PERSISTED token, so its URL is unchanged', () => {
    const exposed = restartPlan([], ports)
      .filter((op): op is Extract<typeof op, { kind: 'expose-port' }> => op.kind === 'expose-port');
    expect(exposed.map(op => op.spec.token)).toEqual(['tok3000', 'tok8080']);
  });

  test('nothing registered means an empty plan, not a plan of no-ops', () => {
    expect(restartPlan([], [])).toEqual([]);
  });

  test('two specs for one port collapse to one probe and one exposure', () => {
    const duplicated: readonly PortExposureSpec[] = [
      { port: 8080, name: 'first', token: 'a', createdAt: 1 },
      { port: 8080, name: 'second', token: 'b', createdAt: 2 },
    ];
    const ops = restartPlan([], duplicated);
    expect(ops).toHaveLength(2);
    // Last write wins, which matches the storage the specs came from.
    expect(ops[1]).toEqual({ kind: 'expose-port', spec: duplicated[1] });
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
  test('the reset happens in the one hook that fires per container start', () => {
    // A Durable Object outlives the containers it drives. If a readiness flag
    // survives a container recycle, the gate that exists to wait for the attach
    // returns immediately and every operation runs against a blank disk while
    // the object believes it is restored. Measured on a deployed probe.
    //
    // Pinned as source shape because the condition is a platform lifetime
    // relationship that no unit harness can express: there is no way to recycle
    // a container from a test. The rule is that `onStart` clears the flags.
    const source = readFileSync(join(import.meta.dir, '..', 'src', 'devbox.ts'), 'utf8');
    const hook = source.slice(source.indexOf('override onStart('));
    const body = hook.slice(0, hook.indexOf('\n  }'));
    expect(body).toContain('this.#ready = false;');
    expect(body).toContain('this.#attachFailure = undefined;');
    expect(body).toContain('this.#startup = undefined;');
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
    const onStart = bodyOf('override onStart(');
    for (const callback of ['STARTUP_CALLBACK', 'CHECKPOINT_CALLBACK', 'HEARTBEAT_CALLBACK']) {
      expect(onStart).toContain(`this.#arm(${callback}`);
    }
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
    // Both failures are now one wrapper's job, so the property is that nothing
    // re-arms outside it. `#arm` has exactly four callers, and each is a
    // different kind of first link: the container-start hook forges one per
    // self-re-arming chain, the startup callback re-arms ITSELF on failure
    // (it is also called straight from the readiness gate, where its throw has
    // to reach the caller, so it cannot live behind the guard), the incident
    // recorder starts the delivery chain on demand, and the guard maintains
    // every chain thereafter.
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
      onStart: armSites(bodyOf('override onStart(')),
      startupRetry: armSites(bodyOf('async devboxStartup(')),
      onRecord: armSites(bodyOf('async #record(')),
      guard: armSites(bodyOf('async #scheduled(')),
    }).toEqual({ total: 6, onStart: 3, startupRetry: 1, onRecord: 1, guard: 1 });
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

describe('the attach budget', () => {
  test('work that finishes inside the budget resolves normally', async () => {
    expect(await withContainerStartDeadline('t', 25_000, () => Promise.resolve('ok'), () => {}))
      .toBe('ok');
  });

  test('work that overruns is abandoned, and its late failure is still reported', async () => {
    const late: string[] = [];
    const { promise: work, reject: failWork } = Promise.withResolvers<never>();
    const run = withContainerStartDeadline('t', 0, () => work, failure => {
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
      't', 25_000, () => Promise.reject(new Error('bad layer')),
      failure => { late.push(describeThrown({ cause: failure.cause })); },
    )).rejects.toThrow('bad layer');
    expect(late).toEqual([]);
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
      mode: 'chain', rev: 2, base: { id: CHAIN_ID, bytes: 9 }, at: 5,
      delta: undefined, changeVersion: undefined, upperMark: undefined, orphans: undefined,
      lastFailure: undefined,
    });
  });
});

// ── integrity and the interval gate ─────────────────────────────────────────

describe('integrity probe — each unsound shape names itself', () => {
  test('the four ways a stored layer can be unusable', () => {
    expect(layerIntegrityFailure({ declaredBytes: undefined, storedBytes: 1, label: 'base' }))
      .toContain('declares no size');
    expect(layerIntegrityFailure({ declaredBytes: 1, storedBytes: undefined, label: 'base' }))
      .toContain('missing from the store');
    expect(layerIntegrityFailure({ declaredBytes: 0, storedBytes: 0, label: 'delta' }))
      .toContain('declares 0 bytes');
    expect(layerIntegrityFailure({ declaredBytes: 10, storedBytes: 11, label: 'delta' }))
      .toContain('11 bytes, state declares 10');
    expect(layerIntegrityFailure({ declaredBytes: 10, storedBytes: 10, label: 'base' }))
      .toBeNull();
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
  test('derived trees never travel, and the archive outlives a long weekend', () => {
    const options = chainBackupOptions(false);
    expect(options.dir).toBe('/workspace');
    expect(options.excludes).toContain('node_modules');
    expect(options.excludes).toContain('.git');
    // The SDK's own default is three days and it is enforced at restore time,
    // so a shorter TTL is a box that refuses to come back after a break.
    expect(options.ttl).toBeGreaterThanOrEqual(7 * 24 * 60 * 60);
    expect(chainBackupOptions(true).localBucket).toBe(true);
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
