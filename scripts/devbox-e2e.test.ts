/**
 * The lifecycle suite's oracle, proved without a deployment.
 *
 * The suite itself needs a Cloudflare account, five container instances and
 * about twenty minutes. What decides its verdicts does not: a ceiling that
 * fires, a digest that differs, a deletion that came back, a flushed write that
 * did not. Each of those is proved here against a seam standing in for the
 * deployed fixture, in milliseconds — because an oracle whose red direction is
 * only ever exercised by a deployment is an oracle nobody has seen fail.
 *
 * The deployed half — that these seams reach a real container and that a real
 * arm's checkpoint can be wedged — is `--wedge` on a live run, recorded in the
 * suite's own artifact.
 */

import { describe, expect, test } from 'bun:test';
import {
  CALIBRATION_CEILING_MS, CEILINGS, ceilingFor, ceilingsFor, deployedSeam, proposedCeilings,
  runLifecycle, wedgedSeam,
  type ExecOutcome, type LifecycleOp, type LifecycleSeam, type OperationCeiling,
  type SettleOutcome, type StartupOutcome, type StrategyVerdict,
} from './devbox-e2e';
import { COLD_ATTACH_CEILING_MS, type Strategy } from './bench-devbox-strategies';

/** Every ceiling at one small value, so a test that proves a ceiling FIRES
 *  costs milliseconds and a test that proves one does not fire has room. */
function ceilingsAt(ms: number): OperationCeiling[] {
  return CEILINGS.map((ceiling) => ({ op: ceiling.op, ms, source: 'test' }));
}

/**
 * One deliberately broken thing about the container, per fault.
 *
 * Every field is a defect a real strategy has shipped or could ship, named so a
 * failing test says which one it was standing in for: a tree that comes back
 * different, a deletion the restore undoes, flushed bytes that vanish with the
 * container, and a file the box never really wrote.
 */
interface FakeFaults {
  /** The tree the wake restores is not the tree that was checkpointed. */
  readonly driftTree?: boolean;
  /** Files deleted before the checkpoint that the restore brings back. */
  readonly resurrect?: readonly string[];
  /** The bytes a writer flushed before the checkpoint do not come back. */
  readonly loseOpenWrite?: boolean;
  /** The marker the driver wrote comes back as something else. */
  readonly forgetMarker?: boolean;
}

interface FakeSeam {
  readonly seam: LifecycleSeam;
  readonly asked: string[];
  readonly written: string[];
  teardowns: number;
}

/**
 * A seam that answers every route the lifecycle drives, in the fixture's own
 * wire shapes.
 *
 * It answers JSON on stdout rather than typed objects, because the lifecycle
 * DECODES what a container prints and a typed stub would skip the decoding this
 * suite depends on. It also remembers what it was told: the marker's bytes and
 * the open write's bytes are generated per run by the lifecycle, so a fake that
 * answered constants would let a strategy pass by echoing something it never
 * stored — which is the defect the per-run values exist to catch.
 */
function fakeSeam(faults: FakeFaults = {}, overrides: Partial<LifecycleSeam> = {}): FakeSeam {
  const asked: string[] = [];
  const written: string[] = [];
  let digest = 'digest-after-small';
  let files = 128;
  let bytes = 922_624;
  let marker = '';
  let openWrite = '';
  /** The container has been recycled at least once: everything the restore is
   *  judged on is read after this flips. */
  let woken = false;
  const fake: FakeSeam = {
    asked,
    written,
    teardowns: 0,
    seam: {
      startup: async (kick, _operation, allowed): Promise<StartupOutcome> => {
        asked.push(`startup ${kick}`);
        if (kick === '/wake') woken = true;
        return { ms: 1, kind: allowed[0] ?? 'attached', detail: 'the work directory is mounted' };
      },
      checkpoint: async (): Promise<SettleOutcome> => {
        asked.push('checkpoint');
        return { ms: 2, ok: true, detail: 'committed' };
      },
      stop: async (): Promise<SettleOutcome> => {
        asked.push('stop');
        return { ms: 3, ok: true, detail: 'stopped' };
      },
      exec: async (command): Promise<ExecOutcome> => {
        asked.push(command);
        const reply = (body: Record<string, string | number | boolean | readonly string[]>): ExecOutcome =>
          ({ exitCode: 0, stdout: JSON.stringify({ ok: true, ...body }), stderr: '' });
        if (command.includes('test -f')) return { exitCode: 0, stdout: 'YES', stderr: '' };
        if (command.includes('hold-open')) {
          openWrite = /--content (\S+)/.exec(command)?.[1] ?? '';
          return { exitCode: 0, stdout: 'spawned', stderr: '' };
        }
        if (command.includes('mkdir -p')) return { exitCode: 0, stdout: '', stderr: '' };
        if (command.includes('workload.ts small')) return reply({ files: 128, bytes: 922_624 });
        if (command.includes('workload.ts npm')) {
          digest = 'digest-after-npm';
          files = 2_801;
          bytes = 32_530_944;
          return reply({ files: 2_675, bytes: 31_610_368 });
        }
        if (command.includes('workload.ts delete')) return reply({ removed: [], present: [] });
        if (command.includes('workload.ts digest')) {
          return woken && faults.driftTree === true
            ? reply({ files, bytes: bytes - 1, digest: 'digest-of-something-else' })
            : reply({ files, bytes, digest });
        }
        if (command.includes('workload.ts absent')) {
          const back = woken ? faults.resurrect ?? [] : [];
          return back.length === 0
            ? reply({ resurrected: [] })
            : { exitCode: 1, stdout: JSON.stringify({ ok: false, resurrected: back }), stderr: '' };
        }
        if (command.includes('--path marker.txt')) {
          const answer = woken && faults.forgetMarker === true ? 'devbox-e2e-a-different-run' : marker;
          return reply({ exists: true, bytes: answer.length, content: answer });
        }
        if (command.includes(`--path ${OPEN_WRITE_FILE}`)) {
          const answer = woken && faults.loseOpenWrite === true ? '' : openWrite;
          return reply({ exists: answer.length > 0, bytes: answer.length, content: answer });
        }
        return reply({});
      },
      write: async (path, content): Promise<void> => {
        written.push(path);
        if (path.endsWith('marker.txt')) marker = content;
      },
      teardown: async (): Promise<void> => { fake.teardowns += 1; },
      ...overrides,
    },
  };
  return fake;
}

/** The file the lifecycle holds open across the recycle, as it names it. */
const OPEN_WRITE_FILE = 'open-write.bin';

/** The lifecycle, driven against a fake, with everything it needs stated. */
async function drive(
  fake: FakeSeam, ceilings: OperationCeiling[], strategy: Strategy = 'r2fs',
): Promise<StrategyVerdict> {
  return await runLifecycle(strategy, `ab-${strategy}-test`, fake.seam, {
    ceilings,
    seed: 'test',
    midScaleMib: 30,
    workloadSource: '// workload',
    log: () => {},
  });
}

describe('the ceilings are traceable', () => {
  test('every lifecycle operation declares one, with the measurement it came from', () => {
    const ops: LifecycleOp[] = [
      'cold-attach', 'small-workload', 'checkpoint-small', 'stop-small', 'wake-attach',
      'restore-verify', 'mid-workload', 'checkpoint-mid', 'stop-mid', 'cold-reattach',
      'reattach-verify', 'teardown',
    ];
    for (const op of ops) {
      const ceiling = ceilingFor(op, CEILINGS);
      expect(ceiling.ms).toBeGreaterThan(0);
      // A source that names neither a measurement nor a declared provisional
      // bound is a number somebody liked the look of.
      expect(ceiling.source).toMatch(/COLD_ATTACH_CEILING_MS|3x [\d,]+ ms|^PROVISIONAL: /);
    }
    expect(CEILINGS).toHaveLength(ops.length);
  });

  test('both cold attaches are the admission contract\'s own ceiling, not a copy of it', () => {
    // A second 25_000 written here would drift the day the contract moves.
    expect(ceilingFor('cold-attach', CEILINGS).ms).toBe(COLD_ATTACH_CEILING_MS);
    expect(ceilingFor('cold-reattach', CEILINGS).ms).toBe(COLD_ATTACH_CEILING_MS);
  });

  test('an operation with no declared ceiling is refused rather than defaulted', () => {
    expect(() => ceilingFor('teardown', [])).toThrow(/no ceiling is declared/);
  });

  test('a calibration pass enforces nothing and says so', () => {
    for (const ceiling of ceilingsFor(true)) {
      expect(ceiling.ms).toBe(CALIBRATION_CEILING_MS);
      expect(ceiling.source).toContain('not an oracle');
    }
    expect(ceilingsFor(false)).toBe(CEILINGS);
  });
});

describe('a lifecycle that holds', () => {
  test('passes every step, in order, and tears the box down', async () => {
    const fake = fakeSeam();

    const verdict = await drive(fake, ceilingsAt(5_000));

    expect(verdict.failures).toEqual([]);
    expect(verdict.passed).toBeTrue();
    // THE ORDER IS THE CONTRACT. A restore verified before the recycle proves
    // nothing, and a cold reattach taken before the second checkpoint attaches
    // a tree nobody committed.
    expect(verdict.steps.map((step) => step.op)).toEqual([
      'cold-attach', 'small-workload', 'checkpoint-small', 'stop-small', 'wake-attach',
      'restore-verify', 'mid-workload', 'checkpoint-mid', 'stop-mid', 'cold-reattach',
      'reattach-verify', 'teardown',
    ]);
    // AND THE BYTES REALLY TRAVELLED THE STRATEGY'S OWN WRITE PATH: the tree is
    // written by a program running inside the box, not by the driver's file
    // route, which would measure the Durable Object instead of the strategy.
    expect(fake.asked.some((command) => command.includes('workload.ts small'))).toBeTrue();
    expect(fake.written).toEqual([
      '/var/tmp/devbox-e2e/workload.ts', '/workspace/e2e/marker.txt',
      '/var/tmp/devbox-e2e/workload.ts', '/var/tmp/devbox-e2e/workload.ts',
    ]);
  });
});

describe('the ceiling is the oracle', () => {
  test('a checkpoint that never settles fails ITS arm, naming the operation, inside the window', async () => {
    const fake = fakeSeam();
    const wedged: FakeSeam = { ...fake, seam: wedgedSeam(fake.seam) };
    const started = Date.now();
    const verdict = await drive(wedged, ceilingsAt(120), 'bounded-layers');
    const elapsed = Date.now() - started;

    expect(verdict.passed).toBeFalse();
    // THE WHOLE POINT: the arm, the operation and the bound are all in the one
    // sentence a reader sees, and the run ended at the ceiling rather than
    // hanging with the wedged operation.
    expect(verdict.failures[0]).toContain('bounded-layers');
    expect(verdict.failures[0]).toContain('checkpoint-small');
    expect(verdict.failures[0]).toContain('did not settle inside its 120 ms ceiling');
    expect(elapsed).toBeLessThan(5_000);
    // AND THE BOX IS STILL HANDED BACK. A wedged arm is exactly the arm still
    // holding a container instance.
    expect(fake.teardowns).toBe(1);
    expect(verdict.steps.at(-1)?.op).toBe('teardown');
    // The abandoned operation is accounted for rather than orphaned.
    expect(verdict.notes.some((note) => note.includes('abandoned at its ceiling'))).toBeTrue();
  });

  test('a hang is reported as a hang and a wrong answer as a wrong answer', async () => {
    const hung = fakeSeam({}, {
      startup: async (): Promise<StartupOutcome> => await new Promise<StartupOutcome>(() => {}),
    });
    const refused = fakeSeam({}, {
      checkpoint: async (): Promise<SettleOutcome> =>
        ({ ms: 4, ok: false, detail: 'skipped (work directory is unchanged)' }),
    });

    const hungVerdict = await drive(hung, ceilingsAt(80));
    const refusedVerdict = await drive(refused, ceilingsAt(5_000));

    expect(hungVerdict.failures[0]).toContain('did not settle inside its 80 ms ceiling');
    expect(refusedVerdict.failures[0]).toContain('did not hold');
    expect(refusedVerdict.failures[0]).toContain('skipped (work directory is unchanged)');
  });

  test('a lane never throws, so one arm\'s refusal cannot reach a sibling', async () => {
    const broken = fakeSeam({}, {
      exec: async (): Promise<ExecOutcome> => { throw new Error('the container is gone'); },
      teardown: async (): Promise<void> => { throw new Error('teardown refused too'); },
    });

    const [brokenVerdict, healthyVerdict] = await Promise.all([
      drive(broken, ceilingsAt(2_000), 'merkle-pack'),
      drive(fakeSeam(), ceilingsAt(5_000), 'overlay-cas'),
    ]);

    expect(brokenVerdict.passed).toBeFalse();
    expect(brokenVerdict.failures.join(' ')).toContain('the container is gone');
    expect(brokenVerdict.failures.join(' ')).toContain('teardown did not complete');
    expect(healthyVerdict.passed).toBeTrue();
  });
});

describe('the restore is verified byte for byte', () => {
  test('a restored tree that is not the tree that was checkpointed fails', async () => {
    const verdict = await drive(fakeSeam({ driftTree: true }), ceilingsAt(5_000));

    expect(verdict.passed).toBeFalse();
    expect(verdict.failures[0]).toContain('restore-verify');
    expect(verdict.failures[0]).toContain('not the tree that was checkpointed');
    expect(verdict.failures[0]).toContain('922623');
  });

  test('a file deleted before the checkpoint that comes back after it fails', async () => {
    const verdict = await drive(fakeSeam({ resurrect: ['delete-me-1.txt'] }), ceilingsAt(5_000));

    expect(verdict.passed).toBeFalse();
    expect(verdict.failures[0]).toContain('a file deleted before the checkpoint came back');
  });

  test('bytes a writer flushed before the checkpoint that do not come back fail', async () => {
    // What an arm that dropped a live handle's flushed bytes looks like from
    // outside: the file is back, and it is empty.
    const verdict = await drive(fakeSeam({ loseOpenWrite: true }), ceilingsAt(5_000));

    expect(verdict.passed).toBeFalse();
    expect(verdict.failures[0]).toContain('the bytes a writer flushed before the checkpoint did not survive');
  });

  test('a marker the driver itself wrote is checked against the driver\'s own copy', async () => {
    // The digest is the container's own account of the tree, twice. This is the
    // half a container cannot fake: bytes THIS process wrote, read back.
    const verdict = await drive(fakeSeam({ forgetMarker: true }), ceilingsAt(5_000));

    expect(verdict.passed).toBeFalse();
    expect(verdict.failures[0]).toContain('the marker file came back as devbox-e2e-a-different-run');
  });
});

describe('a calibration pass proposes ceilings from what it measured', () => {
  test('three times the slowest arm that settled, and nothing from an arm that did not', () => {
    const settled = (strategy: Strategy, ms: number, ok = true): StrategyVerdict => ({
      strategy,
      box: `ab-${strategy}`,
      passed: ok,
      steps: [{ op: 'wake-attach', ms, ceilingMs: CALIBRATION_CEILING_MS, ok, detail: 'settled' }],
      failures: [],
      notes: [],
    });

    const proposals = proposedCeilings([
      settled('r2fs', 8_100),
      settled('snapshot-chain', 12_040),
      // A step that FAILED is not evidence of how long the operation takes.
      settled('bounded-layers', 900_000, false),
    ]);

    const wake = proposals.find((proposal) => proposal.op === 'wake-attach');
    expect(wake).toEqual({ op: 'wake-attach', measuredMs: 12_040, arm: 'snapshot-chain', proposedMs: 37_000 });
    // An operation nobody measured proposes nothing rather than proposing zero.
    expect(proposals.some((proposal) => proposal.op === 'mid-workload')).toBeFalse();
  });
});

describe('the deployed seam is the bench harness\'s own routes', () => {
  test('it is built from one fixture and one box, and exposes exactly the lifecycle\'s operations', () => {
    const seam = deployedSeam({ origin: 'https://bench.invalid', token: 'token' }, 'ab-r2fs-probe');
    expect(Object.keys(seam).sort()).toEqual(
      ['checkpoint', 'exec', 'startup', 'stop', 'teardown', 'write'],
    );
  });
});
