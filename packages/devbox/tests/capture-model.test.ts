import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';

import { CapturedCutSchema } from '../src/durability/contracts';
import {
  auditCapture,
  contentEquals,
  expandContent,
  MutationLog,
  prefixState,
  stateEquals,
  toCapturedCut,
  manifestSha256,
  type Capture,
  type FileContent,
} from '../src/capture';

const dense = (s: string): FileContent => ({ kind: 'dense', bytes: new TextEncoder().encode(s) });

async function seed(log: MutationLog): Promise<void> {
  await log.perform({ op: 'mkdir', path: 'src' });
  await log.perform({ op: 'write', path: 'src/a.txt', content: dense('alpha') });
  await log.perform({ op: 'write', path: 'src/b.txt', content: { kind: 'sparse', size: 16, runs: [{ offset: 4, bytes: new TextEncoder().encode('beta') }] } });
  await log.perform({ op: 'symlink', path: 'link', target: 'src/a.txt' });
}

describe('the capture soundness model', () => {
  test('prefix replay rebuilds byte-and-metadata identical state', async () => {
    const log = new MutationLog();
    await seed(log);
    const live = new Map(log.paths().map((p) => [p, log.entryOf(p)!]));
    for (let cut = -1; cut < log.entries.length; cut++) {
      // Replay must be pure: prefixing at every cut never disturbs the live log.
      expect(prefixState(log.entries, cut).size).toBeLessThanOrEqual(live.size);
    }
    const full = prefixState(log.entries, log.lastSeq);
    expect(stateEquals(full, live)).toBe(true);
    // Sparse logical bytes: holes read as zeros.
    const b = full.get('src/b.txt')!;
    expect(b.content && expandContent(b.content)).toEqual(new TextEncoder().encode('\0\0\0\0beta\0\0\0\0\0\0\0\0'));
  });

  test('hardlinks share inode identity and rewrite through either path', async () => {
    const log = new MutationLog();
    await log.perform({ op: 'write', path: 'a', content: dense('one') });
    await log.perform({ op: 'link', existingPath: 'a', newPath: 'b' });
    await log.perform({ op: 'rewrite-in-place', path: 'b', content: dense('two') });
    const state = prefixState(log.entries, log.lastSeq);
    expect(state.get('a')!.ino).toBe(state.get('b')!.ino);
    expect(contentEquals(state.get('a')!.content!, dense('two'))).toBe(true);
  });

  test('an exact-prefix capture matches its claimed cut; a mixed capture matches none', async () => {
    const log = new MutationLog();
    await log.perform({ op: 'write', path: 'x', content: dense('1') });
    await log.perform({ op: 'write', path: 'y', content: dense('a') });
    const good = prefixState(log.entries, 1);
    const goodCapture: Capture = {
      mechanism: 'mutation-journal',
      cut: 1,
      generation: 0,
      entries: [...good.values()],
    };
    expect(auditCapture(log.entries, goodCapture)).toEqual({
      claimedCutMatches: true,
      matchingCuts: [1],
      uniquelyAnchored: true,
    });

    await log.perform({ op: 'write', path: 'x', content: dense('2') });
    await log.perform({ op: 'write', path: 'y', content: dense('b') });
    // Torn: x from before BOTH writes beside y from after BOTH writes.
    const tornCapture: Capture = {
      mechanism: 'stable-scan',
      cut: -1,
      generation: -1,
      entries: [
        { path: 'x', kind: 'file', mode: 0o644, ino: 1, content: dense('1') },
        { path: 'y', kind: 'file', mode: 0o644, ino: 4, content: dense('b') },
      ],
    };
    const audit = auditCapture(log.entries, tornCapture);
    expect(audit.matchingCuts).toEqual([]);
    expect(audit.claimedCutMatches).toBe(false);

    // Leaked: claims the final cut but carries stale bytes.
    const leaked: Capture = { ...goodCapture, cut: log.lastSeq };
    expect(auditCapture(log.entries, leaked).claimedCutMatches).toBe(false);
  });

  test('generation is part of a capture anchor even when node maps are empty', async () => {
    const log = new MutationLog();
    await log.bypassFrozenGate({ op: 'replace-generation' });
    const emptyCapture: Capture = { mechanism: 'freeze-drain', cut: 0, generation: 1, entries: [] };
    const audit = auditCapture(log.entries, emptyCapture);
    expect(audit.matchingCuts).toEqual([0]);
    expect(audit.claimedCutMatches).toBe(true);
    expect(audit.uniquelyAnchored).toBe(true);
  });

  test('toCapturedCut publishes through the shared durability contract and refuses unclaimed captures', async () => {
    const log = new MutationLog();
    await seed(log);
    const capture: Capture = {
      mechanism: 'freeze-drain',
      cut: log.lastSeq,
      generation: log.generation,
      entries: log.paths().map((p) => log.entryOf(p)!),
    };
    const capturedCut = toCapturedCut(capture, {
      captureId: 'cap-1',
      epoch: '3',
      baseRevision: '11',
      stableStageHandle: 'stage-9',
    });
    expect(v.parse(CapturedCutSchema, capturedCut)).toEqual(capturedCut);
    expect(capturedCut.cut).toBe(String(log.lastSeq));

    const hashA = manifestSha256(capture);
    const sameStateDifferentOrder: Capture = { ...capture, entries: [...capture.entries].reverse() };
    expect(manifestSha256(sameStateDifferentOrder)).toBe(hashA);

    expect(() => toCapturedCut({ ...capture, cut: -1 }, {
      captureId: 'cap-1', epoch: '3', baseRevision: '11', stableStageHandle: 'stage-9',
    })).toThrow('without a claimed cut');
  });
});
