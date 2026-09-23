// The publication seal over every surface, not one table. Two legs:
//   1. The gate is total over PUBLICATION_SURFACES: a per-surface exception goes red.
//   2. Every value import and durable write in mcts/convergence.ts is classified as a
//      publication surface or as disclosure, checked against the source.
// Not asserted: that each live writer calls the gate.
// Specified by docs/EXPLORATION.md — "The publication seal" and "The records
// store".
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

const REPO = resolve(import.meta.dir, '../../..');

const read = (path: string): string => readFileSync(resolve(REPO, path), 'utf8');

const SETTLE = 'packages/core/src/mcts/convergence.ts';

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

const sealed: PublicationState = { kind: 'sealed', breach, clearedBy: null };

const cleared: PublicationState = {
  kind: 'sealed',
  breach,
  clearedBy: {
    floor: { ...breach.floor, value: 600, proof: 'the bound counted one token per call; a call touches two' },
    adjudication: 'floor_wrong — the certificate double-counted, the verifier was sound',
    at: 1_700_000_000_000,
  },
};

/** Source with comments and imports stripped: a mention in prose is not a call. */
function callableSource(text: string): string {
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/^import[\s\S]*?from\s+'[^']*';$/gm, '');
}

const DISCLOSURE = 'disclosure: ';

/** A classification that is not a publication surface; a type guard so narrowing does the work. */
function isDisclosure(
  verdict: PublicationSurface | `disclosure: ${string}`,
): verdict is `disclosure: ${string}` {
  return verdict.startsWith(DISCLOSURE);
}

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

  test('a RECORDED re-derivation reopens every surface — retroactive publication, in *The publication seal*', () => {
    const admitted = PUBLICATION_SURFACES.filter(
      (surface) => admitsPublication(cleared, surface).kind === 'admitted',
    );

    expect([...admitted].sort()).toEqual([...PUBLICATION_SURFACES].sort());
  });

  test('the enumeration has no duplicates and names the cross-workspace channel', () => {
    expect(new Set(PUBLICATION_SURFACES).size).toBe(PUBLICATION_SURFACES.length);
    // Pinned by name: the cross-workspace channel.
    expect(PUBLICATION_SURFACES).toContain('experience_library');
  });
});

describe("the settle path's egress is classified, not discovered", () => {
  // The seal covers what carries the claim, never what carries the caveat: suppressing a
  // diagnostic is how a breach goes silent.
  const EGRESS = {
    // Vector-indexed: an input to future inference.
    'memory.append': 'memory',
    'memory.index': 'memory',
    // A breach on a minimise objective normalises high, so a breach makes this more likely to fire.
    maybeStoreCraftedTool: 'craft',
    // Scaffold error-rate monitoring reads it, so a laundered score can move a scaffold decision.
    recordTaskOutcome: 'task_history',
    'INSERT INTO task_history': 'task_history',
    // Turn-scoped and purged when unclaimed (mcts/takes.ts).
    captureAlternateTakes: 'disclosure: turn-scoped near-ties, purged when unclaimed',
    // FloorRederivation re-evaluates the tree; sealing it would destroy the recovery path.
    abandonSearchTree: 'disclosure: run-keyed tree status, the re-evaluation input',
    'UPDATE search_nodes': 'disclosure: run-keyed tree status, the re-evaluation input',
    // Declared so a new import cannot arrive unclassified.
    isCraftable: 'disclosure: predicate, writes nothing',
    findNearTiedRivals: 'disclosure: read over the population',
    searchTree: 'disclosure: read of the search tree, writes nothing',
    inPopulation: 'disclosure: predicate, writes nothing',
    selectWinnerByTest: 'disclosure: selection, writes nothing durable',
    DEFAULT_CONFIG: 'disclosure: constants',
    EVIDENCE_BUDGETS: 'disclosure: constants',
    evidenceWindow: 'disclosure: pure truncation',
    isoDate: 'disclosure: pure formatting',
  } satisfies Record<string, PublicationSurface | `disclosure: ${string}`>;

  /** The settle entry point; its direct writes are collected as signatures, not as itself. */
  const ENTRY = 'converge';

  /** Value imports, writing local helpers, and directly written tables, read from source. */
  function observedEgress(): string[] {
    const source = read(SETTLE);
    const found = new Set<string>();

    for (const match of source.matchAll(/^import (?!type )\{([^}]+)\} from/gm)) {
      for (const raw of (match[1] ?? '').split(',')) {
        const name = raw.trim().replace(/^type\s+/, '');

        if (name.length > 0) found.add(name);
      }
    }

    const callable = callableSource(source);
    const WRITE = /\b(?:INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\b|\bmemory\.(?:append|index)\s*\(/i;
    // Split at top-level declarations, so each segment is one function body.
    const segments = callable.split(/^(?:export )?(?:async )?function (\w+)/gm);

    for (let i = 1; i < segments.length; i += 2) {
      const name = segments[i] ?? '';

      if (name === ENTRY) continue;

      if (WRITE.test(segments[i + 1] ?? '')) found.add(name);
    }

    for (const match of callable.matchAll(/\bmemory\.(append|index)\s*\(/g)) {
      found.add(`memory.${match[1]}`);
    }

    for (const match of callable.matchAll(
      /\b(INSERT\s+(?:OR\s+\w+\s+)?INTO|UPDATE|DELETE\s+FROM)\s+([a-z_]+)/gi,
    )) {
      const verb = (match[1] ?? '').replace(/\s+/g, ' ').toUpperCase();
      found.add(`${verb} ${match[2]}`);
    }

    return [...found].sort();
  }

  test('every egress the settle path has is declared — a new one is red until classified', () => {
    expect(observedEgress()).toEqual(Object.keys(EGRESS).sort());
  });

  test('every publication classification names a member of the enumeration', () => {
    const surfaces = new Set<string>(PUBLICATION_SURFACES);

    for (const [egress, verdict] of Object.entries(EGRESS)) {
      if (isDisclosure(verdict)) continue;
      expect(surfaces.has(verdict), `${egress} classified as unknown surface ${verdict}`).toBe(true);
    }
  });

  test('every surface the settle path reaches is refused under a seal', () => {
    const reached = new Set<PublicationSurface>();

    for (const verdict of Object.values(EGRESS)) {
      if (!isDisclosure(verdict)) reached.add(verdict);
    }

    // Asserted whole: absence here is the defect.
    expect([...reached].sort()).toEqual(['craft', 'memory', 'task_history']);

    for (const surface of reached) {
      expect(admitsPublication(sealed, surface).kind).toBe('refused');
    }
  });

  test('a disclosure classification states its reason rather than asserting itself', () => {
    for (const [egress, verdict] of Object.entries(EGRESS)) {
      if (!isDisclosure(verdict)) continue;
      expect(verdict.slice(DISCLOSURE.length).length, `${egress} has an empty reason`)
        .toBeGreaterThan(8);
    }
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

  test('an open run and a cleared seal disclose nothing, because nothing was suppressed', () => {
    expect(carrySuppression(open, 'elites', 4)).toBeNull();
    expect(carrySuppression(cleared, 'elites', 4)).toBeNull();
  });
});
