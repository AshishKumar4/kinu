import { describe, expect, test } from 'bun:test';
import * as v from 'valibot';

import { CapturedCutSchema } from '../src/durability/contracts';
import {
  auditCapture,
  contentEquals,
  expandContent,
  MutationLog,
  prefixState,
  requireCompleteCaptureTree,
  stateEquals,
  toCapturedCut,
  manifestSha256,
  issueVerifiedJournalCapture,
  type Capture,
  type FileContent,
} from '../src/capture';

const sparse = (size: number, runs: readonly { readonly offset: number; readonly bytes: Uint8Array }[]): FileContent => ({
  kind: 'sparse',
  size,
  runs,
});

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

  test('toCapturedCut publishes an audit-proven capture and rejects every unsound shape', async () => {
    const log = new MutationLog();
    await seed(log);
    const identity = { captureId: 'cap-1', epoch: '3', baseRevision: '11', stableStageHandle: 'stage-9' };
    const capture: Capture = {
      mechanism: 'freeze-drain',
      cut: log.lastSeq,
      generation: log.generation,
      entries: log.paths().map((p) => log.entryOf(p)!),
    };
    const audited = toCapturedCut(log.entries, capture, identity);
    expect(v.parse(CapturedCutSchema, audited.capturedCut)).toEqual(audited.capturedCut);
    expect(audited.capturedCut.cut).toBe(String(log.lastSeq));
    expect(audited.capturedCut.manifestSha256).toBe(manifestSha256(capture));

    // Torn: matches no prefix at all.
    const torn: Capture = {
      ...capture,
      entries: [...capture.entries, { path: 'ghost', kind: 'file', mode: 0o644, ino: 999, content: dense('x') }],
    };
    expect(() => toCapturedCut(log.entries, torn, identity)).toThrow('torn');

    // Unclaimed: even a uniquely-anchored scan must claim its cut first.

    expect(() => toCapturedCut(log.entries, { ...capture, cut: -1 }, identity)).toThrow('unclaimed');

    // Leaked: the claimed cut is not one the audit proves.
    expect(() => toCapturedCut(log.entries, { ...capture, cut: 0 }, identity)).toThrow('leaked');
  });
  test('hashes sparse content by logical runs without allocating its apparent size', async () => {
    const overlapping = sparse(12, [
      { offset: 2, bytes: new TextEncoder().encode('ab\0c') },
      { offset: 4, bytes: new TextEncoder().encode('XY') },
    ]);
    const logical = expandContent(overlapping);
    const sparseCapture: Capture = {
      mechanism: 'freeze-drain',
      cut: 0,
      generation: 0,
      entries: [{ path: 'f', kind: 'file', mode: 0o644, ino: 1, content: overlapping }],
    };
    const denseCapture: Capture = {
      ...sparseCapture,
      entries: [{ path: 'f', kind: 'file', mode: 0o644, ino: 1, content: { kind: 'dense', bytes: logical } }],
    };
    expect(manifestSha256(sparseCapture)).toBe(manifestSha256(denseCapture));

    const log = new MutationLog();
    await log.perform({ op: 'write', path: 'hole', content: sparse(2 ** 40, []) });
    const capture: Capture = {
      mechanism: 'mutation-journal',
      cut: log.lastSeq,
      generation: log.generation,
      entries: log.paths().map((path) => log.entryOf(path)!),
    };
    expect(() =>
      toCapturedCut(log.entries, capture, {
        captureId: 'sparse-hole',
        epoch: '3',
        baseRevision: '11',
        stableStageHandle: 'stage-9',
      }),
    ).not.toThrow();
  });

  test('an AuditedCapture snapshot is immune to later mutation of its source buffers', async () => {
    const identity = { captureId: 'cap-1', epoch: '3', baseRevision: '11', stableStageHandle: 'stage-9' };
    const bytes = new TextEncoder().encode('alpha');
    const log = new MutationLog();
    await log.perform({ op: 'mkdir', path: 'src' });
    await log.perform({ op: 'write', path: 'src/a.txt', content: { kind: 'dense', bytes } });
    await log.perform({
      op: 'write',
      path: 'src/b.txt',
      content: { kind: 'sparse', size: 16, runs: [{ offset: 4, bytes }] },
    });
    const capture: Capture = {
      mechanism: 'freeze-drain',
      cut: log.lastSeq,
      generation: log.generation,
      entries: log.paths().map((p) => log.entryOf(p)!),
    };
    const audited = toCapturedCut(log.entries, capture, identity);
    expect(audited.entries).not.toBe(capture.entries);

    const digestBeforeMutation = manifestSha256(capture);
    bytes[0] = 0x7f; // mutate the caller's buffer after publication
    const a = audited.entries.find((e) => e.path === 'src/a.txt')!.content!;
    expect(expandContent(a)).toEqual(new TextEncoder().encode('alpha'));
    const b = audited.entries.find((e) => e.path === 'src/b.txt')!.content!;
    if (b.kind !== 'sparse') throw new Error('expected sparse content');
    expect(b.runs[0]!.bytes[0]).toBe(0x61);
    // The published identity stays bound to what was audited, not to what
    // the caller's staging buffer later became.
    const sourceDir = capture.entries.find((e) => e.path === 'src')!;
    const copiedDir = audited.entries.find((e) => e.path === 'src')!;
    Object.assign(sourceDir, { mode: 0 });
    expect(Object.isFrozen(copiedDir)).toBe(true);
    expect(copiedDir.mode).toBe(0o755);
    expect(audited.capturedCut.manifestSha256).toBe(digestBeforeMutation);
    expect(manifestSha256(capture)).not.toBe(digestBeforeMutation);
  });

  test('deep-freezes validated journal metadata and refuses it on the reduced log audit', async () => {
    const metadata = {
      uid: 1000,
      gid: 1000,
      atimeNs: '1700000000000000000',
      mtimeNs: '1700000001000000000',
      ctimeNs: '1700000002000000000',
      xattrs: { 'user.color': 'Ymx1ZQ==' },
    };
    const entries = [{ path: 'f', kind: 'file' as const, mode: 0o644, ino: 1, metadata, content: dense('content') }];
    const journal = { mechanism: 'mutation-journal' as const, cut: 1, generation: 0, entries };
    const issued = issueVerifiedJournalCapture({
      ...journal,
      identity: { captureId: 'journal-1', epoch: '1', baseRevision: '1', stableStageHandle: 'stage-1' },
      manifestSha256: manifestSha256(journal),
    });
    metadata.xattrs['user.color'] = 'cmVk';
    const exposed = issued.entries[0]!;
    expect(Object.isFrozen(exposed.metadata)).toBe(true);
    expect(Object.isFrozen(exposed.metadata!.xattrs)).toBe(true);
    expect(exposed.metadata!.xattrs['user.color']).toBe('Ymx1ZQ==');

    const log = new MutationLog();
    await log.perform({ op: 'write', path: 'f', content: dense('content') });
    const logged = log.entryOf('f')!;
    expect(() => toCapturedCut(log.entries, {
      mechanism: 'mutation-journal',
      cut: log.lastSeq,
      generation: log.generation,
      entries: [{ ...logged, metadata }],
    }, { captureId: 'log-1', epoch: '1', baseRevision: '1', stableStageHandle: 'stage-1' })).toThrow('unmodeled POSIX metadata');

    const malformed = { ...journal, entries: [{ ...entries[0]!, metadata: { ...metadata, xattrs: { 'user.color': 'invalid!' } } }] };
    expect(() => issueVerifiedJournalCapture({
      ...malformed,
      identity: { captureId: 'journal-invalid', epoch: '1', baseRevision: '1', stableStageHandle: 'stage-invalid' },
      manifestSha256: manifestSha256(malformed),
    })).toThrow('invalid xattr value');
  });

  test('a publishable capture must be a complete tree: no invented ancestors, no kind conflicts', async () => {
    const log = new MutationLog();
    await seed(log);
    const identity = { captureId: 'cap-1', epoch: '3', baseRevision: '11', stableStageHandle: 'stage-9' };
    const base: Capture = {
      mechanism: 'freeze-drain',
      cut: log.lastSeq,
      generation: log.generation,
      entries: log.paths().map((p) => log.entryOf(p)!),
    };
    expect(() => toCapturedCut(log.entries, base, identity)).not.toThrow();

    // A missing ancestor is rejected, never synthesized.
    const missingDir: Capture = {
      ...base,
      entries: base.entries.filter((e) => e.path !== 'src'),
    };
    expect(() => toCapturedCut(log.entries, missingDir, identity)).toThrow(/ancestor 'src' of 'src\/a.txt' is absent/);

    // A file may not parent; a symlink may not parent.
    const entries = base.entries;
    const fileParent: Capture = {
      ...base,
      entries: [...entries.filter((e) => e.path !== 'src'), { path: 'src', kind: 'file', mode: 0o644, ino: 77, content: dense('x') }],
    };
    expect(() => toCapturedCut(log.entries, fileParent, identity)).toThrow(/'src' of 'src\/a.txt' is a file, not a directory/);
    const symlinkParent: Capture = {
      ...base,
      entries: [...entries, { path: 'link/child', kind: 'file', mode: 0o644, ino: 78, content: dense('y') }],
    };
    expect(() => toCapturedCut(log.entries, symlinkParent, identity)).toThrow(
      /'link' of 'link\/child' is a symlink, not a directory/,
    );

    // Duplicates and non-canonical paths are rejected outright.
    expect(() =>
      requireCompleteCaptureTree([...entries, entries.find((e) => e.path === 'src')!]),
    ).toThrow("duplicate capture path 'src'");
    for (const bad of ['/abs', './rel', 'a//b', 'a/../b', 'trail/']) {
      expect(() => requireCompleteCaptureTree([{ path: bad, kind: 'dir', mode: 0o755, ino: 1 }])).toThrow(
        'non-canonical capture path',
      );
    }

    // No invented metadata: each kind carries exactly its own fields.
    expect(() =>
      requireCompleteCaptureTree([{ path: 'f', kind: 'file', mode: 0o644, ino: 2 }]),
    ).toThrow("file entry 'f' carries no content");
    expect(() =>
      requireCompleteCaptureTree([{ path: 'l', kind: 'symlink', mode: 0o777, ino: 3 }]),
    ).toThrow("symlink entry 'l' carries no target");
    const directory = { path: 'd', kind: 'dir' as const, mode: 0o755, ino: 4 };
    Object.defineProperty(directory, 'target', { value: 'elsewhere' });
    expect(() => requireCompleteCaptureTree([directory])).toThrow(
      "dir entry 'd' carries an invented symlink target",
    );
  });
});
