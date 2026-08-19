/**
 * The Lean citation gate's decision logic, proven RED in every direction it claims to
 * govern and green on the shapes it must not fire on.
 *
 * WHY EVERY FIXTURE IS ASSEMBLED AT RUNTIME. `lean-citations.ts` deliberately carries
 * no self-skip — `literature-citations.ts` records that choice and calls it the better
 * one — so this file is scanned like any other, and a fixture written as a literal
 * citation would be a finding the gate reports against its own test. Greening that
 * would mean deleting the proof. So a name and a locator never meet in these bytes:
 * they meet inside `nameFirst` and `pathFirst` at run time, and no placeholder module
 * is spelled here at all, because a placeholder resolves to nothing and a path that
 * resolves to nothing is exactly what the module scan reports.
 *
 * WHAT THE TWO HOLES WERE. The name pattern required the module path to appear BEFORE
 * the theorem name, and every citation in `docs/EXPLORATION-SPEC.md` and
 * `docs/NODE-ISOLATION.md` is written the other way round — name first, locator in
 * parentheses after — so nine of them were invisible and a rename of any one passed
 * clean. Separately, a line RANGE was checked at its start only, which made any
 * in-range number satisfy any range: eighteen range ends were ungoverned.
 *
 * The false-positive controls at the bottom are the load-bearing half of the
 * order-independence fix, and one of them is live in the tree: `NODE-ISOLATION.md`
 * PROPOSES a preservation theorem by name that no Lean source declares yet. A rule
 * loose enough to read that as a citation would fail the tree for naming its own
 * design proposal, and the gate's own header names three more of the same shape.
 */

import { describe, expect, test } from 'bun:test';
import { auditCitations, auditCoverage, citations, type Citations } from './lean-citations';

/** Real modules, so a fixture exercises resolution rather than mocking it. */
const ARBITRATION = 'lean/Proteus/Exploration/Arbitration.lean';
const STORAGE = 'MCTS/StorageIsolation.lean';

/** A line comfortably past the end of any module in the tree. */
const PAST_END = 99_999;

/** A theorem the tree declares, in `ARBITRATION`, at the line the docs cite. */
const LIVE = `accepted_respects_${'decorrelate'}`;
const LIVE_LINE = 171;
/** The rename the exploration spec's own cut list proposes. Nothing declares it. */
const RENAMED = `accepted_respects_${'context'}`;
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
    const findings = audit(nameFirst(RENAMED, `${ARBITRATION}:${String(LIVE_LINE)}`));
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain(RENAMED);
    expect(findings[0]).toContain('which no Lean source declares');
  });

  test('PATH FIRST is still caught, in both spellings — no regression', () => {
    for (const text of pathFirst(ARBITRATION, RENAMED)) {
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
    // The live case: `docs/NODE-ISOLATION.md` proposes a preservation theorem by name
    // for Lean that does not exist yet, in a paragraph citing two real modules.
    const proposal = 'Proposed names, so the spec can cite one spelling: preservation theorem'
      + ` \`agent_node_transition_preserves_${'isolation'}\`, discharged by the same two-case`
      + ` rcases the .Expand case uses in ${STORAGE} and checked against ${ARBITRATION}.`;
    expect(audit(proposal)).toEqual([]);
  });

  test('a name separated from the locator by even one word is not a citation', () => {
    expect(audit(`\`${RENAMED}\` is discussed in (\`${ARBITRATION}\`) somewhere.`)).toEqual([]);
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
