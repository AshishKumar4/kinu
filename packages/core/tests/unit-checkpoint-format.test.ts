/**
 * Unit tests: the shadow-git checkpoint STORE FORMAT.
 *
 * This module is the wire contract between the cli-backend engine and the
 * dependency-free pc-agent daemon, which pins the same values as literals.
 * The cross-engine parity test round-trips a store through both engines but
 * never exercises the encoding's edge cases — a subject carrying a newline or
 * a pipe, an absent turn, or a ref that does not match the naming scheme.
 */

import { describe, test, expect } from 'bun:test';
import {
  CHECKPOINT_EXCLUDES,
  CHECKPOINT_REF_PREFIX,
  CHECKPOINT_WORKDIR_MARKER,
  checkpointRefTimestampMs,
  checkpointReason,
  checkpointSubject,
  diagnoseStaging,
  parseCheckpointSubject,
} from '../src/checkpoints/format.js';

const meta = { turnId: 't1', sessionId: 's1' };

describe('checkpointSubject', () => {
  test('encodes turn and session attribution ahead of the reason', () => {
    expect(checkpointSubject(meta, 'pre-edit')).toBe('turn=t1 session=s1 pre-edit');
  });

  test('null meta marks an out-of-turn snapshot with placeholders', () => {
    expect(checkpointSubject(null, 'pre-restore')).toBe('turn=- session=- pre-restore');
  });

  test('a blank turn or session degrades to its own placeholder', () => {
    expect(checkpointSubject({ turnId: 't1', sessionId: '' }, 'r'))
      .toBe('turn=t1 session=- r');
    expect(checkpointSubject({ turnId: '   ', sessionId: 's1' }, 'r'))
      .toBe('turn=- session=s1 r');
  });

  test('newlines and pipes are stripped — a subject is one line with stable fields', () => {
    // A newline would split the git commit subject from its body; a pipe would
    // collide with the field encoding on the daemon side.
    const subject = checkpointSubject({ turnId: 'a\nb', sessionId: 'c|d' }, 'edit\nfile | tool');
    expect(subject).toBe('turn=a b session=c d edit file   tool');
    expect(subject).not.toContain('\n');
    expect(subject).not.toContain('|');
  });

  test('a whitespace-only or empty reason collapses to the placeholder', () => {
    expect(checkpointSubject(meta, '')).toBe('turn=t1 session=s1 -');
    expect(checkpointSubject(meta, '\n')).toBe('turn=t1 session=s1 -');
  });
});

describe('parseCheckpointSubject', () => {
  test('round-trips an attributed subject', () => {
    expect(parseCheckpointSubject(checkpointSubject(meta, 'pre-edit')))
      .toEqual({ turnId: 't1', sessionId: 's1', reason: 'pre-edit' });
  });

  test('round-trips placeholders back to null, not to the literal dash', () => {
    expect(parseCheckpointSubject(checkpointSubject(null, 'pre-restore')))
      .toEqual({ turnId: null, sessionId: null, reason: 'pre-restore' });
  });

  test('keeps a multi-word reason intact', () => {
    expect(parseCheckpointSubject('turn=t1 session=s1 ran the build twice').reason)
      .toBe('ran the build twice');
  });

  test('an unrecognized subject keeps its raw text as the reason with no attribution', () => {
    // Commits made outside this format (hand-made, or an older store) must not
    // be silently attributed to whatever turn is running now.
    expect(parseCheckpointSubject('WIP: something else'))
      .toEqual({ turnId: null, sessionId: null, reason: 'WIP: something else' });
    expect(parseCheckpointSubject('turn=t1 session=s1'))
      .toEqual({ turnId: null, sessionId: null, reason: 'turn=t1 session=s1' });
  });

  test('an id containing a space loses attribution rather than mis-attributing', () => {
    // clean() strips newlines and pipes but not spaces, so a space-bearing id
    // escapes the (\S+) fields. Real ids are ULIDs/nanoids; the point here is
    // that the failure mode is "unattributed", never "attributed to the wrong
    // turn" — the parse must not silently absorb the drift.
    const subject = checkpointSubject({ turnId: 'a b', sessionId: 's1' }, 'r');
    expect(parseCheckpointSubject(subject))
      .toEqual({ turnId: null, sessionId: null, reason: subject });
  });
});

describe('checkpointRefTimestampMs', () => {
  test('reads the millisecond stamp out of a snapshot ref', () => {
    expect(checkpointRefTimestampMs(`${CHECKPOINT_REF_PREFIX}/1700000000000-0`))
      .toBe(1700000000000);
    expect(checkpointRefTimestampMs(`${CHECKPOINT_REF_PREFIX}/1700000000000-zz9`))
      .toBe(1700000000000);
  });

  test('non-conforming refs sort as epoch 0 rather than throwing or returning NaN', () => {
    expect(checkpointRefTimestampMs('refs/heads/main')).toBe(0);
    // 12 digits is not a millisecond stamp.
    expect(checkpointRefTimestampMs(`${CHECKPOINT_REF_PREFIX}/170000000000-1`)).toBe(0);
    // The stamp must terminate the ref — a trailing path segment is not a seq.
    expect(checkpointRefTimestampMs(`${CHECKPOINT_REF_PREFIX}/1700000000000-1/extra`)).toBe(0);
  });
});

describe('store-format constants pinned by the pc-agent daemon mirror', () => {
  test('ref prefix and workdir marker are the documented literals', () => {
    expect(CHECKPOINT_REF_PREFIX).toBe('refs/proteus');
    expect(CHECKPOINT_WORKDIR_MARKER).toBe('PROTEUS_WORKDIR');
  });

  test('excludes cover the generated trees a snapshot must never capture', () => {
    // .git/ in particular: snapshotting it into a bare store recurses the repo.
    for (const entry of ['.git/', 'node_modules/', 'dist/', '.venv/', '*.log'] as const) {
      expect(CHECKPOINT_EXCLUDES).toContain(entry);
    }
    expect(new Set(CHECKPOINT_EXCLUDES).size).toBe(CHECKPOINT_EXCLUDES.length);
  });
});

/**
 * The staging diagnosis, over git's own stderr.
 *
 * The engine test in cli-backend provokes the real git for the tolerated case;
 * what it cannot provoke deterministically is a staging failure that is NOT a
 * permission denial, and that is the half the distinction is made of. A parse
 * that called everything tolerable would swallow the failures this exists to
 * keep reporting.
 */
describe('diagnoseStaging', () => {
  // Verbatim from `git add -A --ignore-errors` (git 2.53) over a work tree with
  // a mode-000 directory and a mode-000 file.
  const DENIALS = [
    "warning: could not open directory 'systemd-private-abc/': Permission denied",
    'error: open("locked.txt"): Permission denied',
    "error: unable to index file 'locked.txt'",
  ].join('\n');

  test('names the unreadable paths once each, sorted, and explains every line', () => {
    expect(diagnoseStaging(DENIALS)).toEqual({
      unreadable: ['locked.txt', 'systemd-private-abc'],
      unexplained: [],
    });
  });

  test('clean stderr is neither unreadable nor unexplained', () => {
    expect(diagnoseStaging('')).toEqual({ unreadable: [], unexplained: [] });
  });

  test("git's abort summary is explained only by a denial it can follow", () => {
    // The line `add` prints WITHOUT --ignore-errors. It restates the denials
    // above it and adds nothing…
    expect(diagnoseStaging(`${DENIALS}\nfatal: adding files failed`).unexplained).toEqual([]);
    // …but on its own it is a staging failure with no explanation, and a caller
    // that treated it as tolerable would commit a truncated tree.
    expect(diagnoseStaging('fatal: adding files failed').unexplained)
      .toEqual(['fatal: adding files failed']);
  });

  test('an unindexable file that was never denied is reported, not tolerated', () => {
    // `unable to index file` covers more than permissions — a vanished or
    // unreadable-for-another-reason path lands here too.
    expect(diagnoseStaging("error: unable to index file 'other.txt'")).toEqual({
      unreadable: [],
      unexplained: ["error: unable to index file 'other.txt'"],
    });
  });

  test('a real staging failure alongside a denial is still reported', () => {
    const mixed = `${DENIALS}\nerror: unable to write new index file`;
    expect(diagnoseStaging(mixed).unreadable).toEqual(['locked.txt', 'systemd-private-abc']);
    expect(diagnoseStaging(mixed).unexplained).toEqual(['error: unable to write new index file']);
  });
});

describe('checkpointReason', () => {
  test('an uneventful snapshot records the reason unchanged', () => {
    expect(checkpointReason('pre-mutation', [])).toBe('pre-mutation');
  });

  test('skipped paths are named in the record, so an incomplete snapshot says so', () => {
    expect(checkpointReason('file write', ['locked.txt', 'systemd-private-abc']))
      .toBe('file write [skipped 2 unreadable: locked.txt systemd-private-abc]');
  });

  test('a directory full of them stays one readable line', () => {
    expect(checkpointReason('shell exec', ['a', 'b', 'c', 'd', 'e']))
      .toBe('shell exec [skipped 5 unreadable: a b c +2 more]');
  });

  test('the note survives the subject round trip as part of the reason', () => {
    const reason = checkpointReason('file write', ['locked.txt']);
    expect(parseCheckpointSubject(checkpointSubject(meta, reason)).reason).toBe(reason);
  });
});
