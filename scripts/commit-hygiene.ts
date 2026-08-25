/**
 * Commit-message hygiene — the convention, and the three defect classes that
 * cannot reach the permanent record again.
 *
 * WHY THIS EXISTS. A read of all 1,898 commits on `main` (2026-04-16 .. 2026-08-18)
 * found the classic AI-slop word tells mechanically EMPTY: zero hits for the
 * banned-word list, zero for importance puffery, zero for weasel attribution,
 * zero for throat-clearing openers, zero for faux-insight setups. What it found
 * instead was three shapes no keyword list would catch, and one absent
 * convention:
 *
 *   1. NAMED ACTORS. Commit bodies credit orchestration subagents the way a
 *      commit would credit a human reviewer — `Main's ruling`, `FixtureZero's
 *      findings`, `SealSideDoor's publication-seal work`, `LiteratureGate's
 *      patch G`. Every commit in this repository is authored under one person's
 *      name, so those lines read as him crediting colleagues who do not exist.
 *   2. FIRST PERSON. 84 lone `I`s across 49 commits and 58 `my`s across 42,
 *      most of them arguing with a position a previous commit took: *"My
 *      earlier claim that runChat had no direct tests was wrong."* A commit
 *      message has no first person; the Author field records who wrote it.
 *   3. SESSION NARRATION. `this session` (5 commits) and `the owner` (118) —
 *      facts about the work process rather than about the change, including one
 *      body that pastes the user's own chat message in as source material.
 *   4. NO PREFIX CONVENTION. 187 distinct case-folded type-prefix tokens over
 *      1,604 non-generated subjects, with the same concept spelled two ways
 *      (`MCTS`/`mcts`, `CLI`/`cli`, `Docs`/`docs`, `test`/`tests`), and 627
 *      subjects carrying no prefix at all. A vocabulary that grows by whatever
 *      word fit the moment is not a convention.
 *
 * GOING FORWARD ONLY. History is not rewritten by this gate and not read as a
 * standard. The governed set is `<boundary>..HEAD`, where the boundary is the
 * commit that ADDED this file — derived from the repository, so "the convention
 * applies from where it landed" needs no recorded number and cannot go stale.
 * Before that commit exists the governed set is empty and the gate says so.
 *
 * WHERE IT RUNS, AND WHY BOTH. `.githooks/commit-msg` hands it the message git
 * is about to write, which is the one place the defect is stopped rather than
 * reported. The ladder's commit tier runs the same program over the governed
 * range, which is what makes it hold in CI and at deploy after a `--no-verify`
 * or a rebase (git runs no `commit-msg` during either). One program, two entry
 * points, one list — a second list is the defect this repository's gate ladder
 * exists to prevent.
 *
 * THE ROSTER PROBLEM, AND WHAT IS DERIVED INSTEAD. A list of subagent names
 * rots within a day: this session's roster alone is over two hundred names. Two
 * candidate sources were tested and both were rejected on evidence.
 * `~/.omp/agent/sessions/` holds four project directory names and no roster, is
 * machine-local, and is absent in CI — depending on it would narrow the corpus
 * silently, which is the one thing `gate:set-equality` exists to forbid. The
 * repository's own text does not discriminate either: `git grep` finds
 * `SealSideDoor`, `SpecAudit`, `FixtureZero`, `ObjectiveSpec`, `LiteratureGate`,
 * `AxisErgonomics`, `EvalsInfra`, `LeanModel` and `JudgeCeiling` in tracked
 * files already — every one of them in a COMMENT, because the same habit writes
 * agent names into docstrings.
 *
 * That last fact is the derivation. A name is allowed when some tracked source
 * file declares or uses it as an IDENTIFIER, read from the AST so a mention in
 * a comment or a string cannot produce one. Measured over all 1,898 commits,
 * that single test separates the two populations cleanly: 22 CamelCase
 * possessives survive it, 14 are subagent names, 5 are external proper nouns
 * (`NAMES_WITHOUT_CODE` below), and 3 are identifiers the tree no longer holds.
 * Nothing about the derivation is a list of agents, so it does not rot.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { assertMeasured, finding } from './gate-ratchet';
import { isParseable, readMatching } from './sources';
import { identifierText, parse, walk } from './syntax';

const root = new URL('..', import.meta.url).pathname;

/** This file, so the convention's start point is derived from the commit that
 *  added it rather than recorded as a SHA nobody can verify later. */
const GATE_PROGRAM = 'scripts/commit-hygiene.ts';

/**
 * The allowed subject prefixes: every token used 13 or more times across the
 * 1,610 non-merge subjects of the pre-convention history. Thirteen is where the
 * frequency ranking has no tie to break — `eval`, `evolution` and `prompt` all
 * sit at 13 and `tests` (a misspelling of `test`) at 10 — so the cut is a
 * property of the measured distribution rather than a round number someone
 * liked. The 16 tokens cover 63.8% of the prefixes history actually used; the
 * 171 excluded tokens are component names (`layergate` 10, `spec` 9,
 * `compaction` 8, `jobs` 7, `events` 7, `swarm` 5), capitalisation variants of
 * tokens already here, and one-off ticket labels used exactly once (`A1`, `F3`,
 * `FIX-INTRATURN`).
 *
 * A component name is not excluded from a subject — it goes in the parens, as
 * `fix(layergate):`. The parenthesised scope vocabulary is deliberately NOT
 * governed: 162 distinct scopes are in use and a bounded scope list would be a
 * second rotting roster.
 */
export const ALLOWED_PREFIXES: readonly string[] = [
  'fix', 'feat', 'docs', 'bench', 'test', 'refactor', 'chore', 'cli', 'core', 'mcts', 'cf', 'gate',
  'heads', 'eval', 'evolution', 'prompt',
];

/**
 * The subject-length ceiling, from the measured distribution rather than picked.
 * Over 1,898 subjects: median 67, p75 75, **p90 82**, p95 89, p99 104, max 135.
 * 80 is the largest round ceiling at or below that p90, so it governs the top
 * decile of the tail and nothing else — 250 subjects (13.2%) exceed it.
 *
 * Git's own 72 was measured and rejected: it rejects 606 subjects (31.9%),
 * including the exemplar the convention was declared with —
 * `docs(exploration-spec): specify agent nodes, report-tool grading, and merge-back`,
 * exactly 80 characters. A ceiling that rejects its own reference subject is
 * below the register a mandatory scope prefix costs, and it would be the first
 * rule anyone disabled.
 */
export const SUBJECT_CEILING = 80;

/** Subjects git writes, not a person: a merge, a revert, and the three autosquash
 *  forms. Exempt from the prefix and length rules ONLY — a hand-written merge
 *  body is governed like any other body. Rewording git's own subject would put a
 *  gate in the way of `git revert` for no defect. */
export const GENERATED_SUBJECT = /^(?:Merge |Revert "|fixup! |squash! |amend! )/;

/** `type:` or `type(scope):` followed by text. One token before the colon, on
 *  purpose: a colon-reveal subject's left side is a PHRASE, so it reads as
 *  having no prefix and fails for that rather than being mistaken for one. */
const SUBJECT_PREFIX = /^([A-Za-z][\w.@/-]*)(\([^)]*\))?: *(\S?)/;

/**
 * A CamelCase name — two or more humps, each inner hump carrying lowercase.
 * This shape, and not a list, is what makes the attribution rule durable.
 *
 * The narrower form is deliberate and measured. It excludes all-caps acronyms
 * (`GEPA`, `LATS`, `MCTS`, `ToT`, `MoA`, `OpenAI`) which a broader pattern
 * admitted and which produced 6 additional findings, 4 of them real product
 * names. It also means a hypothetical `FooBAR` agent name is not reached — the
 * blind spot is stated below rather than paid for in false positives.
 */
const CAMEL = String.raw`[A-Z][a-z0-9]*(?:[A-Z][a-z0-9]+)+`;

/**
 * The three ways a message hands an act to a named actor, each measured against
 * the full history for precision. Possessive: 22 surviving tokens, 14 of them
 * subagents. `by`/`per`/`from`: 9 surviving, 7 subagents. Verb: 7 surviving, 6
 * subagents. Every non-subagent survivor in all three shapes is a real product
 * or person name, and all of them are in `NAMES_WITHOUT_CODE`.
 */
const ATTRIBUTIONS: readonly RegExp[] = [
  new RegExp(String.raw`\x60?\b(${CAMEL})\b\x60?['\u2019]`, 'g'),
  new RegExp(String.raw`\b(?:by|per|from)\s+\x60?(${CAMEL})\x60?\b`, 'g'),
  new RegExp(
    String.raw`\b\x60?(${CAMEL})\x60?\s+(?:ruled|asked|instructed|requested|found|reported|landed`
    + String.raw`|recommended|corrected|withdrew|confirmed|verified|flagged|proved|agreed|disagreed`
    + String.raw`|noted|observed|established|raised|took|hit|removed|wanted)\b`,
    'g',
  ),
];

/**
 * Subagent names the shape rule cannot reach, and why the list is hand-kept.
 *
 * `Main` is the orchestrating agent's name and also an ordinary English word
 * with one hump. Any shape rule wide enough to reach `Main's ruling` also
 * reaches `Core's`, `Session's`, `Worker's` and `Bench's`, all of which occur
 * legitimately in this corpus — so this one is declared instead. It appears in
 * 10 commits, all crediting a decision.
 *
 * One entry. A second single-word agent name would go here with its own reason;
 * a CamelCase one must not, because the shape rule already has it.
 */
export const ROSTER: readonly string[] = ['Main'];

/**
 * Names that are legitimate in a commit message and that no tracked source file
 * holds an identifier for. Hand-maintained BECAUSE it has no derivable source:
 * these are external proper nouns, and the repository has no register of the
 * languages, platforms and papers it is allowed to name. Every entry is a
 * checkable fact rather than a session artefact, which is what keeps the list
 * short — it grew five entries over four months of history.
 *
 * The five are exactly the non-subagent survivors measured across 1,898
 * commits. `AshishKumar4` is the repository owner's GitHub handle, which appears
 * in `by AshishKumar4` clone URLs.
 *
 * This is also where an identifier the tree no longer holds belongs, if one ever
 * bites: 3 of 1,898 historical commits used the possessive of a class that has
 * since been deleted (`SqliteFS`, `HeadAgent`, `TriggersTab`). Each was correct
 * when written and each is invisible at `commit-msg` time, where the class is
 * still in the tree being committed. None is seeded here, because none is
 * inside the governed range.
 */
export const NAMES_WITHOUT_CODE: readonly string[] = [
  'TypeScript', 'JavaScript', 'GitHub', 'AlphaEvolve', 'FunSearch', 'AshishKumar4',
];

export interface Narration {
  readonly pattern: RegExp;
  /** What the pattern is, in the failure message. */
  readonly names: string;
  /** The rewrite, not a scolding. */
  readonly instead: string;
  /** Whether quotations are stripped before this pattern runs. A product label
   *  or a quoted docstring is not the author speaking, and 5 of the 84 lone `I`s
   *  in history sit inside one. */
  readonly prose: boolean;
}

/**
 * `the owner` and `this session` are both DOMAIN NOUNS in this product, so
 * neither can be gated as a bare phrase.
 *
 * Measured before narrowing: `the owner` appears in 119 tracked source files as
 * a first-class modelled entity — `the owner's UserDO`, `spend the owner's
 * inference credentials`, `notifies the owner`, `the owner's backup of their own
 * workspace`. `this session` is the cli-backend's own referent for a live session
 * object — `this session owns the local clock`, `this session's delegation deps`,
 * `this session's whole tool surface`. A bare `\bthe owner\b` over a body would
 * have gone red on 27 of the 844 messages in the first rewritten history, every
 * one of them technically correct, and a gate with a 3% false-positive rate on
 * day one is a gate somebody disables.
 *
 * So the rule follows the DEFECT rather than the word. The defect is crediting a
 * requester or narrating a work session, and both have a shape:
 *
 *   - an act of instruction or judgement attributed to the owner, in the PAST —
 *     `the owner asked`, `the owner was right`, `which the owner caught`, `per
 *     the owner's explicit instruction`, `the owner's floor-continuation
 *     question`. Past tense is doing real work here: `the owner asks what the
 *     WORKSPACE cost` (actor-agent.ts:1208) is a product sentence about a user's
 *     question, and the present tense is what tells the two apart.
 *   - a session used as a unit of work or time — `shipped this session`, `this
 *     session has been about`, `before this session` — as against a session used
 *     as an object, which is the domain sense.
 */
const REQUESTER_ACT = 'asked|requested|instructed|ruled|decided|said|wanted|caught|confirmed'
  + '|corrected|flagged|escalated|complained|objected|directed|was right|was wrong|pointed out';

/** Nominalised instruction. Deliberately excludes `call`, `requirement` and
 *  `approval`, each of which reads both ways in this product's own prose. */
const REQUESTER_ARTEFACT = 'question|questions|instruction|instructions|ask|asks|request|requests'
  + '|ruling|rulings|decision|decisions|correction|corrections|direction|directions|words|message'
  + '|messages|feedback|complaint|complaints|priority|priorities|framing|wording|escalation'
  + '|verdict|brief|intent|preference|preferences|judgement|judgment|steer|steering';

/** Work done, or time spent, rather than a session object. */
const SESSION_AS_WORK = 'shipped|landed|fixed|built|introduced|produced|found|covered|wrote|made'
  + '|delivered|has been|was about';

/** The literal shapes with no legitimate use in a message that describes a
 *  change. Each count is over the 1,898-commit pre-convention history. */
export const NARRATION: readonly Narration[] = [
  {
    pattern: new RegExp(
      String.raw`\b(?:(?:by|per|from|according to)\s+the owner\b`
      + String.raw`|the owner\s+(?:[\w-]+\s+)?(?:${REQUESTER_ACT})\b`
      + String.raw`|the owner['\u2019]s\s+(?:[\w-]+\s+){0,2}?(?:${REQUESTER_ARTEFACT})\b)`,
      'gi',
    ),
    names: 'an act credited to "the owner" (the requester sense, 118 commits)',
    instead: 'state the requirement or the defect. Who asked for it is not part of the change. '
      + 'The owner as a modelled ENTITY is fine and is not matched: `the owner\'s UserDO`, '
      + '`emails the owner on failure`, `runs as the owner on the owner\'s machine`.',
    prose: true,
  },
  {
    pattern: new RegExp(
      String.raw`\b(?:(?:in|during|before|after|since|throughout)\s+this session\b`
      + String.raw`|this session\s+(?:[\w-]+\s+){0,2}?(?:${SESSION_AS_WORK})\b`
      + String.raw`|(?:${SESSION_AS_WORK}|written)\s+(?:[\w-]+\s+){0,3}?this session\b)`,
      'gi',
    ),
    names: '"this session" as a unit of work or time (5 commits)',
    instead: 'name the change or the defect class. A session is not a unit of history. The live '
      + 'session OBJECT is fine and is not matched: `this session owns the local clock`, '
      + '`this session\'s delegation deps`.',
    prose: true,
  },
  {
    pattern: /\bas (?:requested|instructed|asked|discussed)\b/gi,
    names: 'instruction narration',
    instead: 'state the requirement itself, so the reason survives without the conversation.',
    prose: true,
  },
  {
    pattern: /\bmy\b/gi,
    names: 'the author\'s own possessive (58 occurrences, 42 commits)',
    instead: 'describe the code, not its author: "the earlier claim was wrong" — or amend the '
      + 'commit that made it, if it has not shipped.',
    prose: true,
  },
  {
    pattern: /\b(?:of|than|is|was) mine\b/gi,
    names: 'a comparison against the author\'s own prior work',
    instead: 'compare the two designs by what they do. `kinu label mine` is a subcommand and '
      + 'is not matched.',
    prose: true,
  },
  {
    pattern: /(?<![\w/])I(?![\w/])/g,
    names: 'first-person singular (84 occurrences, 49 commits)',
    instead: 'a commit message has no first person; the Author field records who wrote it. `I/O` '
      + 'is not matched.',
    prose: true,
  },
];

export type Rule = 'subject-prefix' | 'subject-length' | 'named-actor' | 'narration';

export interface Violation {
  readonly rule: Rule;
  /** 1-based line within the message. */
  readonly line: number;
  readonly quote: string;
  readonly invariant: string;
  readonly silently: string;
  readonly fix: string;
}

/**
 * The part of a message the AUTHOR is saying, with everything quoted or shown as
 * code blanked to spaces so offsets and line numbers survive.
 *
 * QUOTED SPANS. A UI label, a docstring and a model's own reply all reached
 * commit bodies inside one, and none of the three is the author speaking. A
 * single quote counts only when it is FLANKED by non-word characters, and that is
 * not a nicety: the naive `'[^'\n]*'` pairs the apostrophes in ordinary English,
 * so a sentence with two contractions had everything between them blanked and a
 * first-person possessive in the middle went silently unreported. Backticks are
 * held to one line for the same reason — an odd count would blank the rest of the
 * message. A rule that fails to fire is worse than one that fires wrongly,
 * because nobody ever sees it.
 *
 * CODE BLOCKS. A fenced block, and any line indented four spaces or a tab. A
 * commit that quotes a shipped product string cannot be held to a prose rule
 * about that string's content: `evolution/engine.ts:678` emits a user-facing
 * digest containing the words `this session`, and a body quoting it accurately
 * was a finding while misquoting it would have passed. Measured before adding
 * this: of 172 narration hits across the 1,898-commit history, ZERO sit inside a
 * fenced block and ZERO on an indented line, so the carve-out costs no coverage
 * at all.
 *
 * Deliberately NOT applied to the attribution rules — agent names are routinely
 * written in backticks (`` `AxisErgonomics`, 245 answered calls ``), and
 * stripping there would blind the rule to its commonest spelling.
 */
const QUOTATION = /`[^`\n]*`|"[^"\n]*"|(?<![\w'])'[^'\n]{0,300}'(?![\w'])/g;
const FENCE = /^[ \t]*```/;
const SHOWN_AS_CODE = /^(?: {4,}|\t)/;

export function proseOnly(text: string): string {
  let inFence = false;
  // Indentation is decided on the ORIGINAL line, before quotations are blanked.
  // The other order is a silent hole: blanking a leading code span leaves the line
  // starting with spaces, so `` `readNodeTranscript` and my earlier claim `` read
  // as an indented code line and escaped the prose rules entirely.
  return text.split('\n').map((line) => {
    if (FENCE.test(line)) {
      inFence = !inFence;
      return ' '.repeat(line.length);
    }
    if (inFence || SHOWN_AS_CODE.test(line)) return ' '.repeat(line.length);
    return line.replace(QUOTATION, (span) => ' '.repeat(span.length));
  }).join('\n');
}

/**
 * Whether some tracked source file uses `name` as an identifier.
 *
 * Two properties matter. It reads the AST, so the same name in a comment or a
 * string does not count — which is the whole discrimination, since every
 * subagent name already in this tree is in a comment. And it parses only the
 * files whose text contains the name at all, so a clean message costs one
 * enumeration and no parse: the corpus is materialised once through
 * `sources.ts`, and a message naming nothing never opens a file.
 */
export function codeIdentifierTest(corpus: ReadonlyMap<string, string>): (name: string) => boolean {
  const answered = new Map<string, boolean>();
  return (name: string): boolean => {
    const cached = answered.get(name);
    if (cached !== undefined) return cached;
    let found = false;
    for (const [file, text] of corpus) {
      if (!text.includes(name)) continue;
      walk(parse(file, text).root, (node) => {
        if (identifierText(node) === name) found = true;
      });
      if (found) break;
    }
    answered.set(name, found);
    return found;
  };
}

const lineOf = (text: string, offset: number): number =>
  text.slice(0, offset).split('\n').length;

/** Enough of the offending line to recognise it, centred on the match. */
function excerpt(text: string, offset: number, length: number): string {
  const start = text.lastIndexOf('\n', offset) + 1;
  const end = text.indexOf('\n', offset + length);
  const line = text.slice(start, end === -1 ? text.length : end).trim();
  return line.length <= 100 ? line : `${line.slice(0, 99)}…`;
}

function subjectViolations(subject: string): Violation[] {
  if (GENERATED_SUBJECT.test(subject)) return [];
  const found: Violation[] = [];
  const match = SUBJECT_PREFIX.exec(subject);
  const token = match?.[1];
  if (token === undefined || match?.[3] === '') {
    found.push({
      rule: 'subject-prefix',
      line: 1,
      quote: subject,
      invariant: `a subject begins \`type: \` or \`type(scope): \`, with type one of: `
        + ALLOWED_PREFIXES.join(' '),
      silently: 'nothing, which is the problem: 627 of 1,898 subjects carry no prefix, so `git log '
        + '--oneline` cannot be read by area and no two authors agree on what a subject looks like. '
        + 'A colon-reveal subject lands here too, because its left side is a phrase rather than a '
        + 'prefix.',
      fix: 'add the prefix. A component name goes in the parens: `fix(layergate): …`.',
    });
  } else if (token !== token.toLowerCase()) {
    found.push({
      rule: 'subject-prefix',
      line: 1,
      quote: subject,
      invariant: 'a subject prefix is lowercase',
      silently: `\`${token}\` and \`${token.toLowerCase()}\` are two spellings of one area, and the `
        + 'history carries both for four concepts (MCTS/mcts, CLI/cli, Docs/docs, Heads/heads). '
        + 'Nothing downstream can group them.',
      fix: `write \`${token.toLowerCase()}\``,
    });
  } else if (!ALLOWED_PREFIXES.includes(token)) {
    found.push({
      rule: 'subject-prefix',
      line: 1,
      quote: subject,
      invariant: `the subject prefix is one of: ${ALLOWED_PREFIXES.join(' ')}`,
      silently: `\`${token}\` becomes the 197th prefix token in a 1,898-commit history. A `
        + 'vocabulary that admits every new word is not a convention, and 171 of the tokens '
        + 'already there were used fewer than 13 times each.',
      fix: `pick the type from the set and put \`${token}\` in the parens: `
        + `\`fix(${token}): …\` — or one of ${ALLOWED_PREFIXES.slice(0, 7).join(', ')}`,
    });
  }
  if (subject.length > SUBJECT_CEILING) {
    found.push({
      rule: 'subject-length',
      line: 1,
      quote: subject,
      invariant: `a subject is at most ${String(SUBJECT_CEILING)} characters`,
      silently: `${String(subject.length)} characters. Every tool that shows a subject truncates `
        + 'it, so the part past the ceiling is written and never read — 250 of 1,898 subjects, up '
        + 'to 135 characters.',
      fix: 'the rest belongs in the body, which is read in full.',
    });
  }
  return found;
}

function actorViolations(message: string, isCode: (name: string) => boolean): Violation[] {
  const found: Violation[] = [];
  const seen = new Set<string>();
  const flag = (name: string, offset: number, why: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    found.push({
      rule: 'named-actor',
      line: lineOf(message, offset),
      quote: excerpt(message, offset, name.length),
      invariant: 'a commit message credits no actor by name',
      silently: `${why} Every commit here is authored under one person's name, so a reader sees `
        + `him crediting a colleague called ${name}. Nine such names reached the permanent record `
        + 'before this gate existed: Main, SealSideDoor, FixtureZero, ObjectiveSpec, LeanModel, '
        + 'LiteratureGate, AxisErgonomics, JudgeCeiling, SpecAudit.',
      fix: `state what changed and what proves it. If ${name} is a real product or paper, add it `
        + `to NAMES_WITHOUT_CODE in ${GATE_PROGRAM} with the fact that makes it one.`,
    });
  };
  for (const name of ROSTER) {
    for (const pattern of ATTRIBUTIONS) {
      const scoped = new RegExp(pattern.source.replace(`(${CAMEL})`, `(${name})`), 'g');
      const hit = scoped.exec(message);
      if (hit !== null) flag(name, hit.index, `\`${name}\` is a declared agent name.`);
    }
  }
  for (const pattern of ATTRIBUTIONS) {
    pattern.lastIndex = 0;
    for (const hit of message.matchAll(pattern)) {
      const name = hit[1] ?? '';
      if (NAMES_WITHOUT_CODE.includes(name) || isCode(name)) continue;
      flag(name, hit.index, `No tracked source file uses \`${name}\` as an identifier, so it names `
        + 'no code in this repository.');
    }
  }
  return found;
}

function narrationViolations(message: string): Violation[] {
  const prose = proseOnly(message);
  const found: Violation[] = [];
  for (const rule of NARRATION) {
    const text = rule.prose ? prose : message;
    rule.pattern.lastIndex = 0;
    const hit = rule.pattern.exec(text);
    if (hit === null) continue;
    found.push({
      rule: 'narration',
      line: lineOf(message, hit.index),
      quote: excerpt(message, hit.index, hit[0].length),
      invariant: 'a commit message describes the change, not the session that produced it',
      silently: `${rule.names} reads as a diary entry about a work process. It is permanent, it is `
        + 'pushed, and it tells a reader nothing about the code.',
      fix: rule.instead,
    });
  }
  return found;
}

/**
 * The subject, derived the way git derives `%s`: the first PARAGRAPH, joined
 * with spaces, not the first physical line.
 *
 * That distinction is a real evasion and it was measured. `034e8bf891`'s subject
 * is 136 characters and its first physical line is 81, because the subject was
 * wrapped across two lines with no blank line after it. `git log --oneline` shows
 * the joined 136; a rule reading the first line would have passed it. So the rule
 * reads what every tool displays.
 */
export function subjectOf(message: string): string {
  const lines = message.split('\n');
  const blank = lines.findIndex((line) => line.trim().length === 0);
  return (blank === -1 ? lines : lines.slice(0, blank)).join(' ').trim();
}

/**
 * Every violation in one message. `isCode` is injected so the self-test can hold
 * a fixed identifier set and stay hermetic — a test that derived the allowlist
 * from the live tree would change verdict every time a class was renamed.
 */
export function inspect(message: string, isCode: (name: string) => boolean): Violation[] {
  const text = message.trim();
  if (text.length === 0) return [];
  return [
    ...subjectViolations(subjectOf(text)),
    ...actorViolations(text, isCode),
    ...narrationViolations(text),
  ];
}

/**
 * A `commit-msg` file as git will store it: comment lines dropped, and
 * everything from the `--verbose` scissors line cut. The hook runs BEFORE git's
 * own cleanup, so a message read raw carries the entire commit template and the
 * whole staged diff, and a gate reading that would find `the owner` in somebody
 * else's docstring.
 */
export function cleanMessage(raw: string): string {
  const scissors = raw.indexOf('# ------------------------ >8 ------------------------');
  const kept = scissors === -1 ? raw : raw.slice(0, scissors);
  return kept.split('\n').filter((line) => !line.startsWith('#')).join('\n').trim();
}

/** `git` against THIS checkout with the ambient git environment removed. A
 *  `commit-msg` hook exports `GIT_DIR`, `GIT_INDEX_FILE` and friends, and every
 *  one of them outranks `cwd` — so a gate that trusted `cwd` would answer about
 *  whatever the hook pointed at rather than about the repository it lives in. */
function git(...args: readonly string[]): string {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')),
  );
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8', env, maxBuffer: 1 << 26,
  });
}

/** The commit that added this file, in HEAD's ancestry: the point from which the
 *  convention applies. Undefined until it is committed, and undefined on a
 *  branch that does not contain it — both of which mean "nothing to govern here"
 *  rather than "clean". */
export function conventionBoundary(): string | undefined {
  const log = git('log', 'HEAD', '--diff-filter=A', '--format=%H', '--follow', '--', GATE_PROGRAM);
  return log.trim().split('\n').filter((line) => line.length > 0).at(-1);
}

export interface GovernedCommit {
  readonly sha: string;
  readonly message: string;
}

/** Every commit made after the convention landed. Merges included: their
 *  subjects are exempt by shape, their hand-written bodies are not. */
export function governedCommits(boundary: string): GovernedCommit[] {
  const log = git('log', '--format=%H%x1f%B%x1e', `${boundary}..HEAD`);
  return log.split('\u001e')
    .map((entry) => entry.replace(/^\n+/, ''))
    .filter((entry) => entry.trim().length > 0)
    .map((entry) => {
      const [sha, message] = entry.split('\u001f');
      return { sha: (sha ?? '').slice(0, 10), message: message ?? '' };
    });
}

/**
 * What this gate does NOT catch, printed on the GREEN path. A blind spot visible
 * only in red output is invisible exactly when the tree is clean, and every
 * number below is a real defect that a gate would get wrong often enough to be
 * disabled. They are review criteria, and they are stated here so nobody reads a
 * green line as "the message is well written".
 */
export const BLIND_SPOTS: readonly string[] = [
  'COLON REVEALS. 302 of 1,898 subjects (15.9%) are a phrase, a colon, then a lowercase clause — '
  + 'the dominant subject shape of the recent history. Not gated, because a colon also '
  + 'legitimately introduces a scope prefix. The prefix rule rejects 298 of those 302 for having '
  + 'no prefix at all; the other 4 carried a legal one and are indistinguishable from '
  + '`scope: description`. Those 4 are the residue this gate cannot see.',
  'THE OWNER AS A BARE REFERENT. `the owner` and `this session` are gated only where an ACT is '
  + 'credited or a session is used as work or time, because both are domain nouns here: `the '
  + 'owner` occurs in 119 tracked source files as a modelled entity, and `this session` is the '
  + 'cli-backend\'s own name for a live session object. So a body that pastes the requester\'s '
  + 'words with no attributing verb — `The owner, on the Exploration tab: "…"`, one real commit — '
  + 'passes. Narrowing was measured, not cautious: the bare phrase would have failed 27 of the '
  + '844 messages in the first rewritten history, every one of them technically correct, and a '
  + 'gate that is wrong 3% of the time on day one is a gate somebody switches off.',
  'QUOTED AND CODE-SHOWN TEXT. The four prose rules do not read a quoted span, an inline code '
  + 'span, a fenced block or an indented line, because a commit that QUOTES a shipped product '
  + 'string cannot be held to that string\'s content — `evolution/engine.ts:678` emits a digest '
  + 'whose text contains the words `this session`, and a body quoting it accurately was a finding '
  + 'while misquoting it would have passed. Measured: of 172 narration hits across the history, '
  + 'ZERO were in a code block, so the carve-out cost no coverage. What it does cost: an author '
  + 'can hide a first-person aside inside quotation marks. The attribution rules deliberately do '
  + 'NOT take this exemption, because a backticked name is this history\'s commonest way of '
  + 'spelling an agent.',
  'BINARY CONTRASTS. 180 measured instances of a negative clause followed by the positive it is '
  + 'contrasted against ("a roster is not a KIND of actor, it is every actor with tree left '
  + 'below it"). Not gated: the same shape is how a real distinction gets drawn, and a regex '
  + 'cannot tell the two apart.',
  'EM DASHES. 3,234 across the corpus, in 61.4% of bodies; 227 commits carry five or more. Not '
  + 'gated: this repository\'s bodies use them as parentheses around citations '
  + '(`AGENTS.md:135-137 states plainly…`), which is the legitimate use, and a density threshold '
  + 'would fire on the best-argued bodies in the history.',
  'SENTENCE LENGTH. Mean 26.6 words over 9,258 body sentences, 45.0% past ASD-STE100\'s 25-word '
  + 'descriptive ceiling. Not gated: these bodies are investigation reports, a genre the standard '
  + 'was not written for, and the audit found their length usually earned.',
  'SCOPE VOCABULARY. The token inside the parens is unchecked — 162 distinct scopes are in use. '
  + 'Bounding it would be a second list to keep.',
  'A BARE MENTION. `Found by FixtureZero` in a sentence with none of the three attribution shapes '
  + 'passes, and so does an all-caps agent name (`FOOBAR\'s`), because the CamelCase pattern '
  + 'requires lowercase in each hump so that GEPA, LATS, MCTS and OpenAI are not findings.',
  'THE DIFF. Nothing here reads what the commit changed, so a subject that is well-formed, '
  + 'in-vocabulary, and describes a different commit passes every rule.',
];

if (import.meta.main) {
  const gate = 'commit-hygiene';
  const corpus = readMatching(isParseable);
  const isCode = codeIdentifierTest(corpus);

  // The RULE SETS are what must never silently become zero — a gate whose
  // vocabulary or phrase table emptied would pass every message. The count of
  // governed commits is NOT asserted here: right after this gate lands the range
  // `boundary..HEAD` is legitimately empty, and that is a real state rather than
  // a narrowed corpus. It is reported instead.
  const measured = assertMeasured(gate, [
    ['files enumerated for the identifier allowlist', corpus.size],
    ['allowed prefixes', ALLOWED_PREFIXES.length],
    ['narration patterns', NARRATION.length],
    ['attribution shapes', ATTRIBUTIONS.length],
    ['agent name(s) declared because no shape rule reaches them', ROSTER.length],
    ['blind spots stated', BLIND_SPOTS.length],
  ]);

  // One program, two entry points. A path argument is a `commit-msg` hook
  // handing over the message git is about to write — the only place the defect
  // is stopped rather than reported. No argument is the ladder tier, over every
  // commit made since the convention landed.
  const messageFile = process.argv[2];
  const boundary = messageFile === undefined ? conventionBoundary() : undefined;
  const governed: readonly GovernedCommit[] = messageFile === undefined
    ? (boundary === undefined ? [] : governedCommits(boundary))
    : [{ sha: messageFile, message: cleanMessage(readFileSync(messageFile, 'utf8')) }];

  const violations = governed.flatMap((commit) =>
    inspect(commit.message, isCode).map((violation) => ({ commit, violation })));

  if (violations.length === 0) {
    const scope = messageFile === undefined
      ? (boundary === undefined
        ? 'the convention has not landed on this branch yet, so no commit is governed'
        : `${String(governed.length)} commit(s) since ${boundary.slice(0, 10)}`)
      : messageFile;
    console.log(`${gate}: ok — ${scope}; ${measured}`);
    console.log(`\n${gate}: what this does NOT catch — review criteria, not gate criteria:`);
    for (const spot of BLIND_SPOTS) console.log(`  - ${spot}`);
    process.exit(0);
  }

  console.error(`${gate}: ${String(violations.length)} violation(s)\n`);
  for (const { commit, violation } of violations) {
    console.error(finding({
      at: `${commit.sha} line ${String(violation.line)} [${violation.rule}]`,
      invariant: violation.invariant,
      found: violation.quote,
      silently: violation.silently,
      fix: violation.fix,
    }));
  }
  console.error(
    messageFile === undefined
      ? '\nThese commits are not pushed history yet. Fold the branch and rewrite the messages:'
      + '\n  git reset --soft $(git merge-base main HEAD) && git commit'
      : '\nThe commit was not created. Your message is preserved; edit and re-run `git commit`.',
  );
  process.exit(1);
}
