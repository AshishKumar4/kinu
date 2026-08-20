/**
 * The doc-claim gate's decision logic, proven RED in every direction it claims to
 * govern and GREEN in the matching control.
 *
 * A gate is only worth its cost if a violation actually fails it, and the direction
 * that matters most here is the SECOND one: a check that fires on a true claim gets
 * switched off, and switching this one off takes both shapes with it. So every
 * assertion below comes in a pair — the stale claim is caught, and the live claim
 * beside it is not.
 *
 * The fixtures are audited as synthetic text against the REAL index, so resolution
 * is exercised rather than mocked: `readSwarmConfig` is a name this tree uses and
 * `packages/core/src/tools/registry.ts` is a file it has, so a green result means
 * the resolver found them rather than that a stub said yes.
 *
 * The register's own directions are here too, and they are the reason the register
 * is not an allowlist. `lean-citations.ts` needs two independent conditions before
 * an illustration is honoured, and its one-line reason is the reason this design was
 * copied: the declaration alone is a skip. Both halves are proven separately below,
 * plus the residual that refuses an entry naming something the tree actually has.
 */

import { describe, expect, test } from 'bun:test';
import {
  type Absence, type Claims, type Enumeration,
  auditCoverage, auditDocument, auditRegister, claims,
} from './doc-claims';

/** One index, built once. It reads the whole tree, so building it per test would
 *  cost more than the gate it tests. */
const INDEX: readonly Enumeration[] = [
  {
    nouns: ['actions'],
    owner: 'agents',
    declares: 'packages/core/src/tools/registry.ts:AGENTS_TOOL_ACTIONS',
    members: 7,
    reason: 'The fixture enumeration: seven, as the declaration has.',
  },
];

const built = claims(INDEX);

/** A fresh context per direction, sharing the expensive index. Counters and
 *  validated register entries must never leak between fixtures. */
function context(enumerations: readonly Enumeration[] = INDEX): Claims {
  return { ...built, enumerations, absences: new Map(), paths: 0, names: 0, counts: 0, absenceSites: 0, ambiguous: 0 };
}

const audit = (text: string, seen: Claims = context()): string[] =>
  auditDocument('docs/FIXTURE.md', text, seen).map((claim) => claim.key);

/** A name the tree does not use. Split so this file does not itself contain the
 *  token as one string, which would make the gate's own test a claim it governs. */
const DELETED = `resumable${'ForkInput'}`;
/** A name the tree does use, from `strategy/swarm.ts`. */
const LIVE = 'NAMED_SWARM_PRESETS';
/** Another, camelCase, so both arms of the name filter are exercised live. */
const LIVE_CAMEL = 'runSwarmAction';

describe('a symbol a document names', () => {
  test('is caught when the code has no such identifier', () => {
    expect(audit(`The runner calls \`${DELETED}\` before it settles.`))
      .toEqual([`docs/FIXTURE.md: symbol ${DELETED}`]);
  });

  test('passes when the code declares it', () => {
    expect(audit(`The runner reads \`${LIVE}\` and \`${LIVE_CAMEL}\` first.`)).toEqual([]);
  });

  test('is read out of a dotted member path, so an owner is checked too', () => {
    expect(audit(`Nothing reads \`${DELETED}.registry\` in production.`))
      .toEqual([`docs/FIXTURE.md: symbol ${DELETED}`]);
  });

  test('is not read when the span names a Lean module, which is another gate\'s domain', () => {
    // `lean-citations.ts` resolves both halves of a Lean citation against the Lean
    // scanner. Reading `StorageIsolation` here would judge a Lean module name
    // against a TypeScript index that never held it — and the same document names a
    // real defect one line away, so the two must not be conflated.
    expect(audit('| Isolation | `StorageIsolation.lean` | `init_isolated` |')).toEqual([]);
    expect(audit('Proven in Lean: the `StorageIsolated` invariant.'))
      .toEqual(['docs/FIXTURE.md: symbol StorageIsolated']);
  });

  test('is not read when it carries an underscore, for the same reason', () => {
    // A theorem name reaches a table cell with no `.lean` beside it at all.
    expect(audit('| the sum holds | `applyRewards_sum_invariant` | proved |')).toEqual([]);
  });

  test('is counted, so a green result is not an empty scan', () => {
    const seen = context();
    audit(`\`${LIVE}\` and \`${LIVE_CAMEL}\` both resolve.`, seen);
    expect(seen.names).toBe(2);
  });
});

describe('a path a document names', () => {
  test('is caught when no tracked file matches it', () => {
    expect(audit('The bridge lives in `cf-backend/src/subordinate-support.ts`.'))
      .toEqual(['docs/FIXTURE.md: path cf-backend/src/subordinate-support.ts']);
  });

  test('passes in the fully qualified spelling', () => {
    expect(audit('See `packages/core/src/tools/registry.ts` for the table.')).toEqual([]);
  });

  test('passes in the package shorthand the tree actually writes', () => {
    // `core/extension.ts` is how twelve live claims in docs/EXTENSIBILITY.md are
    // spelled. Requiring the long form would have failed every one of them.
    expect(audit('The contract is `core/extension.ts`, wired per turn.')).toEqual([]);
  });

  test('passes under the workspace scope', () => {
    expect(audit('Imported from `@kinu/core/tools/registry.ts`.')).toEqual([]);
  });

  test('is not governed when it names no location in this tree', () => {
    // A bare basename, a served route and build output are all real and none of
    // them is a repository path: `SOUL.md` and `agent.js` are written into a
    // workspace VFS, `/install.sh` is served by a route, `dist/` is build output.
    // Governing any of them would make the gate wrong about a true sentence.
    expect(audit('The agent reads `SOUL.md` and runs `agent.js`.')).toEqual([]);
    expect(audit('Fetch `/downloads/kinu-version.json`, then run `/install.sh`.'))
      .toEqual([]);
    expect(audit('The bundle lands in `dist/kinu/wrangler.json`.')).toEqual([]);
  });
});

describe('a count a document states', () => {
  test('is caught when it disagrees with the enumeration', () => {
    expect(audit('The `agents` tool has eight actions.'))
      .toEqual(['docs/FIXTURE.md: count 8 actions']);
  });

  test('passes when it agrees', () => {
    expect(audit('The `agents` tool has seven actions.')).toEqual([]);
  });

  test('is caught when written in digits too', () => {
    expect(audit('`agents` exposes 12 actions.')).toEqual(['docs/FIXTURE.md: count 12 actions']);
  });

  test('is not read as a total when the sentence marks it a subset', () => {
    // README.md reads "The other six actions are hire, ask, send, reply, list and
    // dismiss". That is true of seven and would otherwise arrive as a count of six.
    expect(audit('`agents` runs the search. The other six actions address agents that exist.'))
      .toEqual([]);
  });

  test('is not governed when no owner disambiguates it', () => {
    const seen = context();
    expect(audit('Delegation is one tool with eight actions.', seen)).toEqual([]);
    expect(seen.ambiguous).toBe(1);
  });

  test('reads an adjective as part of the phrase, so two counts of one thing stay apart', () => {
    // The defect this exists for: `SWARM_PRESETS` has seven tokens and
    // `NAMED_SWARM_PRESETS` has six, so "six named presets" is true and "seven named
    // presets" is the error that reached three documents. A rule that skipped
    // adjectives would have swapped the two verdicts.
    const enumerations: readonly Enumeration[] = [
      {
        nouns: ['presets'],
        owner: undefined,
        declares: 'packages/core/src/strategy/swarm.ts:SWARM_PRESETS',
        members: 7,
        reason: 'Every token the field accepts.',
      },
      {
        nouns: ['named presets'],
        owner: undefined,
        declares: 'packages/core/src/strategy/swarm.ts:NAMED_SWARM_PRESETS',
        members: 6,
        reason: 'Everything `from` may point at.',
      },
    ];
    expect(audit('There are six named presets and seven presets.', context(enumerations)))
      .toEqual([]);
    expect(audit('There are seven named presets.', context(enumerations)))
      .toEqual(['docs/FIXTURE.md: count 7 named presets']);
  });

  test('is not read out of a fenced block, where the numbers are the example', () => {
    expect(audit(['Registering one looks like:', '', '```ts',
      '// the agents surface once had eight actions', "const actions = ['a'];", '```',
    ].join('\n'))).toEqual([]);
    expect(audit('`agents` gained eight actions.'))
      .toEqual(['docs/FIXTURE.md: count 8 actions']);
  });
});

describe('the register cannot launder a stale claim', () => {
  /** A real entry: `AGENTS.md` does contain this VFS path, and the tree does not. */
  const REAL: Absence = {
    file: 'AGENTS.md',
    cites: 'scaffold/agent.js',
    reason: 'A path inside the workspace VFS, not in this repository.',
  };

  test('an entry naming something the tree HAS is refused, and the claim stays live', () => {
    const seen = context();
    const findings = auditRegister(seen, [{
      file: 'AGENTS.md',
      cites: 'packages/core/src/tools/registry.ts',
      reason: 'Pretending a live module is absent.',
    }]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('but the tree has it');
    expect(seen.absences.size).toBe(0);
  });

  test('an entry whose document no longer contains the string is refused', () => {
    const findings = auditRegister(context(), [{
      file: 'AGENTS.md',
      cites: `\`${DELETED}\``,
      reason: 'A declaration that outlived its prose.',
    }]);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain('which no longer contains it');
  });

  test('an entry with no reason is refused', () => {
    const findings = auditRegister(context(), [{ ...REAL, reason: '' }]);
    expect(findings).toEqual([expect.stringContaining('states no reason')]);
  });

  test('a valid entry needs documenting prose AT THE SITE, so the declaration alone is a skip', () => {
    const seen = context();
    expect(auditRegister(seen, [REAL])).toEqual([]);

    // Same declaration, same claim, two sites. The paragraph that explains the
    // absence is honoured; the one that just names the file is still checked.
    const documented = 'The scaffold is a row in the workspace VFS: `scaffold/agent.js`.';
    expect(auditDocument('AGENTS.md', documented, seen)).toEqual([]);
    expect(seen.absenceSites).toBe(1);

    const bare = 'The default agent uses `scaffold/agent.js` and facets do not.';
    expect(auditDocument('AGENTS.md', bare, seen).map((claim) => claim.key))
      .toEqual(['AGENTS.md: path scaffold/agent.js']);
  });

  test('an entry for one document does not exempt the same claim in another', () => {
    const seen = context();
    expect(auditRegister(seen, [REAL])).toEqual([]);
    const text = 'The scaffold lives in the workspace VFS at `scaffold/agent.js`.';
    expect(audit(text, seen)).toEqual(['docs/FIXTURE.md: path scaffold/agent.js']);
  });
});

describe('the enumeration register judges itself', () => {
  test('a declaration the named file does not contain is refused', () => {
    const findings = auditRegister(context([{
      nouns: ['actions'],
      owner: 'agents',
      declares: `packages/core/src/tools/registry.ts:${DELETED}`,
      members: 7,
      reason: 'The enumeration moved and the register did not.',
    }]), []);
    expect(findings).toEqual([expect.stringContaining('does not contain')]);
  });

  test('a path that is not tracked is refused', () => {
    const findings = auditRegister(context([{
      nouns: ['actions'],
      owner: 'agents',
      declares: 'packages/core/src/tools/gone.ts:AGENTS_TOOL_ACTIONS',
      members: 7,
      reason: 'A file that does not exist.',
    }]), []);
    expect(findings).toEqual([expect.stringContaining('does not name a tracked file')]);
  });

  test('an empty enumeration is refused, because a count check over it cannot fail', () => {
    const findings = auditRegister(context([{
      nouns: ['actions'],
      owner: 'agents',
      declares: 'packages/core/src/tools/registry.ts:AGENTS_TOOL_ACTIONS',
      members: 0,
      reason: 'Nothing to count.',
    }]), []);
    expect(findings).toEqual([expect.stringContaining('enumerates nothing')]);
  });

  test('two enumerations sharing a phrase without distinct owners are refused', () => {
    const shared: Enumeration = {
      nouns: ['actions'],
      owner: undefined,
      declares: 'packages/core/src/tools/registry.ts:AGENTS_TOOL_ACTIONS',
      members: 7,
      reason: 'A phrase that could bind to either.',
    };
    const findings = auditRegister(context([shared, { ...shared, members: 3 }]), []);
    expect(findings).toEqual([expect.stringContaining('without distinct owners')]);
  });
});

describe('the gate cannot certify an empty scan', () => {
  test('a scan with no claims of some shape refuses to report clean', () => {
    expect(auditCoverage(context())).toEqual([expect.stringContaining('cannot fail')]);
  });

  test('a scan that saw all three shapes certifies', () => {
    const seen = context();
    seen.paths = 1;
    seen.names = 1;
    seen.counts = 1;
    expect(auditCoverage(seen)).toEqual([]);
  });
});
