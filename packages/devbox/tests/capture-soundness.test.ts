import { beforeEach, describe, expect, test } from 'bun:test';
import * as v from 'valibot';

import { CapturedCutSchema } from '../src/durability/contracts';
import {
  auditCapture,
  captureFrozenCopy,
  expandContent,
  logFreezeSeam,
  logView,
  materializeJournalPrefix,
  MutationLog,
  naiveLiveScan,
  prefixState,
  stableScan,
  stateEquals,
  toCapturedCut,
  WatchEventQueue,
  type Capture,
  type CaptureView,
  type FileContent,
  type MutationOp,
  type UpperPath,
} from '../src/capture';

const enc = new TextEncoder();
const dense = (s: string): FileContent => ({ kind: 'dense', bytes: enc.encode(s) });
const text = (content: FileContent | undefined): string =>
  content ? Buffer.from(expandContent(content)).toString() : '';
const asState = (capture: Capture) => new Map(capture.entries.map((e) => [e.path, e]));

/** A view whose per-path hook runs before each staged read — the deterministic interleaving point. */
function hookedView(log: MutationLog, hook?: (path: UpperPath) => Promise<void>): CaptureView {
  const base = logView(log);
  return {
    paths: () => base.paths(),
    stat: (path) => base.stat(path),
    readEntry: async (path) => {
      if (hook) await hook(path);
      return base.readEntry(path);
    },
  };
}

// ── randomized workloads ─────────────────────────────────────────────────────

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pick = <T>(rng: () => number, items: readonly T[]): T => items[Math.floor(rng() * items.length)]!;

let freshCounter = 0;
function freshPath(rng: () => number, log: MutationLog): UpperPath {
  const taken = new Set(log.paths());
  for (let attempt = 0; attempt < 32; attempt++) {
    const candidate = `gen${Math.floor(rng() * 1e6)}-${++freshCounter}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `overflow-${++freshCounter}`;
}

function randomWord(rng: () => number, length: number): string {
  let out = '';
  while (out.length < length) out += Math.floor(rng() * 0xffff).toString(16);
  return out.slice(0, length);
}

/** A random VALID-at-apply-time hazard op, or null when nothing applies. */
function hazardOp(rng: () => number, log: MutationLog): MutationOp | null {
  const paths = log.paths();
  const files = paths.filter((p) => log.statOf(p)?.kind === 'file');
  const roll = rng();
  if (roll < 0.14 && files.length > 0) {
    // Same-size preserved-time rewrite: the class stat observers cannot see.
    const path = pick(rng, files);
    const size = Math.max(log.readFile(path).byteLength, 1);
    return { op: 'rewrite-in-place', path, content: dense(randomWord(rng, size)) };
  }
  if (roll < 0.28 && files.length > 0) {
    const path = pick(rng, files);
    const size = log.readFile(path).byteLength;
    if (size === 0) return null;
    const offset = Math.floor(rng() * size);
    const bytes = enc.encode(randomWord(rng, 1 + Math.floor(rng() * 3)));
    return { op: 'mmap-write', path, offset, bytes: bytes.subarray(0, Math.min(bytes.byteLength, size - offset)) };
  }
  if (roll < 0.44) {
    return { op: 'write', path: freshPath(rng, log), content: dense(randomWord(rng, 1 + Math.floor(rng() * 8))) };
  }
  if (roll < 0.54 && paths.length > 0) {
    return { op: 'rename', from: pick(rng, paths), to: freshPath(rng, log) };
  }
  if (roll < 0.62 && paths.length > 0) {
    return { op: 'unlink', path: pick(rng, paths) };
  }
  if (roll < 0.70 && files.length > 0) {
    return { op: 'link', existingPath: pick(rng, files), newPath: freshPath(rng, log) };
  }
  if (roll < 0.78) {
    return { op: 'symlink', path: freshPath(rng, log), target: pick(rng, files.length > 0 ? files : ['nowhere']) };
  }
  if (roll < 0.86) {
    return { op: 'mkdir', path: freshPath(rng, log) };
  }
  if (roll < 0.94 && paths.length > 0) {
    return { op: 'rmdir', path: pick(rng, paths) };
  }
  return { op: 'replace-generation' };
}

async function writerLoop(log: MutationLog, rng: () => number, steps: number): Promise<void> {
  for (let i = 0; i < steps; i++) {
    try {
      await log.perform(hazardOp(rng, log) ?? { op: 'write', path: freshPath(rng, log), content: dense('x') });
    } catch (error) {
      // The model refuses invalid ops before mutating; a losing race is just
      // a writer whose op did not happen. Anything else must still fail loud.
      if (!(error instanceof Error)) throw error;
    }
  }
}

async function seedBaseline(log: MutationLog, rng: () => number): Promise<void> {
  await log.perform({ op: 'mkdir', path: 'work' });
  for (let i = 0; i < 4; i++) {
    await log.perform({ op: 'write', path: `work/f${i}.txt`, content: dense(randomWord(rng, 8)) });
  }
  await log.perform({
    op: 'write',
    path: 'work/sparse.bin',
    content: { kind: 'sparse', size: 64, runs: [{ offset: 8, bytes: enc.encode('data') }] },
  });
  await log.perform({ op: 'symlink', path: 'work/latest', target: 'work/f0.txt' });
}

describe('mechanism one — the bare recursive scan fails CaptureSound', () => {
  test('a naive scan across two mutations produces a capture equal to NO prefix', async () => {
    const log = new MutationLog();
    await log.perform({ op: 'write', path: 'a', content: dense('v1') });
    await log.perform({ op: 'write', path: 'b', content: dense('w1') });

    const view = hookedView(log, async (path) => {
      if (path !== 'b') return;
      await log.perform({ op: 'write', path: 'a', content: dense('v2') });
      await log.perform({ op: 'write', path: 'b', content: dense('w2') });
    });

    const torn = await naiveLiveScan(view);
    expect(text(torn.entries.find((e) => e.path === 'a')?.content)).toBe('v1');
    expect(text(torn.entries.find((e) => e.path === 'b')?.content)).toBe('w2');
    expect(auditCapture(log.entries, torn).matchingCuts).toEqual([]);
  });

  test('hardlink identity does not rescue an unserialized scan', async () => {
    const log = new MutationLog();
    await log.perform({ op: 'write', path: 'a', content: dense('1111') });
    await log.perform({ op: 'link', existingPath: 'a', newPath: 'b' });

    const view = hookedView(log, async (path) => {
      if (path !== 'b') return;
      log.bypassFrozenGate({ op: 'rewrite-in-place', path: 'a', content: dense('2222') });
    });
    const torn = await naiveLiveScan(view);
    // The capture even KNOWS the two paths share an inode…
    expect(new Set(torn.entries.map((e) => e.ino)).size).toBe(1);
    // …and is still torn: shared inode, divergent bytes, no matching prefix.
    expect(auditCapture(log.entries, torn).matchingCuts).toEqual([]);
  });
});

describe('mechanism one with a stability proof — honest, never sound by construction', () => {
  test('on a quiet tree it captures exactly one prefix and anchors it post-hoc', async () => {
    const log = new MutationLog();
    await log.perform({ op: 'write', path: 'only', content: dense('quiet') });
    const result = await stableScan(logView(log));
    expect(result.verdict).toBe('captured');
    if (result.verdict !== 'captured') return;

    const audit = auditCapture(log.entries, result.capture);
    expect(audit.matchingCuts).toEqual([log.lastSeq]);
    expect(audit.uniquelyAnchored).toBe(true);

    // Post-hoc anchoring is what makes an unclaimed scan publishable at all.
    const anchored: Capture = { ...result.capture, cut: audit.matchingCuts[0]!, generation: 0 };
    const published = toCapturedCut(anchored, {
      captureId: 'cap-quiet',
      epoch: '1',
      baseRevision: '0',
      stableStageHandle: 'stage-q',
    });
    expect(v.parse(CapturedCutSchema, published).cut).toBe(String(log.lastSeq));
  });

  test('plain concurrent writes are detected: the proof refuses instead of guessing', async () => {
    const log = new MutationLog();
    await log.perform({ op: 'write', path: 'a', content: dense('aaaa') });
    await log.perform({ op: 'write', path: 'b', content: dense('bbbb') });
    const view = hookedView(log, async (path) => {
      if (path !== 'b') return;
      await log.perform({ op: 'write', path: 'b', content: dense('BBBB') });
    });
    const result = await stableScan(view);
    expect(result.verdict).toBe('refused');
    if (result.verdict !== 'refused') return;
    expect(result.reason).toBe('unstable-window');
  });

  test.each([
    {
      name: 'same-size rewrites with restored mtime pass every stat check on BOTH files and tear the capture',
      hide: (log: MutationLog): Promise<number> => log.perform({
        op: 'rewrite-in-place', path: 'a', content: dense('zzzz'),
      }).then(() => log.bypassFrozenGate({ op: 'rewrite-in-place', path: 'b', content: dense('zzzz') })),
    },
    {
      name: 'mmap stores change no metadata on EITHER file and tear the capture',
      hide: (log: MutationLog): Promise<number> => log.perform({
        op: 'mmap-write', path: 'a', offset: 0, bytes: enc.encode('zzzz'),
      }).then(() => log.bypassFrozenGate({ op: 'mmap-write', path: 'b', offset: 0, bytes: enc.encode('zzzz') })),
    },
  ])('$name', async ({ hide }) => {
    const log = new MutationLog();
    await log.perform({ op: 'write', path: 'a', content: dense('aaaa') });
    await log.perform({ op: 'write', path: 'b', content: dense('bbbb') });
    const view = hookedView(log, async (path) => {
      if (path === 'b') await hide(log);
    });

    const result = await stableScan(view);
    // The stability proof SAW NOTHING: it ships a capture.
    expect(result.verdict).toBe('captured');
    if (result.verdict !== 'captured') return;
    // And the audit proves the class unsound: a's old bytes sit beside b's
    // new bytes, a mixed cut that matches NO prefix.
    const audit = auditCapture(log.entries, result.capture);
    expect(audit.matchingCuts).toEqual([]);
    expect(text(result.capture.entries.find((e) => e.path === 'a')?.content)).toBe('aaaa');
    expect(text(result.capture.entries.find((e) => e.path === 'b')?.content)).toBe('zzzz');
    expect(text(log.entryOf('a')?.content)).toBe('zzzz');
    expect(text(log.entryOf('b')?.content)).toBe('zzzz');
  });
});

describe('mechanism two — freeze, drain, flush, stage, seal', () => {
  test('under concurrent hazard writers every capture is the exact prefix at its named cut', async () => {
    for (let seed = 1; seed <= 25; seed++) {
      const rng = mulberry32(seed);
      const log = new MutationLog();
      await seedBaseline(log, rng);
      const view = logView(log);

      const writers = Promise.all([
        writerLoop(log, rng, 40),
        writerLoop(log, rng, 40),
        writerLoop(log, rng, 40),
      ]);

      const result = await captureFrozenCopy(log, view, logFreezeSeam(log, 'syncfs'));
      expect(result.verdict).toBe('captured');
      if (result.verdict !== 'captured') continue;
      const { capture } = result;

      // THE EXCLUSION PROOF: the capture equals prefix(cut), where cut was
      // recorded before staging ran — and stays equal whatever happens after.
      expect(stateEquals(prefixState(log.entries, capture.cut), asState(capture))).toBe(true);
      expect(auditCapture(log.entries.slice(0, capture.cut + 1), capture).claimedCutMatches).toBe(true);

      await writers;
      await log.perform({ op: 'write', path: 'post-thaw-proof', content: dense('excluded') });
      expect(stateEquals(prefixState(log.entries, capture.cut), asState(capture))).toBe(true);
      expect(capture.entries.some((e) => e.path === 'post-thaw-proof')).toBe(false);
    }
  });

  test('sparseness survives staging as representation, not as materialized zeros', async () => {
    const log = new MutationLog();
    await log.perform({
      op: 'write',
      path: 'holey.bin',
      content: { kind: 'sparse', size: 128, runs: [{ offset: 16, bytes: enc.encode('payload') }] },
    });
    const result = await captureFrozenCopy(log, logView(log), logFreezeSeam(log, 'syncfs'));
    expect(result.verdict).toBe('captured');
    if (result.verdict !== 'captured') return;
    const entry = result.capture.entries.find((e) => e.path === 'holey.bin')!;
    expect(entry.content?.kind).toBe('sparse');
  });

  test('one frozen cut preserves metadata-independent writes and namespace semantics together', async () => {
    const log = new MutationLog();
    await log.perform({ op: 'mkdir', path: 'd' });
    await log.perform({ op: 'write', path: 'd/live', content: dense('aaaa') });
    await log.perform({ op: 'link', existingPath: 'd/live', newPath: 'd/twin' });
    await log.perform({ op: 'symlink', path: 'd/link', target: 'd/live' });
    await log.perform({ op: 'write', path: 'd/delete-me', content: dense('gone') });
    await log.perform({ op: 'mmap-write', path: 'd/live', offset: 0, bytes: enc.encode('zzzz') });
    await log.perform({ op: 'rename', from: 'd/live', to: 'd/final' });
    await log.perform({ op: 'unlink', path: 'd/delete-me' });

    const result = await captureFrozenCopy(log, logView(log), logFreezeSeam(log, 'syncfs'));
    expect(result.verdict).toBe('captured');
    if (result.verdict !== 'captured') return;
    const byPath = new Map(result.capture.entries.map((entry) => [entry.path, entry]));
    expect(byPath.has('d/delete-me')).toBe(false);
    expect(byPath.get('d/final')!.ino).toBe(byPath.get('d/twin')!.ino);
    expect(text(byPath.get('d/final')!.content)).toBe('zzzz');
    expect(byPath.get('d/link')!.target).toBe('d/live');
    expect(auditCapture(log.entries, result.capture).claimedCutMatches).toBe(true);
  });


  test('container replacement before the freeze is simply part of the captured state', async () => {
    const log = new MutationLog();
    await log.perform({ op: 'write', path: 'old', content: dense('gone') });
    await log.perform({ op: 'replace-generation' });
    await log.perform({ op: 'write', path: 'new', content: dense('here') });
    const result = await captureFrozenCopy(log, logView(log), logFreezeSeam(log, 'syncfs'));
    expect(result.verdict).toBe('captured');
    if (result.verdict !== 'captured') return;
    expect(result.capture.generation).toBe(1);
    expect(result.capture.entries.map((e) => e.path)).toEqual(['new']);
  });

  test('a seam that cannot prove completeness is refused, never trusted', async () => {
    const log = new MutationLog();
    await log.perform({ op: 'write', path: 'x', content: dense('x') });
    const unprovable: Parameters<typeof captureFrozenCopy>[2] = {
      ...logFreezeSeam(log, 'none'),
      proveComplete: async () => false,
    };
    const result = await captureFrozenCopy(log, logView(log), unprovable);
    expect(result).toEqual({
      verdict: 'refused',
      reason: 'freeze-not-provable',
      detail: 'the seam cannot prove writers are stopped and fork-proof',
    });
    // Thaw happened anyway: the writers are not stranded.
    await log.perform({ op: 'write', path: 'y', content: dense('y') });
    expect(log.entryOf('y')).not.toBeNull();
  });

  test('a writer surfacing mid-window parks at the gate and lands after the cut, excluded', async () => {
    const log = new MutationLog();
    await log.perform({ op: 'write', path: 'held.txt', content: dense('before') });
    await log.perform({ op: 'write', path: 'z-last.txt', content: dense('tail') });

    // An "open handle": the write surfaces while staging is in flight, hits
    // the freeze gate, parks, and only lands once thaw released the window.
    // Fired, not awaited — a staged read must not block on a parked writer.
    let lateWrite: Promise<unknown> | null = null;
    const view = hookedView(log, (path) => {
      if (path !== 'z-last.txt' || lateWrite) return Promise.resolve();
      lateWrite = log.perform({ op: 'rewrite-in-place', path: 'held.txt', content: dense('AFTER!') });
      return Promise.resolve();
    });

    const result = await captureFrozenCopy(log, view, logFreezeSeam(log, 'per-file-fsync'));
    expect(result.verdict).toBe('captured');
    if (result.verdict !== 'captured') return;
    expect(result.syncUsed).toBe('per-file-fsync'); // degraded loudly, not silently
    expect(result.caveats.length).toBe(1);

    // The staged bytes hold the pre-write state…
    expect(text(result.capture.entries.find((e) => e.path === 'held.txt')?.content)).toBe('before');
    // …and the parked write lands only after thaw, outside the cut.
    if (!lateWrite) throw new Error('the staged-read hook did not surface the held write');
    await lateWrite;
    expect(text(log.entryOf('held.txt')?.content)).toBe('AFTER!');
    expect(stateEquals(prefixState(log.entries, result.capture.cut), asState(result.capture))).toBe(true);
  });

  test('a leaked freeze that lets ANY mutation through poisons the window and refuses', async () => {
    const log = new MutationLog();
    await log.perform({ op: 'mkdir', path: 'd' });
    await log.perform({ op: 'write', path: 'd/f', content: dense('one') });

    const leakySeam: Parameters<typeof captureFrozenCopy>[2] = {
      ...logFreezeSeam(log, 'syncfs'),
      sync: async () => {
        // The freeze leak manifests here: a mutation lands mid-window.
        log.bypassFrozenGate({ op: 'write', path: 'leaked', content: dense('slipped') });
        return 'syncfs';
      },
    };
    expect(await captureFrozenCopy(log, logView(log), leakySeam))
      .toMatchObject({ verdict: 'refused', reason: 'mutation-during-frozen-window' });

    const generationLeak: Parameters<typeof captureFrozenCopy>[2] = {
      ...logFreezeSeam(log, 'syncfs'),
      sync: async () => {
        log.bypassFrozenGate({ op: 'replace-generation' });
        return 'syncfs';
      },
    };
    expect(await captureFrozenCopy(log, logView(log), generationLeak))
      .toMatchObject({ verdict: 'refused', reason: 'mutation-during-frozen-window' });
  });
});

describe('mechanism three — ordered mutation journal', () => {
  let log: MutationLog;

  function sourceFromChunks(chunks: readonly number[][], overflowed = false) {
    return {
      batches: () => chunks.map((seqs) => ({
        firstSeq: seqs[0]!,
        lastSeq: seqs[seqs.length - 1]!,
        entries: seqs.map((seq) => log.entries[seq]!),
      })),
      overflowed: () => overflowed,
    };
  }

  beforeEach(async () => {
    log = new MutationLog();
    await log.perform({ op: 'write', path: 'j/a', content: dense('1') });
    await log.perform({ op: 'write', path: 'j/b', content: dense('2') });
    await log.perform({ op: 'rename', from: 'j/a', to: 'j/renamed' });
    await log.perform({ op: 'unlink', path: 'j/b' });
  });

  test('materialized prefixes equal the replayed prefix at the cut, whatever happens after', async () => {
    let extra = 0;
    for (const cut of [-1, 0, 1, 2, 3]) {
      const result = materializeJournalPrefix(sourceFromChunks([[0, 1], [2, 3]]), cut, 0);
      expect(result.verdict).toBe('captured');
      if (result.verdict !== 'captured') continue;
      const expected = prefixState(log.entries, cut);
      const got = new Map(result.capture.entries.map((e) => [e.path, e]));
      expect(stateEquals(expected, got)).toBe(true);

      // Post-cut mutations are excluded by construction: apply more, capture unchanged.
      await log.perform({ op: 'write', path: `j/post${++extra}`, content: dense('later') });
      expect(got.has(`j/post${extra}`)).toBe(false);
    }
  });

  test('a gap in delivered sequence numbers refuses with the position named', () => {
    const result = materializeJournalPrefix(sourceFromChunks([[0, 1], [3]]), 3, 0);
    expect(result.verdict).toBe('refused');
    if (result.verdict === 'refused') expect(result.detail).toContain('expected seq 2');
  });

  test('a batch whose declared range hides an inner dropped event also refuses', () => {
    const source = {
      batches: () => [{
        firstSeq: 0,
        lastSeq: 3,
        entries: [log.entries[0]!, log.entries[2]!, log.entries[3]!],
      }],
      overflowed: () => false,
    };
    const result = materializeJournalPrefix(source, 3, 0);
    expect(result).toMatchObject({ verdict: 'refused', reason: 'journal-gap' });
    if (result.verdict === 'refused') expect(result.detail).toContain('expected seq 1');
  });

  test('watcher overflow refuses the whole journal instead of trusting survivors', () => {
    const queue = new WatchEventQueue(2);
    queue.push(log.entries[0]!);
    queue.push(log.entries[1]!);
    queue.push(log.entries[2]!); // dropped, flagged
    expect(materializeJournalPrefix(queue.toSource(), 2, 0)).toEqual({
      verdict: 'refused',
      reason: 'watch-overflow',
      detail: 'the journal transport dropped events; no prefix can be claimed',
    });
  });
});
