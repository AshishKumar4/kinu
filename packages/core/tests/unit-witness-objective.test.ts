import { describe, expect, test } from 'bun:test';

import { measureChild } from '../src/strategy/swarm-scoring';
import { measuredCellsFor, witnessVerdict } from '../src/strategy/settle';
import type {
  MeasurementContext,
  MeasuredObjective,
} from '../src/strategy/objective';
import type { ResolvedVerifier } from '../src/strategy/verifier-registry';
import type { SwarmCandidate } from '../src/strategy/swarm';
import type { VFS } from '../src/types/primitives';

function context(): MeasurementContext {
  const files = new Map<string, Uint8Array>();
  const vfs: VFS = {
    readFile: async (path) => {
      const bytes = files.get(path);
      if (bytes === undefined) throw new Error(`missing ${path}`);
      return bytes;
    },
    writeFile: async (path, data) => {
      files.set(path, data instanceof Uint8Array ? data : new TextEncoder().encode(data));
    },
    readdir: async () => [],
    stat: async (path) => {
      const bytes = files.get(path);
      return bytes === undefined ? null : { size: bytes.byteLength, mtimeMs: 0, isDir: false };
    },
    unlink: async (path) => { files.delete(path); },
    mkdir: async () => undefined,
    exists: async (path) => files.has(path),
  };
  return {
    vfs,
    exec: async () => ({ stdout: '', stderr: '', exitCode: 0 }),
  };
}

const measured: MeasuredObjective = {
  metric: 'quality',
  unit: 'points',
  direction: 'maximise',
  scale: 'linear',
  target: 10,
  verify: { kind: 'exec-ratio', spec: {} },
  floor: undefined,
  witness: { kind: 'exec-ratio', spec: { predicate: 'certificate' } },
};

function verifier(
  artifact: string,
  value: number,
  onVerify?: () => void,
): ResolvedVerifier {
  return {
    kind: 'exec-ratio',
    artifact,
    baselineKey: null,
    implementation: `fixture:${artifact}`,
    verify: async () => {
      onVerify?.();
      return { kind: 'measured', value, detail: `${value}` };
    },
  };
}

function candidate(overrides: Partial<SwarmCandidate> = {}): SwarmCandidate {
  return {
    id: 'n1',
    artifact: 'answer',
    measured: { kind: 'measured', value: 5, detail: '5' },
    unmeasurable: null,
    incomplete: null,
    score: 0.5,
    witnessFound: null,
    ...overrides,
  };
}

describe('witness objectives', () => {
  test('the witness verifier runs independently of the proxy score', async () => {
    let witnessCalls = 0;
    const outcome = await measureChild({
      ctx: context(),
      verifier: verifier('/proxy', 5),
      witnessVerifier: verifier('/witness', 1, () => { witnessCalls += 1; }),
      measured,
      baseline: 0,
      artifact: 'candidate',
    });

    expect(outcome.kind).toBe('scored');
    if (outcome.kind !== 'scored') throw new Error(`unexpected ${outcome.kind}`);
    expect(outcome.score).toBe(0.5);
    expect(outcome.witnessFound).toBe(true);
    expect(witnessCalls).toBe(1);
  });

  test('the witness still runs when the scalar proxy is unmeasurable', async () => {
    let witnessCalls = 0;
    const proxy: ResolvedVerifier = {
      ...verifier('/proxy', 0),
      verify: async () => ({ kind: 'unmeasurable', detail: 'no proxy number' }),
    };
    const outcome = await measureChild({
      ctx: context(),
      verifier: proxy,
      witnessVerifier: verifier('/witness', 1, () => { witnessCalls += 1; }),
      measured,
      baseline: 0,
      artifact: 'candidate',
    });

    expect(outcome).toMatchObject({ kind: 'unmeasurable', witnessFound: true });
    expect(witnessCalls).toBe(1);
  });

  test('the run verdict reads candidate predicates, never proxy saturation', () => {
    expect(witnessVerdict(measured, [candidate({ score: 1, witnessFound: false })])).toBe(false);
    expect(witnessVerdict(measured, [candidate({ score: 0.2, witnessFound: true })])).toBe(true);
  });
});

describe('flat sealed publication', () => {
  test('a measured candidate with no rank still occupies the suppressed flat cell', () => {
    expect([...measuredCellsFor(null, [candidate({ score: null })])]).toEqual(['flat']);
  });
});
