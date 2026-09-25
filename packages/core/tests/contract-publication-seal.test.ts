// The publication seal over every surface, not one table: the gate is total over
// PUBLICATION_SURFACES, so a per-surface exception goes red. Which of the settle path's writes
// are publication is the publication-egress gate's classification (scripts/publication-egress.ts).
// Not asserted: that each live writer calls the gate.
// Specified by docs/EXPLORATION.md — "The publication seal" and "The records
// store".
import { describe, expect, test } from 'bun:test';
import {
  PUBLICATION_SURFACES,
  PUBLISHING_CARRIES,
  admitsPublication,
  carrySuppression,
  type FloorBreach,
  type PublicationState,
  type PublicationSurface,
} from '../src/strategy/objective';
import { SWARM_CARRIES } from '../src/strategy/swarm';

const breach: FloorBreach = {
  floor: {
    value: 1200,
    proof: 'every token appears in at least one call; a call touches two, so n/2 for the pair',
    kind: 'certificate',
    bestKnownHonest: 2992,
  },
  measured: { kind: 'measured', value: 900, detail: 'oracle calls on hard-majority-vote' },
  margin: 0.599,
  hypotheses: ['floor_wrong', 'verifier_gameable'],
};

const open: PublicationState = { kind: 'open' };

const sealed: PublicationState = { kind: 'sealed', breach };

describe('the seal is total over the enumerated publication surfaces', () => {
  test('a sealed run is refused on EVERY surface, and the refused set is the whole enumeration', () => {
    // Collected as a set so a surface with a gate exception is a set mismatch.
    const refused = new Set<PublicationSurface>();

    for (const surface of PUBLICATION_SURFACES) {
      const verdict = admitsPublication(sealed, surface);

      if (verdict.kind === 'refused') refused.add(verdict.surface);
    }

    expect([...refused].sort()).toEqual([...PUBLICATION_SURFACES].sort());
  });

  test('a refusal carries the breach, so the caller can disclose rather than guess', () => {
    for (const surface of PUBLICATION_SURFACES) {
      const verdict = admitsPublication(sealed, surface);
      expect(verdict).toEqual({ kind: 'refused', surface, breach });
    }
  });

  test('an open state admits every surface', () => {
    const admitted = PUBLICATION_SURFACES.filter(
      (surface) => admitsPublication(open, surface).kind === 'admitted',
    );

    expect([...admitted].sort()).toEqual([...PUBLICATION_SURFACES].sort());
  });

  test('the enumeration has no duplicates and names the cross-workspace channel', () => {
    expect(new Set(PUBLICATION_SURFACES).size).toBe(PUBLICATION_SURFACES.length);
    // Pinned by name: the cross-workspace channel.
    expect(PUBLICATION_SURFACES).toContain('experience_library');
  });
});

describe('a seal that voids the carry axis says so, with a count', () => {
  test('PUBLISHING_CARRIES is a subset of the axis it narrows', () => {
    for (const carry of PUBLISHING_CARRIES) expect(SWARM_CARRIES).toContain(carry);
    // 'none' and 'reflections' write nothing a later run reads.
    expect([...PUBLISHING_CARRIES].sort()).toEqual(['artifacts', 'elites']);
  });

  test('a sealed run discloses the suppression, the refused surfaces and the cell count', () => {
    const disclosed = carrySuppression(sealed, 'elites', 4);
    expect(disclosed).toEqual({
      carry: 'elites',
      breach,
      refused: [...PUBLICATION_SURFACES],
      suppressedCells: 4,
    });
  });

  test('zero suppressed cells is still a suppression — absent is not zero', () => {
    // A suppressed elite means the next run's carry starts from a worse one; null would hide it.
    const disclosed = carrySuppression(sealed, 'artifacts', 0);
    expect(disclosed).not.toBeNull();
    expect(disclosed?.suppressedCells).toBe(0);
    expect(disclosed?.carry).toBe('artifacts');
  });

  test('an open run discloses nothing, because nothing was suppressed', () => {
    expect(carrySuppression(open, 'elites', 4)).toBeNull();
  });
});
