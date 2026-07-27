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
  checkpointSubject,
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

  test('a missing turn or session degrades to its own placeholder', () => {
    expect(checkpointSubject({ turnId: 't1', sessionId: null }, 'r'))
      .toBe('turn=t1 session=- r');
    expect(checkpointSubject({ turnId: null, sessionId: 's1' }, 'r'))
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
    for (const entry of ['.git/', 'node_modules/', 'dist/', '.venv/', '*.log']) {
      expect(CHECKPOINT_EXCLUDES).toContain(entry);
    }
    expect(new Set(CHECKPOINT_EXCLUDES).size).toBe(CHECKPOINT_EXCLUDES.length);
  });
});
