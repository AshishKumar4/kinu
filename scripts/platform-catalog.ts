/**
 * The platform catalog gate — the catalog stays evidenced, and stays load-bearing.
 *
 * `packages/core/src/platform-catalog.ts` replaces a document that vanished
 * while its citation survived in shipped code: Nimbus's `constants.ts` justifies
 * a 128 MiB production ceiling with "per a gitignored internal research note
 * §6 invariant I1", and that file has never existed on disk or in git history.
 * A catalog that can rot the same way is not an improvement, so three things are
 * checked here, each with an explicit denominator.
 *
 *   1. Every entry carries an evidence label, a provenance, a date, a trigger
 *      and a breach behaviour — and a `documented` entry's provenance is a URL
 *      while everything else names a file and line. An unlabelled number is the
 *      exact defect being replaced.
 *   2. The catalog is IMPORTED by production code. A catalog nothing reads is
 *      prose in a `.ts` extension.
 *   3. No source file states a platform number in prose without naming the
 *      catalog entry it comes from. This is the drift check: the number lives in
 *      one place and every restatement points back at it.
 *
 * ## Why check 3 reads text and not the AST
 *
 * The thing that rots is not a numeric literal — it is a SENTENCE. `2 * 1024 *
 * 1024` appears legitimately as a self-imposed cap all over this repo and means
 * nothing on its own; "(2 MB platform limit)" is a claim about Cloudflare, and
 * that is what goes stale. So the match is a number-with-unit near platform
 * vocabulary, which occurs in prose and essentially never in code: an
 * identifier ends `_MS`, it is not followed by the token `ms`.
 *
 * The escape hatch is deliberately the behaviour we want: name the entry. That
 * makes every platform sentence in the tree greppable back to its evidence.
 *
 * ## Why the positive control exists
 *
 * Three gates in this repo have reported green over nothing. A matcher that
 * silently stops matching is indistinguishable from a clean tree, so this gate
 * also requires a non-zero count of platform sentences that DO cite an entry. If
 * that number reaches zero, the regex broke and the gate fails rather than
 * congratulating itself.
 */

import {
  PLATFORM_FACT_IDS,
  injectableFaults,
  platformFact,
  platformFactEntries,
  type BoundsKind,
  type EvidenceLabel,
  type PlatformFactEntry,
} from '../packages/core/src/platform-catalog';
import { existsSync } from 'node:fs';

import { assertMeasured, finding } from './gate-ratchet';
import { readSources } from './sources';

const EVIDENCE_LABELS: readonly EvidenceLabel[] = [
  'proven-by-probe',
  'proven-by-source',
  'observed-in-production',
  'documented',
  'inferred',
  'speculative',
];

const UNITS: readonly string[] = ['bytes', 'ms', 'count'];

const BOUNDS_KINDS: readonly BoundsKind[] = [
  'peak-resident', 'wire', 'row', 'query', 'response',
  'storage', 'bundle', 'duration', 'concurrency', 'count',
];

/**
 * A followable within-file anchor, which is what a non-documented provenance must
 * carry so that "we measured this" can be checked by opening the thing.
 *
 * Four shapes, because the evidence comes in four shapes: `:12` or `:12-30` for
 * source, `§1.12` for a numbered section of a write-up, `#lastGoodMB` for a key
 * in a results file, and a `local://` / `agent://` / `artifact://` URI for a probe
 * a sibling ran in this harness and published. A bare filename is rejected, and
 * so is a wildcard like `§1.x` — an anchor nobody can resolve is the same failure
 * as no anchor.
 *
 * The URI form counts because those resolve to immutable content on demand, which
 * is the whole test: not "does it look like a source", but "can the next reader
 * open the thing and see the number". An entry citing a probe that was never
 * published stays unfollowable and is rejected, which is the outcome we want —
 * that is exactly how that internal research note came to be quoted
 * from a production constant with nothing behind it.
 */
const ARTEFACT_URI = /\b(?:local|agent|artifact):\/\/[\w./-]+/;
const LOCATOR = /\.\w+(?::\d|\s*§\s*\d+(?:\.\d+)*(?![\w.])|#[\w.-]+)/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A path inside THIS repository, named by a provenance or a breach path.
 *
 * These are the citations the gate can actually resolve, and resolving them is
 * the one check that mechanises the defect this whole catalog replaces. Two
 * documents were quoted from live code and neither existed: an internal research
 * note cited from a Nimbus production constant, and `docs/STABILITY-AUDIT.md`
 * cited from a shipped 25 s heartbeat in this repo. Both citations were perfectly
 * well FORMED. Form was never the problem — resolution was, and nothing checked
 * it, for months, in two repositories.
 *
 * Scope is deliberately narrow. `~/Nimbus/...` is a separate live repo this gate
 * has no business asserting about, `local://` and `agent://` resolve through the
 * harness rather than the filesystem, and a URL is somebody else's uptime. What
 * IS ours is every path under these roots, and a rename or deletion there now
 * turns a stale citation red on the next run instead of in six months.
 */
// The lookbehind is load-bearing: `~/Nimbus/packages/worker/src/constants.ts`
// contains `packages/worker/src/constants.ts`, and claiming that as ours would
// make every Nimbus citation red. Only a path at a real token boundary counts.
const REPO_PATH =
  /(?<![\w/~-])(?:packages|scripts|docs|lean|tools|node_modules|patches)\/[\w./@-]*\.\w+/g;

export interface EntryProblem {
  readonly id: string;
  readonly reason: string;
}

/** A knowledge gap, reported and never failed on: the entry is honest about not
 *  knowing something. Distinct from a schema violation. */
export interface EntryGap {
  readonly id: string;
  readonly missing: string;
}

export interface SchemaAudit {
  readonly inspected: number;
  readonly problems: readonly EntryProblem[];
  readonly gaps: readonly EntryGap[];
  readonly byEvidence: ReadonlyMap<EvidenceLabel, number>;
}

const root = new URL('..', import.meta.url).pathname;

/** Repo-local paths a citation names, and whether each one is still there. */
function unresolvedRepoPaths(text: string): readonly string[] {
  return [...text.matchAll(REPO_PATH)]
    .filter((m) => {
      // `git <sha>:<path>` is followable even when the path is gone — that is
      // how `docs/STABILITY-AUDIT.md` was recovered and read. A deleted file
      // cited WITH the commit that still holds it is strictly better evidence
      // than a live path, because it can never drift; cited WITHOUT one it is
      // the dangling citation this whole catalog exists to replace. The sha is
      // the entire difference and the gate insists on it.
      const before = text.slice(Math.max(0, m.index - 50), m.index);
      return !/\bgit\s+[0-9a-f]{7,40}:$/.test(before);
    })
    .map((m) => m[0])
    .filter((path) => !existsSync(root + path));
}

export function auditSchema(entries: readonly PlatformFactEntry[]): SchemaAudit {
  const problems: EntryProblem[] = [];
  const gaps: EntryGap[] = [];
  const byEvidence = new Map<EvidenceLabel, number>();
  const ids = entries.map((e) => e.id);

  for (const { id, fact } of entries) {
    const fail = (reason: string): void => void problems.push({ id, reason });

    if (fact.subject.trim().length === 0) fail('no subject');
    if (!EVIDENCE_LABELS.includes(fact.evidence)) fail(`evidence label "${fact.evidence}" is not one of the six`);
    byEvidence.set(fact.evidence, (byEvidence.get(fact.evidence) ?? 0) + 1);

    if (fact.provenance.trim().length === 0) fail('no provenance');
    else if (fact.evidence === 'documented') {
      if (!fact.provenance.startsWith('https://')) {
        fail('documented, so its provenance must be the URL that publishes it');
      }
    } else if (fact.provenance.startsWith('http')) {
      fail(`labelled ${fact.evidence} but its provenance is a URL — a doc link proves nothing was measured`);
    } else if (!LOCATOR.test(fact.provenance) && !ARTEFACT_URI.test(fact.provenance)) {
      fail(`provenance "${fact.provenance}" names nothing a reader can open`);
    }

    if (!ISO_DATE.test(fact.date) || Number.isNaN(Date.parse(fact.date))) {
      fail(`date "${fact.date}" is not an ISO calendar date`);
    }
    if (fact.trigger.trim().length === 0) fail('no trigger — nothing can fire it, so nothing can test it');
    if (fact.onBreach.trim().length === 0) fail('no breach behaviour');

    if (fact.limit !== null) {
      if (!Number.isFinite(fact.limit.value) || fact.limit.value <= 0) {
        fail(`limit value ${String(fact.limit.value)} is not a positive finite number`);
      }
      if (!UNITS.includes(fact.limit.unit)) fail(`limit unit "${fact.limit.unit}" is not a base unit`);
      // A threshold that does not say what it protects is how a response cap
      // comes to be read as isolate protection.
      if (fact.bounds === null) fail('has a threshold but does not say what it bounds');
    }
    if (fact.bounds !== null && !BOUNDS_KINDS.includes(fact.bounds)) {
      fail(`bounds "${fact.bounds}" is not one of the ten kinds`);
    }
    if (fact.knownBreachPath !== undefined && fact.knownBreachPath.trim().length === 0) {
      fail('declares a known breach path and names nothing');
    }
    // The check that mechanises the whole point: a citation into THIS repo must
    // still resolve. Both documents this catalog replaces were cited in perfect
    // form from live code and neither existed.
    for (const field of ['provenance', 'onBreach', 'notes', 'knownBreachPath'] as const) {
      const text = fact[field];
      if (text === undefined) continue;
      for (const gone of unresolvedRepoPaths(text)) {
        fail(`${field} cites \`${gone}\`, which is not in this repo`);
      }
    }

    for (const seen of fact.observable) {
      if (seen.context.trim().length === 0 || seen.message.trim().length === 0) {
        fail('an observable with an empty context or message');
      }
    }
    // Having WATCHED a failure and not recorded what it said is the gap that
    // makes a simulator invent its own error string. Only demanded of entries
    // that claim first-hand sight of the breach.
    const firstHand = fact.evidence === 'proven-by-probe' || fact.evidence === 'observed-in-production';
    if (firstHand && fact.firstPartySignal && fact.observable.length === 0) {
      fail(`${fact.evidence} with a first-party signal but no verbatim observable`);
    }
    if (!firstHand && fact.firstPartySignal && fact.observable.length === 0) {
      gaps.push({ id, missing: 'the verbatim string this surfaces as' });
    }
    if (fact.limit === null && fact.evidence === 'documented') {
      gaps.push({ id, missing: 'a threshold — documented as behaviour only' });
    }

    for (const other of fact.conflictsWith ?? []) {
      if (!ids.includes(other)) fail(`conflictsWith names "${other}", which is not a catalog id`);
    }
  }

  return { inspected: entries.length, problems, gaps, byEvidence };
}

// ── Check 3: platform sentences in source ────────────────────────────────

/** Number followed by a unit, as prose writes one. Deliberately not a numeric
 *  literal: `30_000` is a timeout, `30 s` is a claim. */
const QUANTITY = /\b\d[\d_,.]*\s?(?:ms|s|KB|KiB|MB|MiB|GB|GiB)\b/g;

/** Vocabulary that makes a quantity a claim about the platform rather than
 *  about us. Narrow on purpose, and narrowed once already: `the runtime` was in
 *  this list and matched `tools/registry.ts`, where a 2 GB cgroup is a container
 *  fact and `runtime` is a Kinu domain noun (`runtime: "workspace"`). A gate
 *  with false positives gets disabled, which is worse than no gate, so an
 *  ambiguous cue is dropped rather than special-cased. `RPC` and `timeout` are
 *  excluded for the same reason — ours as often as theirs. */
const PLATFORM_VOCABULARY: readonly string[] = [
  'platform limit',
  'platform constant',
  'platform cap',
  'Cloudflare',
  'workerd',
  'Durable Object',
  'V8 isolate',
  'Worker isolate',
  'worker isolate',
  'subrequest',
  'blockConcurrencyWhile',
  'Workers runtime',
  'SQLITE_',
  'hibernation',
  'structured-clone',
  'structuredClone',
];

/** How far from the quantity the vocabulary must sit, and how far the citation
 *  may sit. The citation window is wider because a comment block explains the
 *  claim first and names the entry at the end. */
const VOCABULARY_WINDOW = 200;
const CITATION_WINDOW = 500;

export interface ProseMention {
  readonly file: string;
  readonly line: number;
  readonly quantity: string;
  readonly vocabulary: string;
  readonly citedId: string | null;
}

const lineOf = (text: string, index: number): number =>
  text.slice(0, index).split('\n').length;

export function findProseMentions(file: string, text: string): readonly ProseMention[] {
  const found: ProseMention[] = [];
  for (const match of text.matchAll(QUANTITY)) {
    const at = match.index;
    const near = text.slice(Math.max(0, at - VOCABULARY_WINDOW), at + VOCABULARY_WINDOW);
    const vocabulary = PLATFORM_VOCABULARY.find((word) => near.includes(word));
    if (vocabulary === undefined) continue;
    const wide = text.slice(Math.max(0, at - CITATION_WINDOW), at + CITATION_WINDOW);
    const citedId = PLATFORM_FACT_IDS.find((id) => wide.includes(id)) ?? null;
    found.push({ file, line: lineOf(text, at), quantity: match[0], vocabulary, citedId });
  }
  return found;
}

export interface SourceAudit {
  readonly filesInspected: number;
  readonly mentions: readonly ProseMention[];
  readonly importers: readonly string[];
  readonly citedIds: readonly string[];
}

const CATALOG_MODULE = 'packages/core/src/platform-catalog.ts';

/**
 * Files this gate does not hold to its own prose rule, pinned as a list so the
 * test can assert it BY EQUALITY.
 *
 * There is exactly one, and it must stay exactly one: the catalog itself, which
 * states every platform number it owns and would otherwise be its own largest
 * violator. The equality assertion is the point rather than the exclusion —
 * an unpinned ignore list is how a gate dies, because appending a third path is
 * the cheapest way to make a cleanup pass go green, and nobody reviews an
 * addition to a list nothing checks. Precedent: `tools/oxlint/anti-slop/
 * gate.test.ts` pins its own ignore list the same way.
 */
export const PROSE_EXEMPT_FILES: readonly string[] = [CATALOG_MODULE];

export function auditSources(sources: ReadonlyMap<string, string>): SourceAudit {
  const mentions: ProseMention[] = [];
  const importers: string[] = [];
  const citedIds = new Set<string>();

  for (const [file, text] of sources) {
    if (PROSE_EXEMPT_FILES.includes(file)) continue;
    if (text.includes('PLATFORM_CATALOG')) importers.push(file);
    for (const id of PLATFORM_FACT_IDS) if (text.includes(id)) citedIds.add(id);
    mentions.push(...findProseMentions(file, text));
  }

  return {
    filesInspected: sources.size,
    mentions,
    importers,
    citedIds: [...citedIds],
  };
}

// ── Report ───────────────────────────────────────────────────────────────

const human = (value: number, unit: string): string => {
  if (unit !== 'bytes') return `${value.toLocaleString('en-US')} ${unit}`;
  if (value % (1000 * 1000 * 1000) === 0) return `${value / (1000 * 1000 * 1000)} GB`;
  if (value % (1024 * 1024) === 0) return `${value / (1024 * 1024)} MiB`;
  if (value % (1000 * 1000) === 0) return `${value / (1000 * 1000)} MB`;
  if (value % 1024 === 0) return `${value / 1024} KiB`;
  return `${value.toLocaleString('en-US')} bytes`;
};

/** The human catalog, rendered from the module. There is no committed copy of
 *  this: a second copy is the thing being prevented. */
function report(): string {
  const out: string[] = [
    '# Cloudflare platform catalog',
    '',
    '> Edited & maintained by Claude. Presented as-is.',
    '',
    '**Generated** by `bun scripts/platform-catalog.ts --report` from '
    + `\`${CATALOG_MODULE}\`. Do not commit this file — the module is the source of truth `
    + 'and a committed copy would drift from it, which is the exact failure this catalog '
    + 'replaces.',
    '',
    `${String(PLATFORM_FACT_IDS.length)} entries. `
    + `${String(injectableFaults().length)} carry first-hand evidence and may be injected as real faults.`,
    '',
  ];
  const audited = auditSchema(platformFactEntries());
  if (audited.gaps.length > 0) {
    out.push(
      '## Declared gaps',
      '',
      'What these entries do not know. Recorded rather than guessed — a plausible '
      + 'number in place of a missing one is how a catalog becomes folklore.',
      '',
    );
    for (const gap of audited.gaps) out.push(`- \`${gap.id}\` — missing ${gap.missing}`);
    out.push('');
  }
  const cited = auditSources(readSources()).citedIds;
  const uncited = PLATFORM_FACT_IDS.filter((id) => !cited.includes(id));
  if (uncited.length > 0) {
    out.push(
      '## Not yet reached by production code',
      '',
      'Not necessarily debt: most are behaviours with no number to import, and the code '
      + 'that obeys them cites them in prose. Worth scanning for the ones that SHOULD have '
      + 'a call site and do not.',
      '',
    );
    for (const id of uncited) out.push(`- \`${id}\``);
    out.push('');
  }
  for (const id of PLATFORM_FACT_IDS) {
    const fact = platformFact(id);
    out.push(`## \`${id}\``, '');
    out.push(`${fact.subject}.`, '');
    out.push(`| | |`, `|---|---|`);
    out.push(`| Limit | ${fact.limit === null ? '— (behaviour, not a bound)' : human(fact.limit.value, fact.limit.unit)} |`);
    out.push(`| Origin | ${fact.origin} |`);
    out.push(`| Bounds | ${fact.bounds ?? '— (behaviour)'} |`);
    out.push(`| Evidence | **${fact.evidence}** |`);
    out.push(`| Provenance | ${fact.provenance} |`);
    out.push(`| Established | ${fact.date} |`);
    out.push(`| Trigger | ${fact.trigger} |`);
    out.push(`| On breach | ${fact.onBreach} |`);
    out.push(`| First-party signal | ${fact.firstPartySignal ? 'yes' : 'NO — models as silent disappearance'} |`);
    out.push('');
    if (fact.observable.length > 0) {
      out.push('Verbatim:', '');
      for (const seen of fact.observable) out.push(`- *${seen.context}* — \`${seen.message}\``);
      out.push('');
    }
    if (fact.measurements !== undefined) {
      out.push('Measured:', '');
      for (const m of fact.measurements) out.push(`- ${m.scenario}: **${human(m.value, m.unit)}**`);
      out.push('');
    }
    if (fact.contributors !== undefined) {
      out.push('Accounted contributors:', '');
      for (const c of fact.contributors) out.push(`- ${c}`);
      out.push('');
    }
    if (fact.conflictsWith !== undefined) {
      out.push(`Sources disagree with: ${fact.conflictsWith.map((c) => `\`${c}\``).join(', ')}`, '');
    }
    if (fact.knownBreachPath !== undefined) {
      out.push(`**Known live breach path:** ${fact.knownBreachPath}`, '');
    }
    if (fact.notes !== undefined) out.push(fact.notes, '');
  }
  return out.join('\n');
}

// ── Entry point ──────────────────────────────────────────────────────────

if (import.meta.main) {
  if (process.argv.includes('--report')) {
    console.log(report());
    process.exit(0);
  }

  const schema = auditSchema(platformFactEntries());
  const sources = readSources();
  const source = auditSources(sources);
  const unsourced = source.mentions.filter((m) => m.citedId === null);
  const sourced = source.mentions.length - unsourced.length;

  // The denominator, on the SUCCESS line and not only on failure. Each count is
  // a way for this gate to pass over nothing, and every one of them has happened
  // to a gate in this repo. `assertMeasured` throws on any zero.
  //
  // `platform sentences already cited` is the positive control: a matcher that
  // silently stops matching is indistinguishable from a clean tree, so a clean
  // result is only meaningful while the regex is proven to still fire.
  let measured: string;
  try {
    measured = assertMeasured('platform-catalog', [
      ['catalog entries', schema.inspected],
      ['documented entries', schema.byEvidence.get('documented') ?? 0],
      ['first-hand entries', injectableFaults().length],
      ['source files scanned', source.filesInspected],
      ['production files importing the catalog', source.importers.length],
      ['entries cited by production code', source.citedIds.length],
      ['platform sentences already cited', sourced],
    ]);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  if (schema.problems.length === 0 && unsourced.length === 0) {
    const labels = [...schema.byEvidence]
      .sort((a, b) => b[1] - a[1])
      .map(([label, n]) => `${String(n)} ${label}`)
      .join(', ');
    // Counts on the success line; the LISTS live in `--report`.
    //
    // They used to print here and that was the wrong shape: a warning nobody has
    // to clear teaches the reader to skip the output, and this gate's whole value
    // is that its output is read. Nor are they debt to ratchet — an uncited entry
    // is usually a behavioural fact with no numeric call site (nothing imports a
    // number from `isolate.codegen_blocked`; the code that obeys it cites it in
    // prose), and ratcheting the count would block the NEXT entry somebody adds,
    // which is precisely backwards for a catalog that should be cheap to extend.
    // A declared gap is likewise an entry being honest about not knowing
    // something, which is a state to record, not a violation to clear.
    console.log(
      `platform-catalog: ok — ${measured}`
      + `\n  by evidence: ${labels}`
      + `\n  ${String(schema.gaps.length)} declared gap(s), `
      + `${String(PLATFORM_FACT_IDS.length - source.citedIds.length)} entry(ies) not yet cited by `
      + `production code — \`bun scripts/platform-catalog.ts --report\` lists both`,
    );
    process.exit(0);
  }

  if (schema.problems.length > 0) {
    console.error(`platform-catalog: ${String(schema.problems.length)} entry problem(s)\n`);
    for (const p of schema.problems) {
      console.error(finding({
        invariant: 'every catalog entry carries an evidence label, a followable provenance, '
          + 'an ISO date, a trigger and a breach behaviour',
        at: `${CATALOG_MODULE} entry \`${p.id}\``,
        found: p.reason,
        silently: 'a platform number that reads as authoritative and cannot be re-derived — '
          + 'Nimbus shipped `per a gitignored internal research note (§6, invariant I1)` from a '
          + 'production constant, that document never existed, and the number it defended was wrong',
        fix: 'supply the missing field, or relabel the entry to the evidence you actually have '
          + '(`inferred` and `speculative` are legitimate answers; a blank field is not)',
      }));
    }
  }
  if (unsourced.length > 0) {
    console.error(`\nplatform-catalog: ${String(unsourced.length)} uncited platform sentence(s)\n`);
    for (const m of unsourced) {
      console.error(finding({
        invariant: 'a sentence stating a platform number names the catalog entry it comes from',
        at: `${m.file}:${String(m.line)}`,
        found: `"${m.quantity}" asserted near "${m.vocabulary}" with no entry named`,
        silently: 'a second copy of a platform fact that drifts from the catalog and from the '
          + 'runtime, with nothing to detect the drift — this repo already had one, a live 25 s '
          + 'WebSocket heartbeat citing a deleted `STABILITY-AUDIT §A4`',
        fix: `name the entry in the sentence — \`do.sqlite.row_bytes\`, \`worker.isolate.memory\` `
          + `— and derive the value from ${CATALOG_MODULE} rather than retyping it`,
      }));
    }
  }
  process.exit(1);
}
