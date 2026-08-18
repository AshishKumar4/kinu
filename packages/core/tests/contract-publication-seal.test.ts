// The publication seal, over every surface rather than over one table.
//
// This is the test that would have caught the audit's top finding. §4.4 stated
// the seal as reachability over RECORDS-STORE writes; §5.3 routed
// carry:'artifacts' through `experience_library` and called that publication
// "separate and unchanged". The Lean statement then VERIFIED and the laundering
// channel remained, because the theorem quantified over records-store actions
// and the laundering channel was not one of them: a true theorem about a false
// property. A run that breached its floor could publish cross-workspace while
// the leaderboard was sealed.
//
// So the property is stated over an ENUMERATION and this file holds three legs
// of it, each of which fails LOUDLY rather than passing by omission:
//
//   1. The gate is TOTAL over PUBLICATION_SURFACES. A per-surface exception —
//      the realistic future defect, `if (surface === 'craft') return admitted` —
//      shrinks the refused set and goes red.
//   2. The settle path's egress is CLASSIFIED. Every value import and every
//      durable write in mcts/convergence.ts is declared as a publication surface
//      or as disclosure, and the declaration is checked against the source.
//      `maybeStoreCraftedTool` is in that file today and nobody had classified
//      it, which is exactly how four live channels went unnoticed.
//   3. The code and §4.4's own table are SET-EQUAL, both directions, so a
//      surface added to one and not the other fails a test instead of decaying
//      back into prose.
//
// What is deliberately NOT asserted: that each live writer calls the gate. The
// spec does not make that wiring decision and five of the six surfaces have
// writers with no objective in scope. Leg 2 is what keeps that gap countable.
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

const SPEC = 'docs/EXPLORATION-SPEC.md';
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

/** A classification that is NOT a publication surface. A predicate rather than an
 *  inline `startsWith`, so narrowing does the work an assertion would otherwise
 *  have to claim. */
function isDisclosure(
  verdict: PublicationSurface | `disclosure: ${string}`,
): verdict is `disclosure: ${string}` {
  return verdict.startsWith(DISCLOSURE);
}

describe('the seal is total over the enumerated publication surfaces', () => {
  test('a sealed run is refused on EVERY surface, and the refused set is the whole enumeration', () => {
    // Collected as a set rather than asserted per surface, so a surface added to
    // the enumeration with a gate exception is a set mismatch rather than an
    // assertion nobody wrote. Removing one gate makes this red.
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

  test('a RECORDED re-derivation reopens every surface — §4.4 retroactive publication', () => {
    const admitted = PUBLICATION_SURFACES.filter(
      (surface) => admitsPublication(cleared, surface).kind === 'admitted',
    );
    expect([...admitted].sort()).toEqual([...PUBLICATION_SURFACES].sort());
  });

  test('the enumeration has no duplicates and names the cross-workspace channel', () => {
    expect(new Set(PUBLICATION_SURFACES).size).toBe(PUBLICATION_SURFACES.length);
    // The row the audit found. Its absence is the whole defect, so it is pinned
    // by name rather than left to the set-equality check to imply.
    expect(PUBLICATION_SURFACES).toContain('experience_library');
  });
});

describe("the settle path's egress is classified, not discovered", () => {
  // Every value import and every durable write in the settle path, each declared
  // as an enumerated publication surface or as DISCLOSURE with its reason. The
  // seal covers what carries the claim and never what carries the caveat:
  // suppressing a diagnostic is how a breach goes silent, which is the failure
  // §4.4 exists to prevent.
  const EGRESS = {
    // Publication. The winner's approach and its score, vector-indexed, so it is
    // an input to future inference rather than an artifact a human looks up.
    'memory.append': 'memory',
    'memory.index': 'memory',
    // Publication, and the sharpest row: admitted by `winner.value > 0.8`, and a
    // breach on a minimise objective measures suspiciously cheap, which
    // normalises HIGH. A breach makes this MORE likely to fire, not less.
    maybeStoreCraftedTool: 'craft',
    // Publication into a different subsystem's control loop: scaffold error-rate
    // monitoring reads it, so a laundered score can move a scaffold decision.
    recordTaskOutcome: 'task_history',
    'INSERT INTO task_history': 'task_history',
    // Not publication. Turn-scoped and purged when unclaimed, so no later run
    // can read it (mcts/takes.ts).
    captureAlternateTakes: 'disclosure: turn-scoped near-ties, purged when unclaimed',
    // Not publication. The tree is run-keyed history and it is what a
    // FloorRederivation re-evaluates; sealing it would destroy the recovery path.
    abandonSearchTree: 'disclosure: run-keyed tree status, the re-evaluation input',
    'UPDATE search_nodes': 'disclosure: run-keyed tree status, the re-evaluation input',
    // Reads and pure helpers. Declared so a NEW import cannot arrive unclassified.
    isCraftable: 'disclosure: predicate, writes nothing',
    findNearTiedRivals: 'disclosure: read over the population',
    selectWinnerByTest: 'disclosure: selection, writes nothing durable',
    DEFAULT_CONFIG: 'disclosure: constants',
    EVIDENCE_BUDGETS: 'disclosure: constants',
    evidenceWindow: 'disclosure: pure truncation',
    isoDate: 'disclosure: pure formatting',
  } satisfies Record<string, PublicationSurface | `disclosure: ${string}`>;

  /** The settle path's entry point. Its own direct writes are collected below as
   *  table and `memory.*` signatures; it is not an egress of itself. */
  const ENTRY = 'converge';

  /** What the settle path can actually reach: its value imports, the local
   *  helpers that write, and the tables it writes directly. Read from the source
   *  so the declaration cannot drift away from the code.
   *
   *  Local helpers matter as much as imports here — `recordTaskOutcome` and
   *  `abandonSearchTree` are defined in this file, and a census that only read
   *  imports would have missed `task_history` entirely. */
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
    // Three of the six, and every one of them is live code today: the audit
    // named only `experience_library`, which the settle path does not even reach
    // directly. Absence here is the defect, so the set is asserted whole.
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

describe('the code and §4.4 are set-equal', () => {
  /** The backticked surface names in §4.4's enumeration table. */
  function documentedSurfaces(): string[] {
    const spec = read(SPEC);
    const start = spec.indexOf('**The enumerated publication surfaces.**');
    expect(start, `${SPEC} has no §4.4 publication-surface enumeration`).toBeGreaterThan(-1);
    const table = spec.slice(start).split('\n\n').find((block) => block.startsWith('| surface |'));
    expect(table, `${SPEC}'s enumeration has no "| surface |" table`).toBeDefined();
    const names = new Set<string>();
    for (const row of (table ?? '').split('\n').slice(2)) {
      const first = /^\|\s*`([a-z_]+)`\s*\|/.exec(row);
      if (first?.[1] !== undefined) names.add(first[1]);
    }
    return [...names].sort();
  }

  test('§4.4 documents exactly the surfaces the code enumerates', () => {
    expect(documentedSurfaces()).toEqual([...PUBLICATION_SURFACES].sort());
  });

  test('§4.4 states the seal over publication, not over the records store alone', () => {
    const spec = read(SPEC);
    expect(spec).toContain('A publication write REQUIRES `PublicationState.kind');
  });

  test('the side door sentence survives only as a RETRACTION, never as a claim', () => {
    // The same split the design makes, one level up: forbid the CLAIM, permit the
    // CAVEAT. A flat ban on the string would stop the document quoting its own
    // retracted sentence, so a future author correcting a different side door
    // would have to paraphrase the words that were wrong — which is strictly less
    // useful to a reader than seeing them. `ObjectiveSpec` raised this against the
    // flat version and is right.
    const SIDE_DOOR = 'publication is separate and unchanged';
    const live = read(SPEC)
      .split('\n')
      .filter((line) => line.includes(SIDE_DOOR) && !line.includes('earlier revision'));
    expect(live, `${SIDE_DOOR} appears as a live claim, not as a retraction`).toEqual([]);
  });
});

describe('a seal that voids the carry axis says so, with a count', () => {
  test('PUBLISHING_CARRIES is a subset of the axis it narrows', () => {
    for (const carry of PUBLISHING_CARRIES) expect(SWARM_CARRIES).toContain(carry);
    // The two that publish, and only those: 'none' and 'reflections' write
    // nothing a later run reads, so a seal cannot void them.
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
    // §5.2's monotone best is why the count matters at all: a suppressed elite
    // means the NEXT run's carry starts from a worse one. A run that reached no
    // new best still had its axis voided, and null would hide that.
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
