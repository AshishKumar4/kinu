/**
 * The Lean citation gate's decision logic, proven RED in every direction it claims to
 * govern and green on the shapes it must not fire on.
 *
 * WHY EVERY FIXTURE IS ASSEMBLED AT RUNTIME. `lean-citations.ts` deliberately carries
 * no self-skip, so this file is scanned like any other, and a fixture written as a literal
 * citation would be a finding the gate reports against its own test. Greening that
 * would mean deleting the proof. So a name and a locator never meet in these bytes:
 * they meet inside `nameFirst` and `pathFirst` at run time, and no placeholder module
 * is spelled here at all, because a placeholder resolves to nothing and a path that
 * resolves to nothing is exactly what the module scan reports.
 *
 * WHAT THE TWO HOLES WERE. The name pattern required the module path to appear BEFORE
 * the theorem name, and the specification prose citing this corpus was written the
 * other way round — name first, locator in parentheses after — so nine of those
 * citations were invisible and a rename of any one passed clean. Separately, a line
 * RANGE was checked at its start only, which made any in-range number satisfy any
 * range: eighteen range ends were ungoverned.
 *
 * The false-positive controls at the bottom are the load-bearing half of the
 * order-independence fix, and the shape they defend is one this tree produced: a
 * design document PROPOSES a preservation theorem by name that no Lean source
 * declares yet. A rule loose enough to read that as a citation would fail the tree
 * for naming a design proposal, and the gate's own header names three more of the
 * same shape.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  auditCitations, auditCoverage, citations, isGovernedCitationFile, type Citations,
} from './lean-citations';
import { isTextSource, isVendoredSource, trackedFiles } from './sources';
import { LADDER } from './ladder';
import { stringValues, tsDeclarations } from '../lean/ts-refs.mjs';

const repoRoot = resolve(import.meta.dir, '..');

/** Real modules, so a fixture exercises resolution rather than mocking it. */
const ARBITRATION = 'lean/Kinu/Exploration/Arbitration.lean';

const STORAGE = 'MCTS/StorageIsolation.lean';

/** A line comfortably past the end of any module in the tree. */
const PAST_END = 99_999;

/** A theorem the tree declares, in `ARBITRATION`, at the line the docs cite. */
const LIVE = `accepted_respects_${'context'}`;

const LIVE_LINE = 200;

/** A theorem spelling nothing in the tree declares. */
const UNDECLARED = `accepted_respects_${'decorrelate'}`;

/** A theorem that exists, but in `STORAGE` rather than in `ARBITRATION`. */
const ELSEWHERE = `init_${'isolated'}`;

/** NAME FIRST: the documentation habit — an identifier as a code span, then its
 *  locator in parentheses immediately after. The shape that was invisible. */
function nameFirst(name: string, locator: string): string {
  return `\`${name}\` (\`${locator}\`) proves the thing it says.`;
}

/** PATH FIRST: the TypeScript-header habit, in BOTH spellings the tree uses — the
 *  colon form and the dash form. Both from one place, so every red direction is
 *  proven against each rather than against whichever spelling was handy. */
function pathFirst(locator: string, name: string): readonly string[] {
  return [`Formal spec: ${locator}:${name}`, `Formal spec: ${locator} — ${name}`];
}

/** One fixture file, audited exactly as the gate audits a corpus entry. A fresh
 *  context per call, so counters and findings never leak between directions. */
function audit(text: string): string[] {
  return auditCitations('docs/FIXTURE.md', text, citations());
}

describe('a theorem name the tree does not declare', () => {
  test('NAME FIRST is caught — the hole this gate was blind to', () => {
    const findings = audit(nameFirst(UNDECLARED, `${ARBITRATION}:${String(LIVE_LINE)}`));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain(UNDECLARED);
    expect(findings[0]).toContain('which no Lean source declares');
  });

  test('PATH FIRST is still caught, in both spellings — no regression', () => {
    for (const text of pathFirst(ARBITRATION, UNDECLARED)) {
      const findings = audit(text);
      expect(findings).toHaveLength(1);
      expect(findings[0]).toContain('which no Lean source declares');
    }
  });

  test('a name that moved module is caught in either order', () => {
    for (const text of [nameFirst(ELSEWHERE, ARBITRATION), ...pathFirst(ARBITRATION, ELSEWHERE)]) {
      const findings = audit(text);
      expect(findings).toHaveLength(1);
      expect(findings[0]).toContain('the theorem moved and the citation did not');
    }
  });
});

describe('a line range whose end outlived the module', () => {
  test('an out-of-range END is caught — the endpoint nothing checked', () => {
    const findings = audit(`see ${ARBITRATION}:${String(LIVE_LINE)}-${String(PAST_END)} for it`);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain(String(PAST_END));
    expect(findings[0]).toContain('the citation outlived it');
  });

  test('an out-of-range START is still caught — no regression', () => {
    const findings = audit(`see ${ARBITRATION}:${String(PAST_END)} for it`);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain(String(PAST_END));
  });

  test('a range gone at both ends is ONE finding naming both', () => {
    const findings = audit(`see ${ARBITRATION}:${String(PAST_END)}-${String(PAST_END + 1)} for it`);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain(`${String(PAST_END)} and ${String(PAST_END + 1)}`);
  });

  test('an in-range range passes at both ends', () => {
    expect(audit(`see ${ARBITRATION}:${String(LIVE_LINE)}-${String(LIVE_LINE + 3)} for it`))
      .toEqual([]);
  });
});

describe('a correct citation passes in either order', () => {
  test('NAME FIRST, with and without a locator', () => {
    expect(audit(nameFirst(LIVE, `${ARBITRATION}:${String(LIVE_LINE)}`))).toEqual([]);
    expect(audit(nameFirst(LIVE, ARBITRATION))).toEqual([]);
  });

  test('PATH FIRST, in both spellings', () => {
    for (const text of pathFirst(ARBITRATION, LIVE)) expect(audit(text)).toEqual([]);
  });

  test('a bare basename resolves, and the name is checked against the module', () => {
    expect(audit(nameFirst(ELSEWHERE, STORAGE))).toEqual([]);
  });

  test('both orders are COUNTED, which is what "newly governed" means', () => {
    const seen = citations();
    auditCitations('docs/FIXTURE.md', nameFirst(LIVE, ARBITRATION), seen);
    expect(seen.names).toBe(1);
    auditCitations('docs/FIXTURE.md', pathFirst(ARBITRATION, LIVE)[1], seen);
    expect(seen.names).toBe(2);
  });
});

/**
 * The controls. Order-independence is only worth having if it did not buy itself with
 * false positives, and the discriminator is stated on the name-first pattern: a code
 * span, snake_case, and a locator ADJACENT to it. Prose puts words in that gap.
 */
describe('the false positives that shaped the adjacency rule', () => {
  test('a proposed theorem name, in a paragraph full of modules, is not a citation', () => {
    // The shape: a design document proposes a preservation theorem by name for Lean
    // that does not exist yet, in a paragraph citing two real modules.
    const proposal = 'Proposed names, so the spec can cite one spelling: preservation theorem'
      + ` \`agent_node_transition_preserves_${'isolation'}\`, discharged by the same two-case`
      + ` rcases the .Expand case uses in ${STORAGE} and checked against ${ARBITRATION}.`;

    expect(audit(proposal)).toEqual([]);
  });

  test('a name separated from the locator by even one word is not a citation', () => {
    expect(audit(`\`${UNDECLARED}\` is discussed in (\`${ARBITRATION}\`) somewhere.`)).toEqual([]);
  });

  test("this gate's own account of the three defects it caught is not a citation", () => {
    // The gate's header names three stale citations it found on introduction. It has
    // no self-skip, so a rule that read these as citations would force the gate to
    // delete its own record of what it catches.
    const account = 'On introduction this gate found three stale citations: two modules named'
      + ` \`initial_${'valid'}\`, since renamed, and a test naming`
      + ` \`all_below_gives_${'empty'}\` and \`consolidation_requires_nonempty_${'guard'}\`,`
      + ` which have never existed. The modules involved were ${ARBITRATION} and ${STORAGE}.`;

    expect(audit(account)).toEqual([]);
  });

  test('a lowercase word in a code span is not read as a theorem', () => {
    // Without the path-first anchor the underscore does the discriminating, so an
    // English word in backticks beside a real module must stay invisible.
    expect(audit(`the \`branch\` field (\`${ARBITRATION}\`) is a Nat.`)).toEqual([]);
  });
});

describe('the gate cannot certify an empty scan', () => {
  test('no module and no name reference is itself a finding', () => {
    expect(auditCoverage(citations())[0]).toContain('certifies nothing');
  });

  test('a real scan clears it', () => {
    const seen: Citations = citations();
    auditCitations('docs/FIXTURE.md', nameFirst(LIVE, ARBITRATION), seen);
    expect(auditCoverage(seen)).toEqual([]);
  });
});

describe('the corpus this gate governs', () => {
  test('a Kinu source is governed and a vendored one is not', () => {
    expect(isGovernedCitationFile('packages/core/src/mcts/engine.ts')).toBe(true);
    expect(isGovernedCitationFile('packages/agent-core/dist/agents/runs/turn.d.ts')).toBe(false);
    expect(isGovernedCitationFile('lean/Kinu/MCTS/Arbitration.lean')).toBe(false);
  });

  test('the vendored half is not vacuous — the tree really carries such files', () => {
    // Without this, deleting the vendored package would leave a skip that can no
    // longer fire, which reads as enforcement and enforces nothing.
    const vendored = trackedFiles().filter((file) => isTextSource(file) && isVendoredSource(file));
    expect(vendored.length).toBeGreaterThan(0);
    expect(vendored.every((file) => !isGovernedCitationFile(file))).toBe(true);
  });
});

describe('the CI tier runs this gate on every commit', () => {
  /**
   * This gate's corpus is every tracked TEXT source, and citations really do live outside `lean/`: `docs/`,
   * `scripts/`, `packages/core/tests/` and `bench/corpus/patches/`. Any trigger narrower than every commit would let a
   * broken citation reach `main` with no Lean gate having run. The Lean row is a ci-tier row, which armada runs on
   * every commit, and its inputs are `live`, so no proof an earlier commit recorded stands in for it.
   */
  test('the Lean row runs at the CI tier, on armada, never from a recorded proof', () => {
    const row = LADDER.find((gate) => gate.run === 'bun run verify:lean');

    expect({ tier: row?.tier, inputs: row?.inputs.kind, here: row?.here }).toEqual({ tier: 'ci', inputs: 'live', here: undefined });
  });

  test('every gate the runner runs is itself inside the corpus it reads', () => {
    // The gate programs are text sources too. Neither `scripts/lean-citations.ts` nor `lean/check-traceability.mjs`
    // appeared in the old workflow's path filter, so a change to either shipped without running.
    const corpus = new Set(trackedFiles().filter(isTextSource));
    const runner = 'scripts/verify-lean.sh';
    const script = readFileSync(resolve(repoRoot, runner), 'utf8');
    const gates = [runner, 'scripts/lean-citations.ts', 'lean/check-traceability.mjs', 'lean/check-no-false.sh'];

    expect(gates.filter((gate) => !corpus.has(gate))).toEqual([]);

    // And the runner really invokes each of the three, so this list is not a guess about what CI runs.
    for (const gate of ['lean-citations.ts', 'check-traceability.mjs', 'check-no-false.sh']) {
      expect(script).toContain(gate);
    }
  });
});

describe('a tsRef resolves through the parse, not a hand lexer', () => {
  test('a declaration after a template nested inside a substitution is still declared', () => {
    const source = [
      "const types = `declare namespace workspace ${slate === undefined ? '' : `{ slates: Slate }`}`;",
      'export function createExecutor(opts: { a: string }): void {}',
      '',
    ].join('\n');

    expect([...tsDeclarations('fixture.ts', source).keys()]).toEqual(['types', 'createExecutor']);
  });

  test('members are the owner\'s own, and a function owns none', () => {
    const declarations = tsDeclarations('fixture.ts', [
      'export class Store { readonly rows = 1; open(): void { const local = 2; } }',
      "export interface Floor { kind: 'min' | 'max'; }",
      "export const KINDS = ['a', 'b'] as const;",
      'export const run = () => { const hidden = 1; };',
      '',
    ].join('\n'));

    expect([...(declarations.get('Store')?.members.keys() ?? [])]).toEqual(['rows', 'open']);
    expect(stringValues(declarations.get('Floor')?.members.get('kind'))).toEqual(['min', 'max']);
    expect(stringValues(declarations.get('KINDS')?.node)).toEqual(['a', 'b']);
    expect(declarations.get('run')?.members.size).toBe(0);
  });

  test('a file that does not parse resolves nothing', () => {
    expect(() => tsDeclarations('fixture.ts', 'export const x = `unterminated')).toThrow(SyntaxError);
  });
});
