/**
 * The platform catalog gate — the catalog stays evidenced.
 *
 * `packages/core/src/platform-catalog.ts` replaces a document that vanished
 * while its citation survived in shipped code: Nimbus's `constants.ts` justifies
 * a 128 MiB production ceiling with "per a gitignored internal research note
 * §6 invariant I1", and that file has never existed on disk or in git history.
 * A catalog that can rot the same way is not an improvement, so every entry
 * carries an evidence label, a provenance, a date, a trigger and a breach
 * behaviour — and a `documented` entry's provenance is a URL while everything
 * else names a file and line. An unlabelled number is the exact defect being
 * replaced.
 */

import {
  BOUNDS_KINDS,
  PLATFORM_FACT_IDS,
  injectableFaults,
  platformFact,
  platformFactEntries,
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
 * note cited from a Nimbus production constant, and the removed stability audit
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
// contains a repo-local path, and claiming that as ours would
// make every Nimbus citation red. Only a path at a real token boundary counts.
export const REPO_PATH =
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
      // how the removed stability audit was recovered and read. A deleted file
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
      fail(`bounds "${fact.bounds}" is not one of the ${BOUNDS_KINDS.length} kinds`);
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

const CATALOG_MODULE = 'packages/core/src/platform-catalog.ts';

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

  const sources = [...readSources().values()];
  const uncited = PLATFORM_FACT_IDS.filter((id) => !sources.some((text) => text.includes(id)));

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
  let measured: string;

  try {
    measured = assertMeasured('platform-catalog', [
      ['catalog entries', schema.inspected],
      ['documented entries', schema.byEvidence.get('documented') ?? 0],
      ['first-hand entries', injectableFaults().length],
    ]);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }

  if (schema.problems.length === 0) {
    const labels = [...schema.byEvidence]
      .sort((a, b) => b[1] - a[1])
      .map(([label, n]) => `${String(n)} ${label}`)
      .join(', ');

    console.log(
      `platform-catalog: ok — ${measured}`
      + `\n  by evidence: ${labels}`
      + `\n  ${String(schema.gaps.length)} declared gap(s) — \`bun scripts/platform-catalog.ts --report\` lists them`,
    );
    process.exit(0);
  }

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

  process.exit(1);
}
