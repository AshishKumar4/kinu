/**
 * The doc-claim gate: a document naming a symbol, a path or a count must name one
 * the code has.
 *
 * WHY IT EXISTS. Every gate in this repository compares code to code. That is why
 * four features were designed, discussed, built, tested and never wired without a
 * single check going red: `gate:dead-code` counts a barrel re-export and a test
 * reference as references, so a feature with exports, tests and no production caller
 * passes everything. The documents drifted the same way, and nothing measured them
 * at all. `docs/FORMAL-SPEC.md` claimed 84 theorems against a measured 330;
 * `docs/TOOLS.md` claimed a 9,034-character tool schema against a measured 11,823
 * and called it a reduction from 10,201 when the surface had GROWN past both;
 * `tasks` has four actions and two tables listed three; a brief that said "seven
 * named presets" propagated into three agents' documents before anyone counted
 * `NAMED_SWARM_PRESETS`, which is six.
 *
 * WHAT IT GOVERNS. Two shapes, and both were measured on this tree rather than
 * imagined:
 *
 *   1. A REFERENCE — a document naming a code symbol or a repository path. Measured
 *      2026-08-19 at 0fff343e over 31 documents: 379 path claims and 1,110 symbol
 *      claims governed, of which 35 named something absent and are locked. Among
 *      them `cf-backend/src/rlm.ts` (the module is `packages/core/src/rlm.ts`),
 *      `cf-backend/src/lib/timeline.ts` (it is `core/src/read-models/timeline.ts`),
 *      `packages/cf-backend/src/craft-executor.ts` (it is in `cli-backend`),
 *      `VFS_SCHEMA_DDL`, `StorageIsolated` and `triggerEvolution`. Nine of the 35
 *      are one document, `docs/AGENT-CLIENT-ARCHITECTURE-SPEC.md`, whose table of
 *      "active stale call sites" now names files and functions that no longer
 *      exist — a document that described the tree correctly and was never revisited
 *      when the work it asked for landed.
 *   2. A COUNT — a document stating how many of something there are, where the code
 *      enumerates it. 15 count claims governed, all true at 0fff343e. The
 *      enumerations are IMPORTED, never re-counted here, so this gate cannot hold a
 *      number of its own.
 *
 * WHAT IT REFUSES TO CHECK is the most useful thing it says, and it is printed on
 * the green path so nobody has to read this file to find it. The short form: a
 * figure that source does not enumerate is not governed, and no amount of pattern
 * work will change that. A wall clock, a token count and a byte budget are all the
 * same token to a scanner as a configured limit. The long form is in `blindSpots`.
 *
 * WHY THE RESOLUTION SET IS THE AST AND NOT THE TEXT. A name resolves when some
 * parseable file uses it as an IDENTIFIER. Admitting string literals was measured
 * and rejected: at 0fff343e it laundered five false claims, and the worst of them
 * is the argument on its own. `packages/cf-backend/tests/unit-auth-security.test.ts`
 * asserts `expect(orchestrator).not.toContain('cliPrepareLocalTurn')` — a test whose
 * whole purpose is to prove the symbol is ABSENT would have greened a document
 * claiming it is present.
 *
 * WHY IT IS RATCHETED. The false claims on today's tree cannot be fixed by this
 * gate's own commit: three separate branches are rewriting twenty-three of the
 * thirty-one documents as this lands. So the census is recorded and only NEW claims
 * fail. A lock entry that stops reproducing is a failure too, in the words
 * `gate-ratchet.ts` already uses for `dead-code`: the shrink is named and the
 * command that records it is printed, because a reflexive re-lock turns a ratchet
 * into an allowlist.
 */

import {
  AGENTS_TOOL_ACTIONS, BUILTIN_TOOLS, FILE_TOOL_ACTIONS, MEMORY_FACT_ACTIONS,
  MEMORY_NOTE_ACTIONS, TASKS_TOOL_ACTIONS, WEB_TOOL_ACTIONS,
} from '../packages/core/src/tools/registry';
import { NAMED_SWARM_PRESETS, SWARM_PRESETS } from '../packages/core/src/strategy/swarm';
import { assertMeasured, finding, reconcile, report, writeLock } from './gate-ratchet';
import { citations } from './lean-citations';
import {
  isDocument, isParseable, isTextSource, readMatching, trackedFiles,
} from './sources';
import { parse, walk } from './syntax';

const LOCK = new URL('doc-claims.lock.json', import.meta.url).pathname;

/* ── What a claim looks like ───────────────────────────────────────────── */

/** A fenced block. Stripped, because the numbers and names inside one are the
 *  author's example rather than a claim about this tree. */
const FENCE = /^```[\s\S]*?^```/gm;

/**
 * A PATH claim: a code span holding nothing but a path with a source or document
 * extension. An author marking a path as code is asserting that it is a path, which
 * is what makes this checkable at all and what keeps English prose out.
 *
 * Extracted from the prose with `matchAll` rather than tested against each span,
 * because extraction is what this is — finding file MENTIONS inside prose, which is
 * the shape `platform-catalog` established and which `gate-set-equality` recognises
 * as reading content rather than picking a corpus. A `.test` here would be
 * indistinguishable, to that gate and to a reader, from a gate selecting its own
 * files, and it would be right to refuse it.
 */
const PATH_CLAIM =
  /`\s*([A-Za-z0-9_@./-]+\.(?:tsx?|jsx?|mjs|cjs|json|jsonc|sh|md|ya?ml|toml|py))\s*`/g;

/** A NAME claim: a code span holding an identifier, or a dotted path of them, with
 *  an optional call suffix. Each segment is filtered by the two shape rules below —
 *  `AgentsForkDeps.registry` asks about the type as well as the field. */
const NAME_CLAIM =
  /`\s*([A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*)(?:\(\))?\s*`/g;

/** A name with a lower-to-upper boundary and NO underscore: a function, a class, a
 *  type, a field. This is the strong arm — it resolves against identifiers only.
 *  The underscore is what keeps `lean-citations.ts`'s domain out: a Lean theorem
 *  name is snake_case, and `applyRewards_sum_invariant` sits in a table cell of its
 *  own where nothing says `.lean`, so it would otherwise arrive here and be judged
 *  against a TypeScript index that never held it. */
const BOUNDARY = /^[^_]*[a-z][A-Za-z0-9]*[A-Z][^_]*$/;

/** An all-caps name with an underscore: a constant, an environment key, a shell
 *  variable. The weak arm, and the reason is measured. `EXPECT_LIVE` lives in
 *  `scripts/eval-tier.sh`, `TBENCH_SETTLE` in `scripts/tbench-after-deploy.sh` and
 *  `CLOUDFLARE_API_TOKEN` inside a `cleanEnv("…")` argument — none of the three is
 *  an identifier anywhere, and all three are real. So this arm resolves against
 *  code TEXT, documents excluded. */
const CONSTANT = /^[A-Z][A-Z0-9]*_[A-Z0-9_]+$/;

/** A number a count claim can be written with. */
const NUMBERS: ReadonlyMap<string, number> = new Map([
  ['one', 1], ['two', 2], ['three', 3], ['four', 4], ['five', 5], ['six', 6],
  ['seven', 7], ['eight', 8], ['nine', 9], ['ten', 10], ['eleven', 11],
  ['twelve', 12], ['thirteen', 13], ['fourteen', 14], ['fifteen', 15],
  ['sixteen', 16], ['seventeen', 17], ['eighteen', 18], ['nineteen', 19],
  ['twenty', 20],
]);

/**
 * Language that makes the number beside it a SUBSET rather than a total. This is
 * the whole of the count check's precision, and it was found by measurement:
 * `README.md` reads "The search is one action on one tool … The other six actions
 * are `hire`, `ask`, `send`, `reply`, `list` and `dismiss`", which is true of seven
 * actions and would otherwise arrive as a count of six.
 */
const SUBSET =
  /\b(?:other|others|another|remaining|rest|more|further|additional|only|first|last|next|each|both|of\s+(?:the|its|those|these|them|our))\s+$/i;

/**
 * Language a documenting author writes around a claim about something the tree does
 * NOT have. Matched over the enclosing PARAGRAPH and never one sentence, because a
 * removal is explained in one sentence and named in the next.
 *
 * It is ordinary prose rather than a marker token, and that is the design. A token
 * costs an author nothing, so it gets pasted, and then nobody can tell a documented
 * absence from a silencing. This rides on documentation the reader wanted anyway —
 * the shape `lean-citations.ts` adopted for the same reason.
 */
const ABSENCE_PROSE = new RegExp([
  // Removed, renamed, superseded.
  'delet\\w*', 'remov\\w*', 'no longer', 'used to', 'renam\\w*',
  '(?:is|are|was|were) gone',
  'supersed\\w*', 'retir\\w*', 'earlier', 'at commit', 'before this', '\\bBefore\\b',
  'moved (?:off|out|wholesale|entirely)', 'never existed', 'no callers',
  // Stated absence.
  'there is no', 'does not exist', 'deliberately no', 'not one of them', 'absent',
  'no \\w+ interface', 'refuses',
  // Not ours: an upstream package, a platform global, a vendor constant.
  'upstream', 'vendor\\w*', 'codemode', 'browser', 'litellm', 'SDK',
  // Written by the system rather than shipped by the repository.
  'VFS', 'generated', 'at runtime', 'deploys the generated', 'writes a structured',
  // Presented as an example.
  'for example', 'placeholder\\w*', 'illustrat\\w*', 'Repro \\d', 'hypothetical',
  'propos\\w*',
].join('|'), 'i');

/* ── The register of documented absences ───────────────────────────────── */

/**
 * A claim that names something absent ON PURPOSE. `AGENTS.md` does this for
 * features it removed, `docs/BRANCH-ARCHIVE.md` for the documents it archived, and
 * `docs/OBSERVABILITY.md` for a matcher it deleted — in every case the history is
 * the point, and a gate that made the account of a removal unwritable would be an
 * instrument for undocumented removals.
 *
 * THREE PROPERTIES, and the third is the one that stops this being an allowlist.
 *
 * 1. ENROLLED, so adding one is a reviewable edit with a stated reason rather than
 *    a regex tweak.
 * 2. It CHANGES which check applies and never disables one. A reference must
 *    RESOLVE; a documented absence must NOT — see `auditRegister`.
 * 3. TWO INDEPENDENT CONDITIONS are required at every site: the declaration here,
 *    AND prose around the citation that documents the absence. The declaration
 *    alone is a skip. `lean-citations.ts` states the reason in one line and it is
 *    the reason this design was copied: "the declaration alone is a skip, and the
 *    prose alone would let any unenrolled placeholder through."
 *
 * The residual is what makes the category self-policing. An entry whose claim
 * RESOLVES is refused and the claim is still checked live, so enrolling a live
 * symbol is ineffective rather than exculpatory. That is the only thing a category
 * like this could get wrong, and it is the thing that is checked first.
 */
export interface Absence {
  /** The document whose prose documents it. */
  readonly file: string;
  /** The claim exactly as written. NOT a pattern — a pattern is an allowlist. */
  readonly cites: string;
  /** Why the tree does not have it. Required: a declared category with no stated
   *  reason is a skip wearing a costume. */
  readonly reason: string;
}

const DOCUMENTED_ABSENCE: readonly Absence[] = [
  {
    file: 'AGENTS.md',
    cites: 'scaffold/agent.js',
    reason: 'A path inside the workspace VFS, not in this repository. The scaffold is'
      + ' a row in `scaffold_versions` that the agent rewrites at runtime, so no'
      + ' commit can contain it and no enumeration of tracked files can see it.',
  },
  {
    file: 'docs/EVOLUTION.md',
    cites: 'scaffold/agent.js',
    reason: 'The same VFS path, in the document that describes writing to it.',
  },
  {
    file: 'docs/EXTENSIBILITY.md',
    cites: 'scaffold/agent.js',
    reason: 'The same VFS path, in the document that describes reading it.',
  },
  {
    file: 'docs/NIMBUS-INTEGRATION.md',
    cites: 'scaffold/agent.js',
    reason: 'The same VFS path, in the document that says which actor writes which'
      + ' one.',
  },
  {
    file: 'bench/clbench/README.md',
    cites: 'UsageEvent',
    reason: "litellm's own record shape. The harness prices a turn through litellm,"
      + ' so the type belongs to that tool and not to this tree.',
  },
  {
    file: 'docs/DEPLOYMENT.md',
    cites: 'packages/cf-backend/.wrangler/deploy/config.json',
    reason: 'Written by `wrangler` during a deploy and gitignored. A document about'
      + ' deploying has to be able to name the file the deploy produces.',
  },
  {
    file: 'docs/BRANCH-ARCHIVE.md',
    cites: 'docs/EXECUTOR-V2.md',
    reason: 'An archived document, named in the table that records why it was'
      + ' archived. This is the whole purpose of that file.',
  },
  {
    file: 'docs/BRANCH-ARCHIVE.md',
    cites: 'docs/REQUIREMENTS-AUDIT.md',
    reason: 'The same archive table, same reason.',
  },
  {
    file: 'docs/BRANCH-ARCHIVE.md',
    cites: 'docs/STABILITY-AUDIT.md',
    reason: 'The same archive table, same reason.',
  },
  {
    file: 'docs/BRANCH-ARCHIVE.md',
    cites: 'packages/cf-backend/src/nimbus-measure.ts',
    reason: 'A deleted module named in the row that records its deletion.',
  },
  {
    file: 'docs/OBSERVABILITY.md',
    cites: 'executorOutputIsError',
    reason: 'Deleted, and the sentence naming it says so. It was one of three prose'
      + ' matchers replaced by the error class, and a reader who does not know the'
      + ' old name cannot tell whether the replacement covered their case.',
  },
  {
    file: 'CHANGELOG.md',
    cites: 'executorOutputIsError',
    reason: 'The release record of that deletion. A changelog entry cannot be'
      + ' corrected without falsifying the record it is.',
  },
  {
    file: 'CHANGELOG.md',
    cites: 'isExecutorFailure',
    reason: 'The same release record.',
  },
  {
    file: 'CHANGELOG.md',
    cites: 'runCraftedToolGepa',
    reason: 'The same release record: the entry that says it was deleted.',
  },
  {
    file: 'docs/OBSERVABILITY.md',
    cites: 'startSpan',
    reason: 'A shape this repository decided AGAINST. The paragraph exists to say'
      + ' that no such function is offered and why, so the name has to appear.',
  },
  {
    file: 'docs/OBSERVABILITY.md',
    cites: 'ioError',
    reason: 'A rejected spelling, named in the sentence that rejects it.',
  },
  {
    file: 'docs/EXTENSIBILITY.md',
    cites: 'CredentialStore',
    reason: 'Named in the sentence "there is no `CredentialStore` interface". A'
      + ' reader arriving with that expectation needs the negative stated.',
  },
  {
    file: 'docs/EXTENSIBILITY.md',
    cites: 'InferenceLoop',
    reason: 'The same negative, in the sentence "There is no `InferenceLoop`".',
  },
  {
    file: 'docs/EVOLUTION.md',
    cites: 'XMLHttpRequest',
    reason: 'A browser global in the egress-guard pattern table. It is a string the'
      + ' guard matches in generated scaffold source, not a symbol this tree uses.',
  },
  {
    file: 'docs/EVOLUTION.md',
    cites: 'EventSource',
    reason: 'The same pattern table, same reason.',
  },
  {
    file: 'docs/CRAFT-ARCHITECTURE.md',
    cites: 'helperA',
    reason: 'An invented tool name in a sentence about composition. Two names are'
      + ' needed to say that one crafted tool can call another.',
  },
  {
    file: 'docs/CRAFT-ARCHITECTURE.md',
    cites: 'helperB',
    reason: 'The other half of the same example.',
  },
];

/* ── The register of enumerations ──────────────────────────────────────── */

/**
 * Something the code enumerates, and the words a document uses for it.
 *
 * The members are IMPORTED. That is the load-bearing decision: this gate cannot
 * hold a count of its own, so it cannot be the thing that goes stale, and a derived
 * enumeration works without a second spelling — `NAMED_SWARM_PRESETS` is
 * `SWARM_PRESETS.filter(…)`, which no parser can count and an import gets right.
 *
 * `nouns` carry NO intervening words on purpose. "six named presets" and "seven
 * presets" are both true and they are different claims, so a rule that skipped
 * adjectives would compare one against the other — which is exactly the error that
 * put "seven named presets" into three documents.
 *
 * That one rule is also why no tie-break is needed between a phrase and a longer
 * phrase ending in it. The number must sit immediately before the noun, so
 * `presets` cannot match inside "six named presets" — nothing numeric precedes
 * `presets` there. A tie-break was written for this and removed once mutation
 * testing showed no fixture could reach it.
 */
export interface Enumeration {
  /** The exact noun phrases prose uses, lowercase. */
  readonly nouns: readonly string[];
  /** A word that must appear near the claim for it to bind here. Two enumerations
   *  may share a noun only if their owners differ — `actions` belongs to whichever
   *  tool the sentence names, and a sentence naming neither is not governed. */
  readonly owner: string | undefined;
  /** `path:name` — where the enumeration is declared. Verified to contain it. */
  readonly declares: string;
  /** How many there are, now. */
  readonly members: number;
  /** Why THIS is the enumeration and not a subset of it. */
  readonly reason: string;
}

const ENUMERATIONS: readonly Enumeration[] = [
  {
    nouns: ['actions'],
    owner: 'agents',
    declares: 'packages/core/src/tools/registry.ts:AGENTS_TOOL_ACTIONS',
    members: AGENTS_TOOL_ACTIONS.length,
    reason: 'Every action the delegation surface can expose. Which ones an actor'
      + ' gets depends on the deps its backend wires, so a document counting what a'
      + ' particular actor sees is counting something else and is not governed here.',
  },
  {
    nouns: ['actions'],
    owner: 'file',
    declares: 'packages/core/src/tools/registry.ts:FILE_TOOL_ACTIONS',
    members: FILE_TOOL_ACTIONS.length,
    reason: 'The file plane is one tool with these actions, and the count is the'
      + ' argument: reading, replacing and creating are one concept.',
  },
  {
    nouns: ['actions'],
    owner: 'tasks',
    declares: 'packages/core/src/tools/registry.ts:TASKS_TOOL_ACTIONS',
    members: TASKS_TOOL_ACTIONS.length,
    reason: 'The measured defect: two tables said three while the declaration had'
      + ' four.',
  },
  {
    nouns: ['actions'],
    owner: 'web',
    declares: 'packages/core/src/tools/registry.ts:WEB_TOOL_ACTIONS',
    members: WEB_TOOL_ACTIONS.length,
    reason: 'Discovery and retrieval, one capability used as a pair.',
  },
  {
    nouns: ['prose actions'],
    owner: 'memory',
    declares: 'packages/core/src/tools/registry.ts:MEMORY_NOTE_ACTIONS',
    members: MEMORY_NOTE_ACTIONS.length,
    reason: 'The `memory` tool has two action groups with different storage shapes.'
      + ' A single count of "memory actions" would be ambiguous between them, so'
      + ' each group is registered under the phrase that names it.',
  },
  {
    nouns: ['keyed actions'],
    owner: 'memory',
    declares: 'packages/core/src/tools/registry.ts:MEMORY_FACT_ACTIONS',
    members: MEMORY_FACT_ACTIONS.length,
    reason: 'The other group, gated on the FactsStore dep.',
  },
  {
    nouns: ['builtin tools'],
    owner: undefined,
    declares: 'packages/core/src/tools/registry.ts:BUILTIN_TOOLS',
    members: BUILTIN_TOOLS.length,
    reason: 'The native surface. Derived from the capability declaration, so a tool'
      + ' cannot be listed here that the declaration does not call native.',
  },
  {
    nouns: ['presets'],
    owner: undefined,
    declares: 'packages/core/src/strategy/swarm.ts:SWARM_PRESETS',
    members: SWARM_PRESETS.length,
    reason: 'Every token the `preset` field accepts, `custom` included.',
  },
  {
    nouns: ['named presets'],
    owner: undefined,
    declares: 'packages/core/src/strategy/swarm.ts:NAMED_SWARM_PRESETS',
    members: NAMED_SWARM_PRESETS.length,
    reason: 'Everything `from` may point at. `custom` is excluded because a'
      + ' composition cannot be seeded from "no preset is the base", and the'
      + ' one-off-by-one between these two registers is the defect that put "seven'
      + ' named presets" into three documents.',
  },
];

/** The Lean theorem corpus, registered separately because it is the one enumeration
 *  in another language. Counted by `lean/check-traceability.mjs`, the scanner
 *  `lean-citations.ts` already consumes, so there is one Lean parser and no second
 *  spelling of the theorem set. The stale claim of 84 against a measured 330 is the
 *  largest single doc-to-code contradiction this tree has had. */
function leanTheorems(): Enumeration {
  return {
    nouns: ['theorems', 'named theorems', 'published theorems'],
    owner: undefined,
    declares: 'lean/check-traceability.mjs:--list-declarations',
    members: citations().declarations.size,
    reason: 'Every theorem the Lean corpus declares, from the one scanner that'
      + ' parses Lean. A document may legitimately count a SUBSET of them — eleven'
      + ' in `lean/Proteus/MCTS/` — and `SUBSET` above is what keeps that readable'
      + ' as a subset rather than a contradiction.',
  };
}

/* ── What the scan reads ───────────────────────────────────────────────── */

/** Built once and carried across the corpus. A factory rather than module state, so
 *  every red direction is provable against synthetic text instead of by mutating
 *  the tree the gate governs. */
export interface Claims {
  /** Every name used as an identifier by a parseable file. */
  readonly identifiers: ReadonlySet<string>;
  /** Every word token in non-document text: the all-caps arm's resolution set. */
  readonly words: ReadonlySet<string>;
  /** Every quoted object key in non-document text: a name the BUILD uses rather
   *  than one the code calls. `noEmit`, `verbatimModuleSyntax` and
   *  `allowImportingTsExtensions` are real and are keys in a tracked `tsconfig`,
   *  never identifiers. Read by the same quoted-key shape everywhere rather than
   *  from a file list, so no path pattern is needed to find the config. */
  readonly configKeys: ReadonlySet<string>;
  readonly tracked: readonly string[];
  readonly trackedSet: ReadonlySet<string>;
  /** Top-level names under `packages/`, for the shorthand spellings. */
  readonly packages: ReadonlySet<string>;
  /** Every directory name in the tree, for deciding whether a path claim is even
   *  about this repository. */
  readonly directories: ReadonlySet<string>;
  readonly enumerations: readonly Enumeration[];
  /** `file -> its validated absence entries`. Empty until `auditRegister` has run:
   *  an entry that failed validation must exempt nothing. */
  readonly absences: Map<string, Absence[]>;
  paths: number;
  names: number;
  counts: number;
  absenceSites: number;
  /** Count claims whose noun matched but whose owner did not disambiguate. */
  ambiguous: number;
}

export function claims(enumerations: readonly Enumeration[]): Claims {
  const identifiers = new Set<string>();
  for (const [file, text] of readMatching(isParseable)) {
    walk(parse(file, text).root, (node) => {
      const raw = node.raw;
      if (raw.type === 'Identifier' || raw.type === 'PrivateIdentifier'
        || raw.type === 'JSXIdentifier') identifiers.add(raw.name);
    });
  }
  const words = new Set<string>();
  const configKeys = new Set<string>();
  for (const [file, text] of readMatching(isTextSource)) {
    if (isDocument(file)) continue;
    for (const word of text.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) words.add(word[0]);
    for (const key of text.matchAll(/"([A-Za-z_$][A-Za-z0-9_$]*)"\s*:/g)) {
      configKeys.add(key[1] ?? '');
    }
  }
  const tracked = trackedFiles();
  const packages = new Set<string>();
  const directories = new Set<string>();
  for (const file of tracked) {
    const parts = file.split('/');
    if (parts[0] === 'packages' && parts.length > 2) packages.add(parts[1]);
    for (let i = 0; i < parts.length - 1; i += 1) directories.add(parts[i]);
  }
  return {
    identifiers,
    words,
    configKeys,
    tracked,
    trackedSet: new Set(tracked),
    packages,
    directories,
    enumerations,
    absences: new Map(),
    paths: 0,
    names: 0,
    counts: 0,
    absenceSites: 0,
    ambiguous: 0,
  };
}

/* ── Resolution ────────────────────────────────────────────────────────── */

/**
 * The spellings a path claim can have. Documents write `core/extension.ts` for
 * `packages/core/src/extension.ts` and `@kinu/core/tools/builtins.ts` for the
 * same thing under the workspace scope, and both are the tree's own vocabulary
 * rather than a mistake — all twelve `core/…` claims in `docs/EXTENSIBILITY.md`
 * resolve this way and every one of them is true.
 */
function spellings(path: string, seen: Claims): string[] {
  const scoped = path.startsWith('@kinu/') ? path.slice('@kinu/'.length) : path;
  const cut = scoped.indexOf('/');
  const head = cut === -1 ? scoped : scoped.slice(0, cut);
  if (cut === -1 || !seen.packages.has(head)) return [scoped];
  const rest = scoped.slice(cut + 1);
  return [scoped, `packages/${head}/${rest}`, `packages/${head}/src/${rest}`];
}

/**
 * Whether a path claim is about this repository at all: its leading segment has to
 * be a directory the tree has.
 *
 * `/install.sh` is a served route, `dist/proteus/wrangler.json` is build output, and
 * `SOUL.md` or `agent.js` is a file the system writes into a workspace VFS. All
 * three are true sentences about paths this repository does not contain, and all
 * three are stated as blind spots.
 *
 * One condition, not two. A bare basename is excluded by the same test, because no
 * directory in this tree is named like a file — a separate "must have a directory
 * part" guard was written, and mutation testing showed no fixture could reach it,
 * so it is gone rather than left looking load-bearing.
 */
function governed(path: string, seen: Claims): boolean {
  const head = spellings(path, seen)[0]?.split('/')[0];
  return head !== undefined && (seen.directories.has(head) || seen.packages.has(head));
}

const resolvesPath = (path: string, seen: Claims): boolean =>
  spellings(path, seen).some((one) =>
    seen.trackedSet.has(one) || seen.tracked.some((file) => file.endsWith(`/${one}`)));

const resolvesName = (name: string, seen: Claims): boolean =>
  seen.identifiers.has(name) || seen.configKeys.has(name)
  || (CONSTANT.test(name) && seen.words.has(name));

/** Whether a claim resolves at all, either way. Used by the register's residual
 *  check, so "declared absent but actually present" is one question rather than two.
 *  Both resolvers are asked and neither needs to know which shape it was handed: a
 *  path is no identifier and an identifier matches no tracked file, so the OR
 *  classifies nothing and cannot classify it wrongly. */
const resolves = (cites: string, seen: Claims): boolean =>
  resolvesPath(cites, seen) || resolvesName(cites, seen);

/* ── The registers, judged before either is trusted ────────────────────── */

/**
 * Both registers' own obligations. Checked first and separately, because a register
 * that is itself incoherent cannot judge a document — and because these are the
 * properties the whole instrument rests on. Only entries that pass reach
 * `seen.absences`.
 */
export function auditRegister(seen: Claims, absences: readonly Absence[]): string[] {
  const findings: string[] = [];
  const corpus = readMatching(isDocument);

  for (const entry of absences) {
    if (entry.reason.length === 0) {
      findings.push(`DOCUMENTED_ABSENCE entry for \`${entry.cites}\` states no reason`);
      continue;
    }
    if (resolves(entry.cites, seen)) {
      findings.push(
        `DOCUMENTED_ABSENCE declares \`${entry.cites}\` (${entry.file}) absent, but the`
        + ' tree has it — an absence may not name something that exists, because that'
        + ' is how the category would launder a stale claim. The claim is still'
        + ' checked live.',
      );
      continue;
    }
    const host = corpus.get(entry.file);
    if (host === undefined) {
      findings.push(`DOCUMENTED_ABSENCE names a file outside the corpus: ${entry.file}`);
      continue;
    }
    if (!host.includes(entry.cites)) {
      findings.push(
        `DOCUMENTED_ABSENCE declares \`${entry.cites}\` in ${entry.file}, which no longer`
        + ' contains it — a declaration that outlived its prose exempts nothing and'
        + ' hides the next one that matters',
      );
      continue;
    }
    seen.absences.set(entry.file, [...(seen.absences.get(entry.file) ?? []), entry]);
  }

  const byNoun = new Map<string, Enumeration[]>();
  for (const entry of seen.enumerations) {
    if (entry.members === 0) {
      findings.push(
        `${entry.declares} enumerates nothing — a count check against an empty set`
        + ' cannot fail',
      );
    }
    const [path, name] = entry.declares.split(':');
    if (path === undefined || name === undefined || !seen.trackedSet.has(path)) {
      findings.push(`${entry.declares} does not name a tracked file`);
    } else if (!readMatching((file) => file === path).get(path)?.includes(name)) {
      findings.push(
        `${entry.declares} names a declaration that file does not contain — the`
        + ' enumeration moved and the register did not',
      );
    }
    for (const noun of entry.nouns) byNoun.set(noun, [...(byNoun.get(noun) ?? []), entry]);
  }
  for (const [noun, entries] of byNoun) {
    const owners = new Set(entries.map((entry) => entry.owner));
    if (entries.length > 1 && (owners.size !== entries.length || owners.has(undefined))) {
      findings.push(
        `two enumerations claim the phrase "${noun}" without distinct owners`
        + ` (${entries.map((entry) => entry.declares).join(', ')}) — a claim that could`
        + ' bind to either is a coin toss, and a coin toss in a gate is worse than no'
        + ' gate',
      );
    }
  }
  return findings;
}

/* ── One document, audited ─────────────────────────────────────────────── */

/** A finding, keyed for the ratchet. The key omits line numbers on purpose: a claim
 *  is one claim however often a document repeats it, and an insertion above it is
 *  not a new violation. */
export interface Claim {
  readonly key: string;
  readonly body: string;
}

/** The paragraph a claim sits in, for the absence-prose condition. */
function paragraphAround(text: string, index: number): string {
  const before = text.lastIndexOf('\n\n', index);
  const after = text.indexOf('\n\n', index);
  return text.slice(before === -1 ? 0 : before, after === -1 ? text.length : after);
}

/** Is this exact claim, at this site, a declared absence whose paragraph documents
 *  it? Both halves are required: the declaration alone is a skip, and the prose
 *  alone would let any unenrolled name through. */
function documented(
  file: string, cites: string, text: string, index: number, seen: Claims,
): boolean {
  const declared = seen.absences.get(file)?.some((entry) => entry.cites === cites);
  if (declared !== true) return false;
  return ABSENCE_PROSE.test(paragraphAround(text, index));
}

/** The claims a document makes about a symbol or a path. Two passes over the same
 *  prose, one per shape, because a path and an identifier are found by different
 *  patterns and neither has to be told apart from the other afterwards. */
function references(file: string, text: string, seen: Claims): Claim[] {
  const found: Claim[] = [];

  for (const match of text.matchAll(PATH_CLAIM)) {
    const path = match[1] ?? '';
    // A Lean module is `lean-citations.ts`'s domain, and it resolves both halves of
    // the citation against the Lean scanner. Reading one here would be a second
    // spelling of one question, and the two would disagree the first time either
    // changed.
    if (path.endsWith('.lean') || !governed(path, seen)) continue;
    if (documented(file, path, text, match.index, seen)) {
      seen.absenceSites += 1;
      continue;
    }
    seen.paths += 1;
    if (resolvesPath(path, seen)) continue;
    found.push({
      key: `${file}: path ${path}`,
      body: finding({
        invariant: 'a path a document names exists in the tree',
        at: `${file} — \`${path}\``,
        found: "no tracked file matches it, under any of the tree's own spellings",
        silently: 'a reader follows the path, finds nothing, and cannot tell whether'
          + ' the file moved, was deleted, or never existed',
        fix: 'name the file that exists, or enrol it in DOCUMENTED_ABSENCE with the'
          + ' reason it is named while absent',
      }),
    });
  }

  for (const match of text.matchAll(NAME_CLAIM)) {
    const span = match[1] ?? '';
    if (span.endsWith('.lean')) continue;
    for (const part of span.split('.')) {
      if (!BOUNDARY.test(part) && !CONSTANT.test(part)) continue;
      if (documented(file, part, text, match.index, seen)) {
        seen.absenceSites += 1;
        continue;
      }
      seen.names += 1;
      if (resolvesName(part, seen)) continue;
      found.push({
        key: `${file}: symbol ${part}`,
        body: finding({
          invariant: 'a symbol a document names is a name the code uses',
          at: `${file} — \`${part}\``,
          found: CONSTANT.test(part)
            ? 'no code text in the tree contains it'
            : 'no parseable file uses it as an identifier',
          silently: 'the document reads as a description of code that is not there, and'
            + ' a reader who greps for it concludes the search was wrong',
          fix: 'name the symbol that exists, or enrol it in DOCUMENTED_ABSENCE with the'
            + ' reason it is named while absent',
        }),
      });
    }
  }
  return found;
}

/** Every count claim a document makes about a registered enumeration. */
function countClaims(file: string, text: string, seen: Claims): Claim[] {
  const found: Claim[] = [];
  // Backticks off, so `` `tasks` has four actions `` reads as one sentence and the
  // owner is findable in it.
  const flat = text.replace(/`/g, '');
  const nouns = new Set(seen.enumerations.flatMap((entry) => entry.nouns));
  for (const noun of nouns) {
    const pattern = new RegExp(
      `(?<![\\w.])(\\d[\\d,]*|${[...NUMBERS.keys()].join('|')})\\s+${noun}\\b`, 'gi',
    );
    for (const match of flat.matchAll(pattern)) {
      if (SUBSET.test(flat.slice(Math.max(0, match.index - 40), match.index))) continue;
      const word = (match[1] ?? '').toLowerCase();
      const stated = NUMBERS.get(word) ?? Number(word.replace(/,/g, ''));
      if (!Number.isFinite(stated)) continue;
      const sentence = flat.slice(Math.max(0, match.index - 200), match.index + 200);
      const candidates = seen.enumerations.filter((entry) =>
        entry.nouns.includes(noun)
        && (entry.owner === undefined || sentence.includes(entry.owner)));
      if (candidates.length !== 1 || candidates[0] === undefined) {
        seen.ambiguous += 1;
        continue;
      }
      const entry = candidates[0];
      seen.counts += 1;
      if (stated === entry.members) continue;
      found.push({
        key: `${file}: count ${String(stated)} ${noun}`,
        body: finding({
          invariant: `a stated count matches ${entry.declares}`,
          at: `${file} — "${match[0]}"`,
          found: `${entry.declares} has ${String(entry.members)}`,
          silently: 'a reader takes the document as the enumeration, and a caller who'
            + ' trusts it sends a value the picklist refuses or misses one it accepts',
          fix: `write ${String(entry.members)}, or state which subset this counts`,
        }),
      });
    }
  }
  return found;
}

/**
 * One document, audited. Exported so every direction this gate claims to govern is
 * provable against synthetic text rather than by mutating the tree it governs.
 */
export function auditDocument(file: string, text: string, seen: Claims): Claim[] {
  const prose = text.replace(FENCE, '\n');
  return [...references(file, prose, seen), ...countClaims(file, prose, seen)];
}

/** The corpus-wide check: a scan that found nothing certifies nothing. */
export function auditCoverage(seen: Claims): string[] {
  if (seen.paths > 0 && seen.names > 0 && seen.counts > 0) return [];
  return [
    `the scan governed ${String(seen.paths)} path, ${String(seen.names)} symbol and`
    + ` ${String(seen.counts)} count claims, so it cannot fail — an empty corpus`
    + ' certifies nothing',
  ];
}

/* ── The verdict ───────────────────────────────────────────────────────── */

/** Printed on the SUCCESS path, because a blind spot that appears only in red output
 *  is invisible exactly when the tree is green, which is when it matters. */
function blindSpots(seen: Claims): string {
  return [
    'doc-claims: BLIND SPOTS, so this pass is not mistaken for a document being right.',
    '  1. A FIGURE THAT SOURCE DOES NOT ENUMERATE is not governed, and this is the'
    + ' boundary the gate is built around. A wall clock, a token count, a byte budget'
    + ' and a price are the same token to a scanner as a configured limit. The house'
    + ' rule is that a document states what was measured with its number and its date,'
    + ' or says the figure is not measured — and that rule is NOT enforced here.'
    + ' Measured 2026-08-19 at 0fff343e: the cheapest sound form of it, a sentence'
    + ' carrying a measurement verb and a number and no date, produced 22 findings, of'
    + " which the majority name no measurement at all — a heading's `5.1`, the `3` in"
    + ' `--3way`, a citation year, and the phrase "a measured run" carrying no figure.'
    + ' The rule cannot tell WHICH number in a sentence is the measured one, and the'
    + ' only way to make it precise is to guess. A gate whose findings are mostly wrong'
    + ' gets switched off, and switching it off takes the two shapes that do work.',
    '  2. LINE NUMBERS are not checked. Three documents rewritten on 2026-08-19 carry'
    + ' 79 `path:line` locators between them; a line number rots on the next insertion'
    + ' above it, so existence-checking one fires on refactors that changed nothing'
    + ' about the claim while never noticing a range that slid onto different code.'
    + ' `lean-citations.ts` bounds its Lean line citations and says in its own output'
    + ' that a line is the shape it can only bound. Here the path is checked and the'
    + ' line is ignored.',
    '  3. VOCABULARY is not checked. There is no list of forbidden words in this'
    + ' program. Every verdict it reaches is derived from code, and a banned-phrase'
    + ' list has no code side, so "search node" and its like belong to whatever governs'
    + ' prose — not here.',
    '  4. TRUTH is not checked, only EXISTENCE. A symbol that resolves may still be'
    + ' described wrongly, and a path that exists may hold nothing like what the'
    + ' sentence says. Measured on 2026-08-19: `strategy/swarm.ts` lists six tested'
    + ' paths and three of them, `research`, `audit` and `redteam`, are undeclared rows'
    + ' that refuse to resolve. This gate passes that list.',
    '  5. MODEL-FACING STRINGS IN SOURCE are out of the corpus. `tools/clamp.ts` told'
    + ' the model to hand work to a fork on a surface with no fork action — a false'
    + ' claim in a `.ts`, assembled in a ternary. Nothing here reads it.',
    `  6. ${String(seen.absenceSites)} claim sites carry an author-declared absence`
    + ' (DOCUMENTED_ABSENCE): the declaration is TRUSTED, not verified — this gate'
    + ' checks only that the tree does not have the thing and that the paragraph'
    + ' documents it, never that the author was right to declare it.',
    `  7. ${String(seen.ambiguous)} count claims matched a registered noun and were`
    + ' NOT governed, because the sentence named no owner or two. A count whose noun'
    + ' is not registered is not governed either: the six search axes are the case'
    + ' that matters, and `AXES` is module-private in `strategy/swarm.ts`, so reaching'
    + ' it would mean governing a set the module does not publish. Its own refusal'
    + ' messages interpolate `AXES.length`, which is a better guarantee than this'
    + ' gate could give.',
    '  8. NOT EVERY PATH SHAPE IS A CLAIM ABOUT THIS TREE. A bare basename names no'
    + ' location and is skipped; so is a path whose first segment is no directory'
    + ' here. `/install.sh` is a served route and `dist/proteus/wrangler.json` is'
    + ' build output.',
    '  9. A NAME WITHOUT A CASE BOUNDARY is not governed. A single lowercase word in'
    + ' backticks is an action, a column or an English word far more often than a'
    + ' symbol, and an all-caps name is resolved against code TEXT rather than the'
    + ' AST, because environment keys and shell variables live in `.sh` and in config'
    + ' that no AST reaches. A deleted constant surviving in one stale comment'
    + ' therefore resolves.',
    ' 10. A STRING LITERAL IS NOT A RESOLUTION SET, deliberately. Admitting one was'
    + ' measured at 0fff343e and it laundered five false claims, including four spec'
    + ' names kept alive by a test asserting they are ABSENT.',
    ' 11. A NAME INSIDE A LARGER SPAN is not read, only a span that is exactly an'
    + ' identifier or a dotted chain of them. A quoted snippet contains the author\'s'
    + ' locals and parameters beside our symbols, and which is which is not decidable'
    + ' from the span; a fenced block is skipped for the same reason. The cost was'
    + ' measured: one real claim, `nativeNames` inside a quoted ternary in'
    + ' `docs/TOOLS.md`, which the looser rule caught by accident rather than by'
    + ' design.',
    ' 12. A VERBATIM QUOTE OF SOURCE is not compared to that source. A document that'
    + ' reproduces a named `file:line` reads perfectly after the line changes, and'
    + ' the failure is silent and directional — the document never looks wrong. The'
    + ' tractable check is not matching prose against a span but finding the CLAIM'
    + ' shape, a quoted block asserting it reproduces a named location, and handing'
    + ' it to a person. That is not built here.',
  ].join('\n');
}

if (import.meta.main) {
  const seen = claims([...ENUMERATIONS, leanTheorems()]);
  const invalid = auditRegister(seen, DOCUMENTED_ABSENCE);
  const detail = new Map<string, string>();
  const corpus = readMatching(isDocument);
  for (const [file, text] of corpus) {
    for (const claim of auditDocument(file, text, seen)) detail.set(claim.key, claim.body);
  }
  invalid.push(...auditCoverage(seen));

  const measured = assertMeasured('doc-claims', [
    ['documents', corpus.size],
    ['identifiers indexed', seen.identifiers.size],
    ['path claims', seen.paths],
    ['symbol claims', seen.names],
    ['count claims', seen.counts],
  ]);

  if (invalid.length > 0) {
    for (const one of invalid) console.error(`✗ ${one}`);
    console.error(
      `doc-claims: ${String(invalid.length)} register finding(s). These are never`
      + ' ratcheted: a register that cannot judge itself cannot judge a document.',
    );
    process.exit(1);
  }

  const keys = [...detail.keys()];
  if (process.argv.includes('--lock')) {
    console.log(`doc-claims: locked ${String(writeLock(keys, LOCK))} claim(s) over ${measured}`);
    process.exit(0);
  }
  const code = report(
    'doc-claims', reconcile(keys, LOCK), detail, 'bun scripts/doc-claims.ts --lock', measured,
  );
  if (code === 0) console.log(blindSpots(seen));
  process.exit(code);
}
