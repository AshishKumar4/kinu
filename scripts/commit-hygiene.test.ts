/**
 * The gate that guards the commit-message convention.
 *
 * THE CORPUS IS REAL. Every true-positive case below is a commit message that
 * actually landed on `main`, read verbatim out of
 * `scripts/commit-hygiene.messages.jsonl` — extracted once with
 * `git log -1 --format=%B <sha>` and checked in, so the suite is hermetic and
 * survives the history rewrite that is renumbering those SHAs. A gate proven
 * against text invented to be rejected proves the invention, not the gate: this
 * repository has twice shipped a suite that passed over synthetic input while
 * the real defect walked past.
 *
 * The three CONTROL records matter most. Each is a real commit that must PASS:
 * they carry `Nimbus's`, `Cloudflare's` and `Vite's` — legitimate possessives of
 * real products — and one of them has a subject that is itself a binary
 * contrast, which this gate deliberately does not judge. A gate with false
 * positives gets disabled, and these are the messages that would produce them.
 *
 * `isCode` is INJECTED into `inspect`, so these assertions do not move when a
 * class is renamed in the tree. The live derivation is asserted separately, once,
 * against names whose status is a fact about the repository rather than about any
 * one file.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import * as v from 'valibot';
import {
  ALLOWED_PREFIXES, BLIND_SPOTS, GENERATED_SUBJECT, NAMES_WITHOUT_CODE, NARRATION, ROSTER,
  type Rule, SUBJECT_CEILING, cleanMessage, codeIdentifierTest, inspect, subjectOf,
  proseOnly,
} from './commit-hygiene';
import { isParseable, readMatching } from './sources';

const root = resolve(import.meta.dir, '..');

const RecordSchema = v.object({ sha: v.string(), why: v.string(), message: v.string() });

const MESSAGES = new Map(
  readFileSync(resolve(root, 'scripts/commit-hygiene.messages.jsonl'), 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const record = v.parse(RecordSchema, JSON.parse(line));
      return [record.sha, record] as const;
    }),
);

/**
 * The identifier set the assertions run against: the names these nine real
 * messages mention that ARE code in this repository. Fixed rather than derived,
 * so a rename cannot change a verdict here — the live derivation has its own test
 * below.
 */
const CODE: ReadonlySet<string> = new Set([
  'OrchestratorAgent', 'EvolutionEngine', 'TurnAccumulator', 'ExecutorProvider', 'NimbusWorkspace',
]);
const isCode = (name: string): boolean => CODE.has(name);

const rulesFor = (sha: string): Rule[] => {
  const record = MESSAGES.get(sha);
  if (record === undefined) throw new Error(`no fixture record for ${sha}`);
  return [...new Set(inspect(record.message, isCode).map((violation) => violation.rule))].sort();
};

describe('the fixture is the real thing', () => {
  test('nine real messages, each with its provenance and its reason', () => {
    // The empty-corpus pass: a fixture that failed to load would make every
    // assertion below vacuous, which is the exact shape this repository's gates
    // exist to refuse.
    expect(MESSAGES.size).toBe(9);
    for (const [sha, record] of MESSAGES) {
      expect(sha).toMatch(/^[0-9a-f]{10}$/);
      expect(record.message.trim().length).toBeGreaterThan(200);
      expect(record.why.length).toBeGreaterThan(20);
    }
  });
});

describe('a message that credits a named actor is refused', () => {
  test('a subagent possessive — SealSideDoor', () => {
    expect(rulesFor('fdfeb82213')).toEqual(['named-actor']);
  });

  test('the orchestrator by name, and a subagent beside it — Main, AxisErgonomics', () => {
    // `AxisErgonomics'` is a bare-apostrophe possessive, which is why the
    // pattern does not require the `s`.
    const violations = inspect(MESSAGES.get('34e094f98b')?.message ?? '', isCode);
    const named = violations.filter((violation) => violation.rule === 'named-actor');
    expect(named).toHaveLength(3);
    for (const name of ['Main', 'AxisErgonomics', 'FixtureZero']) {
      expect(named.some((violation) => violation.fix.includes(name))).toBe(true);
    }
  });

  test('`Main` fails even though no shape rule could reach a one-hump name', () => {
    expect(ROSTER).toEqual(['Main']);
    expect(inspect("fix(core): apply Main's ruling on the digest", isCode)
      .map((violation) => violation.rule)).toEqual(['named-actor']);
  });

  test('the three attribution shapes each fire on their own', () => {
    for (const message of [
      "fix(core): drop the second digest\n\nSpecAudit's finding, applied.",
      'fix(core): drop the second digest\n\nFound by SpecAudit while reading the pin.',
      'fix(core): drop the second digest\n\nSpecAudit reported it against the frozen text.',
    ]) {
      expect(inspect(message, isCode).map((violation) => violation.rule)).toEqual(['named-actor']);
    }
  });
});

describe('a legitimate product possessive PASSES — the false-positive control', () => {
  // This is the assertion that decides whether the gate survives contact with
  // real authors. All three are real commits.
  test.each([
    ['f9843f005e', "Nimbus's"],
    ['a6795ad6d6', "Cloudflare's"],
    ['801b3bce7f', "Vite's"],
  ])('%s carries %s and is clean', (sha, possessive) => {
    expect(MESSAGES.get(sha)?.message).toContain(possessive);
    expect(rulesFor(sha)).toEqual([]);
  });

  test('a possessive of an identifier the tree DOES hold is clean', () => {
    expect(inspect("fix(core): charge the pruner once\n\nOrchestratorAgent's step budget was "
      + 'charged for blocks the weave adds back.', isCode)).toEqual([]);
  });

  test('an all-caps acronym possessive is not an actor', () => {
    // GEPA, LATS, MCTS and ToT are papers and modules, and every one of them is
    // written possessively in this history. A pattern that reached them would
    // have produced findings on 4 more names, all real.
    for (const acronym of ['GEPA', 'LATS', 'MCTS', 'ToT', 'MoA', 'OpenAI']) {
      expect(inspect(`docs(exploration): restore the hedge\n\n${acronym}'s own bound is stated.`,
        isCode)).toEqual([]);
    }
  });

  test('a declared external name is clean, and the list is the measured five plus the owner', () => {
    expect([...NAMES_WITHOUT_CODE].sort())
      .toEqual(['AlphaEvolve', 'AshishKumar4', 'FunSearch', 'GitHub', 'JavaScript', 'TypeScript']);
    expect(inspect("chore(deps): move to TypeScript 7\n\nTypeScript's project references now "
      + 'resolve the scripts project.', isCode)).toEqual([]);
  });
});

describe('a message that narrates the session or argues in the first person is refused', () => {
  test('a first-person retraction, and no prefix — one real commit carrying both', () => {
    expect(rulesFor('19acaed594')).toEqual(['narration', 'subject-prefix']);
    const quotes = inspect(MESSAGES.get('19acaed594')?.message ?? '', isCode)
      .map((violation) => violation.quote);
    expect(quotes.some((quote) => quote.includes('My earlier claim'))).toBe(true);
  });

  test('"this session", beside a prefix outside the vocabulary and an 81-character subject', () => {
    expect(rulesFor('3c50995cb6')).toEqual(['narration', 'subject-length', 'subject-prefix']);
  });

  test('an ACT credited to the owner is refused, in all four of its real spellings', () => {
    expect(rulesFor('85c1fb6509')).toEqual(['narration']);
    for (const body of [
      'Three things the owner asked for, now stated.',
      'The owner was right, and the cause was two bugs stacked.',
      "Done per the owner's explicit instruction.",
      "The fourth is the owner's floor-continuation question answered.",
    ]) {
      expect(inspect(`docs(exploration): close the gap\n\n${body}`, isCode)
        .map((violation) => violation.rule)).toEqual(['narration']);
    }
  });

  test('the owner as a MODELLED ENTITY passes — the domain-noun control', () => {
    // `the owner` is a first-class entity in this product: a UserDO, credentials,
    // a peer roster, an outbox, an approval queue. It occurs that way in 119
    // tracked source files, and a bare `\bthe owner\b` over a body would have
    // gone red on 27 of the 844 messages in the first rewritten history — every
    // one of them technically correct. So the rule follows the act, not the word.
    for (const body of [
      "The owner's UserDO minted the capability token for this actor.",
      'A settled background job emails the owner on failure.',
      'Only interactive session tokens (the owner) can reach it.',
      'The owner-facing board can bind, open and approve but not patch.',
      "The daemon runs as the owner on the owner's machine.",
      "Both proxies spend the owner's inference credentials.",
      // Present tense, and this one is the discriminator: a product sentence
      // about a user's question, verbatim from actor-agent.ts:1208.
      'The owner asks what the WORKSPACE cost, and a recursive total answers it.',
    ]) {
      expect(inspect(`feat(cf): pair the token\n\n${body}`, isCode)).toEqual([]);
    }
  });

  test('a session used as WORK is refused; the session OBJECT passes', () => {
    for (const body of [
      'An e2e test that catches both hang bugs this session shipped.',
      'A citation with no checker is the defect class this session has been about.',
      'Which is where it stood before this session.',
    ]) {
      expect(inspect(`test(core): lock the fixes\n\n${body}`, isCode)
        .map((violation) => violation.rule)).toEqual(['narration']);
    }
    for (const body of [
      'Core owns the gates; this session owns the local clock and the ingress.',
      "This session's delegation deps are absent by design.",
      "The ONE wall-clock budget this session spends waiting on work.",
    ]) {
      expect(inspect(`refactor(cli): split the clock\n\n${body}`, isCode)).toEqual([]);
    }
  });

  test('instruction narration', () => {
    for (const phrase of ['as requested', 'as instructed', 'as asked', 'as discussed']) {
      expect(inspect(`fix(core): widen the bound\n\nThe bound is now 80, ${phrase}.`, isCode)
        .map((violation) => violation.rule)).toEqual(['narration']);
    }
  });

  test('`I/O` is not first person, and `proteus label mine` is not a comparison', () => {
    // Both are real corpus spellings and both would be false positives under the
    // obvious pattern. `I/O` occurs in technical prose; `mine` is a subcommand.
    expect(inspect('fix(core): bound the I/O on the init gate\n\nThe I/O moved off onStart.',
      isCode)).toEqual([]);
    expect(inspect('feat(cli): add proteus label mine\n\n`mine` walks the transcripts.', isCode))
      .toEqual([]);
  });

  test('a quoted product label is not the author speaking', () => {
    // 5 of the 84 lone `I`s in history sit inside a quoted UI label, docstring or
    // model reply. Stripping quotations for the prose rules is what keeps those
    // from being findings.
    expect(proseOnly('the "what I changed about myself" digest').includes('I')).toBe(false);
    expect(inspect('feat(core): add the self-changelog\n\nIt assembles the '
      + '"what I changed about myself" digest as a pure read model.', isCode)).toEqual([]);
    // And the attribution rules are NOT stripped, because a backticked agent name
    // is this history's commonest spelling of one.
    expect(inspect('docs(exploration): note the axis finding\n\nFound by `SpecAudit` while '
      + 'reading the pin.', isCode).map((violation) => violation.rule)).toEqual(['named-actor']);
    expect(inspect("docs(exploration): note the axis finding\n\n`SpecAudit`'s reading of the pin.",
      isCode).map((violation) => violation.rule)).toEqual(['named-actor']);
  });

  test('an apostrophe pair does not blank the prose between it', () => {
    // The naive single-quote pattern paired the apostrophes in ordinary English
    // and silently hid the `my` between them. A rule that fails to fire is worse
    // than one that fires wrongly, because nobody sees it.
    const sentence = "It's not clear that my earlier claim held; don't rely on it.";
    expect(proseOnly(sentence)).toBe(sentence);
    expect(inspect(`fix(core): tighten the digest\n\n${sentence}`, isCode)
      .map((violation) => violation.rule)).toEqual(['narration']);
    // A backtick span stays on its line, so an odd count cannot blank the rest.
    expect(proseOnly('`code` and my note\nmy second note')).toContain('and my note');
    expect(proseOnly('`unclosed and my note\nmy second note')).toContain('my second note');
    // And a line OPENING with a code span is still prose: classifying indentation
    // after blanking would have made it read as an indented code line.
    expect(inspect('fix(core): rename the reader\n\n`readNodeTranscript` and my earlier claim '
      + 'both changed.', isCode).map((violation) => violation.rule)).toEqual(['narration']);
  });

  test('a commit that QUOTES a shipped product string is not held to its content', () => {
    // `packages/core/src/evolution/engine.ts:678` emits a user-facing digest whose
    // text contains the words `this session`. A body quoting it accurately was a
    // finding while misquoting it would have passed, which is backwards. Measured
    // before carving this out: of 172 narration hits across the 1,898-commit
    // history, ZERO sit inside a fenced block and ZERO on an indented line, so the
    // carve-out costs no coverage.
    const indented = 'evolution: add changelog digest with revert dispatch across surfaces\n\n'
      + 'The digest is emitted as a background event so every entry is revertable.\n\n'
      + "    event: 'Self-change digest: N entries this session (…) — every line is revertable'\n\n"
      + 'The revert dispatch covers all three surfaces.';
    expect(inspect(indented, isCode)).toEqual([]);
    const fenced = 'docs(core): quote the shipped digest\n\nThe string is:\n\n```ts\n'
      + 'message: `Self-change digest: N entries this session`\n```\n\nUnchanged.';
    expect(inspect(fenced, isCode)).toEqual([]);
    expect(inspect('docs(core): quote the shipped digest\n\nIt emits `N entries this session` '
      + 'verbatim.', isCode)).toEqual([]);
    // And the same words as the author's own prose are still a finding.
    expect(inspect('docs(core): quote the shipped digest\n\nThe digest shipped this session.',
      isCode).map((violation) => violation.rule)).toEqual(['narration']);
  });

  test('NodeTranscript and ForkTree are identifiers, so their possessives are clean', () => {
    // Raised against the live tree: readNodeTranscript / getNodeTranscript /
    // useNodeTranscript all exist, so the AST derivation spares the name.
    const live = codeIdentifierTest(readMatching(isParseable));
    for (const name of ['NodeTranscript', 'ForkTree']) expect(live(name)).toBe(true);
  });
});

describe('the subject convention', () => {
  test('the vocabulary is the sixteen tokens used 13 or more times', () => {
    expect(ALLOWED_PREFIXES).toEqual([
      'fix', 'feat', 'docs', 'bench', 'test', 'refactor', 'chore', 'cli', 'core', 'mcts', 'cf',
      'gate', 'heads', 'eval', 'evolution', 'prompt',
    ]);
    // Stated in the failure message, because an author who cannot see the options
    // guesses again.
    const rejected = inspect('layergate(lock): re-lock the digest', isCode);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.invariant).toContain('fix feat docs');
  });

  test('a prefix outside the set, a capitalised prefix, and no prefix are three findings', () => {
    expect(inspect('spec(axis): declare the preset points', isCode)[0]?.rule)
      .toBe('subject-prefix');
    const capitalised = inspect('Docs(exploration): restore the hedge', isCode);
    expect(capitalised[0]?.fix).toBe('write `docs`');
    expect(inspect('a tracked file is in every gate\u2019s corpus', isCode)[0]?.invariant)
      .toContain('a subject begins');
  });

  test('a colon-reveal subject is rejected for having no prefix, not for its rhetoric', () => {
    // The honest half of the colon-reveal blind spot: 298 of the 302 in history
    // fail here, because a phrase before a colon is not a one-token prefix.
    const reveal = inspect('SqliteFS is gone: the durable files ARE the workspace filesystem',
      isCode);
    expect(reveal.map((violation) => violation.rule)).toEqual(['subject-prefix']);
    // And the residue this gate cannot see: a colon reveal BEHIND a legal prefix.
    expect(inspect('docs(bench): the detail that makes it work: a separate agent grades it',
      isCode)).toEqual([]);
  });

  test('the ceiling is 80, from the measured p90 of 82', () => {
    expect(SUBJECT_CEILING).toBe(80);
    // The exemplar the convention was declared with is exactly at the ceiling.
    const exemplar = 'docs(exploration-spec): specify agent nodes, report-tool grading, and merge-back';
    expect(exemplar.length).toBe(80);
    expect(inspect(exemplar, isCode)).toEqual([]);
    expect(inspect(`${exemplar}s`, isCode)[0]?.rule).toBe('subject-length');
  });

  test('a subject wrapped across two lines is still one subject', () => {
    // Measured evasion: 034e8bf891's subject is 135 characters and its first
    // physical line is 81. `git log --oneline` shows the joined form.
    const wrapped = MESSAGES.get('034e8bf891')?.message ?? '';
    expect(subjectOf(wrapped).length).toBe(135);
    expect(wrapped.split('\n')[0]?.length).toBe(80);
    expect(rulesFor('034e8bf891')).toEqual(['named-actor', 'narration', 'subject-length']);
  });

  test('git writes its own subjects and they are exempt from prefix and length', () => {
    for (const subject of [
      "Merge branch 'docs/spec-freeze'",
      'Revert "docs(exploration): withdraw a matched-compute claim assembled from two unmatched '
      + 'comparisons that never shared a compute condition"',
      'fixup! fix(core): charge the pruner once',
    ]) {
      expect(GENERATED_SUBJECT.test(subject)).toBe(true);
      expect(inspect(subject, isCode)).toEqual([]);
    }
    // A merge BODY is governed like any other body — the subject is git's, the
    // prose is not.
    expect(inspect("Merge branch 'fix/seal'\n\nSealSideDoor's seal work landed four exports.",
      isCode).map((violation) => violation.rule)).toEqual(['named-actor']);
  });
});

describe('the message git hands the hook is cleaned the way git cleans it', () => {
  test('comments and the --verbose scissors diff are cut', () => {
    const raw = [
      'fix(core): charge the pruner once',
      '',
      '# Please enter the commit message for your changes.',
      '# On branch fix/pruner',
      'The weave adds blocks back after the budget is taken.',
      '# ------------------------ >8 ------------------------',
      '# Do not modify or remove the line above.',
      'diff --git a/x.ts b/x.ts',
      '+// Found by SpecAudit: the owner asked for this',
    ].join('\n');
    const cleaned = cleanMessage(raw);
    expect(cleaned).toBe('fix(core): charge the pruner once\n\nThe weave adds blocks back after '
      + 'the budget is taken.');
    // Without the cut, somebody else's docstring inside the staged diff is a
    // finding against this commit.
    expect(inspect(cleaned, isCode)).toEqual([]);
    expect(inspect(raw, isCode).length).toBeGreaterThan(0);
  });

  test('an empty message is not a finding — git aborts the commit itself', () => {
    expect(inspect(cleanMessage('# nothing but comments\n'), isCode)).toEqual([]);
  });
});

describe('the identifier allowlist is derived from code, not from prose', () => {
  test('a name that appears only in a comment does not count as code', () => {
    // This is the whole discrimination, and it is why a repository-text grep
    // cannot serve: `git grep` finds every one of these nine subagent names in
    // tracked files, all of them inside comments, because the same habit writes
    // agent names into docstrings.
    const live = codeIdentifierTest(new Map([
      ['scripts/probe.ts', '/** Found by `SpecAudit` while reading. */\nexport const digest = 1;'],
      ['scripts/other.ts', "const label = 'FixtureZero';\nexport class OrchestratorAgent {}"],
    ]));
    expect(live('SpecAudit')).toBe(false);
    expect(live('FixtureZero')).toBe(false);
    expect(live('OrchestratorAgent')).toBe(true);
  });

  test('against the live tree: real classes are code, real subagent names are not', () => {
    const corpus = readMatching(isParseable);
    expect(corpus.size).toBeGreaterThan(500);
    const live = codeIdentifierTest(corpus);
    for (const name of ['OrchestratorAgent', 'EvolutionEngine', 'TurnAccumulator', 'TextDecoder']) {
      expect(live(name)).toBe(true);
    }
    for (const name of ['SealSideDoor', 'FixtureZero', 'AxisErgonomics', 'LiteratureGate']) {
      expect(live(name)).toBe(false);
    }
  });
});

describe('the gate states what it does not catch', () => {
  test('every blind spot names its measured size', () => {
    expect(BLIND_SPOTS.length).toBeGreaterThan(5);
    for (const spot of BLIND_SPOTS) expect(spot.length).toBeGreaterThan(80);
    const text = BLIND_SPOTS.join(' ');
    for (const named of ['COLON REVEALS', 'BINARY CONTRASTS', 'EM DASHES', 'SENTENCE LENGTH']) {
      expect(text).toContain(named);
    }
    // Each of the four carries a number, because "this gate does not check
    // style" is not a blind spot, it is a shrug.
    expect(text).toContain('302 of 1,898');
    expect(text).toContain('180 measured');
    expect(text).toContain('3,234');
    expect(text).toContain('26.6 words');
  });

  test('every narration pattern says what to write instead', () => {
    for (const rule of NARRATION) {
      expect(rule.instead.length).toBeGreaterThan(30);
      expect(rule.names.length).toBeGreaterThan(5);
    }
  });

  test('AGENTS.md states the same convention the gate enforces', () => {
    // AGENTS.md is loaded into every agent session, so it is where an author
    // learns the vocabulary instead of discovering it from a red gate. Two
    // statements of one set is drift by construction unless the equality is
    // asserted, which is what this is.
    const guidance = readFileSync(resolve(root, 'AGENTS.md'), 'utf8');
    const section = guidance.slice(guidance.indexOf('## Commit Messages'));
    expect(section.startsWith('## Commit Messages')).toBe(true);
    const stated = [...section.slice(0, section.indexOf('\n## ', 1)).matchAll(/`([a-z]+)`/g)]
      .map((match) => match[1]);
    for (const prefix of ALLOWED_PREFIXES) expect(stated).toContain(prefix);
    expect(section).toContain(`at most ${String(SUBJECT_CEILING)} characters`);
    for (const name of ROSTER) expect(section).toContain(name);
  });
});
