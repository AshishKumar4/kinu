/**
 * Backend conformance comparator. Backends observe their real composition
 * roots and hand the sets here; core only judges.
 */

import type { JSONSchema7 } from 'ai';
import * as v from 'valibot';
import { isBuiltinToolName } from '../tools/registry';
import {
  BACKEND_CONFORMANCE,
  CONFORMANCE_PLANES,
  type CapabilityStatus,
  type ConformanceManifest,
  type ConformancePlane,
  type ConformanceRoot,
  type ObservedSurface,
  type RootStatuses,
} from './manifest';

export type ConformanceFindingKind =
  | 'missing'
  | 'undeclared'
  /** Observed, but declared absent: the recorded reason is stale. */
  | 'contradicted';

export interface ConformanceFinding {
  readonly kind: ConformanceFindingKind;
  readonly plane: ConformancePlane;
  readonly root: ConformanceRoot;
  readonly name: string;
  readonly staleReason?: string;
}

export interface ConformanceReport {
  readonly root: ConformanceRoot;
  readonly findings: readonly ConformanceFinding[];
  /** Declared but not measured; never counted as conformant. */
  readonly unmeasured: readonly ConformancePlane[];
}

function declaredEntries(
  plane: ConformancePlane,
  manifest: ConformanceManifest,
): Array<[string, RootStatuses]> {
  switch (plane) {
    case 'tool': return Object.entries(manifest.tool);
    case 'agents-action': return Object.entries(manifest['agents-action']);
    case 'memory-action': return Object.entries(manifest['memory-action']);
    case 'table': return Object.entries(manifest.table);
    case 'producer': return Object.entries(manifest.producer);
  }
}

export function compareSurface(
  observed: ObservedSurface,
  manifest: ConformanceManifest = BACKEND_CONFORMANCE,
): ConformanceReport {
  const findings: ConformanceFinding[] = [];
  const unmeasured: ConformancePlane[] = [];

  for (const plane of CONFORMANCE_PLANES) {
    const seen = observed.planes[plane];

    if (!seen) {
      unmeasured.push(plane);
      continue;
    }

    const declared = declaredEntries(plane, manifest);

    for (const [name, statuses] of declared) {
      const status: CapabilityStatus | undefined = statuses[observed.root];

      if (status === undefined) {
        findings.push({ kind: 'undeclared', plane, root: observed.root, name });
      } else if ('wired' in status && !seen.has(name)) {
        findings.push({ kind: 'missing', plane, root: observed.root, name });
      }
    }

    for (const name of [...seen].sort()) {
      const statuses = declared.find(([declaredName]) => declaredName === name)?.[1];
      const status: CapabilityStatus | undefined = statuses?.[observed.root];

      if (status === undefined) {
        findings.push({ kind: 'undeclared', plane, root: observed.root, name });
      } else if ('absent' in status) {
        findings.push({ kind: 'contradicted', plane, root: observed.root, name, staleReason: status.absent });
      }
    }
  }

  return { root: observed.root, findings, unmeasured };
}

const FINDING_ADVICE = {
  missing: 'wire it at this root, or declare it { absent: reason } in conformance/manifest.ts',
  undeclared: 'declare it in conformance/manifest.ts — the Record type will force a decision for every root',
  contradicted: 'the wiring and the manifest disagree; whichever is right, make the other match',
} satisfies Record<ConformanceFindingKind, string>;

export function renderConformanceFindings(report: ConformanceReport): string {
  return report.findings
    .map((f) => {
      const stale = f.staleReason ? ` (recorded reason now stale: "${f.staleReason}")` : '';

      return `[${f.root}] ${f.plane} "${f.name}" ${f.kind}${stale} — ${FINDING_ADVICE[f.kind]}`;
    })
    .join('\n');
}

/** Drops SQLite bookkeeping and FTS5 shadow tables of declared virtual tables. */
export function normalizeObservedTables(names: Iterable<string>): Set<string> {
  const all = new Set(names);
  const out = new Set<string>();

  for (const name of all) {
    if (name === 'sqlite_sequence' || name.startsWith('sqlite_')) continue;

    if (/_(data|idx|content|docsize|config)$/.test(name) && all.has(name.replace(/_(data|idx|content|docsize|config)$/, ''))) {
      continue;
    }

    out.add(name);
  }

  return out;
}

const ActionEnumSchema = v.object({
  properties: v.object({
    action: v.object({ enum: v.array(v.string()) }),
  }),
});

/** The `action` enum in the JSON Schema a provider is sent. */
export function observedActionEnum(sent: JSONSchema7 | undefined): Set<string> {
  const parsedAction = v.safeParse(ActionEnumSchema, sent);

  return new Set(parsedAction.success ? parsedAction.output.properties.action.enum : []);
}

/** Presence (`!== undefined`) is the contract; unset means the consumer's documented fallback. */
export function wiredProducers(rt: {
  judgeModel?: unknown; advisorLlm?: unknown;
}): Set<string> {
  const wired = new Set<string>();

  if (rt.judgeModel !== undefined) wired.add('judge');

  if (rt.advisorLlm !== undefined) wired.add('advisor');

  return wired;
}

/** Call-shaped names in LLM-facing text (`name(...)`) absent from the real callables. */
export function phantomCallables(text: string, callables: ReadonlySet<string>): string[] {
  const phantoms = new Set<string>();

  for (const m of text.matchAll(/\b([a-z][a-z0-9_]*(?:\.[a-z][a-zA-Z0-9_]*)*)\(/g)) {
    const name = m[1];

    if (name === undefined) continue;

    if (callables.has(name)) continue;

    // Past wired names, single words are prose unless they name a real builtin tool.
    if (!name.includes('.') && !name.includes('_') && !isBuiltinToolName(name)) continue;
    // A namespaced call resolves under a wired `root.*` namespace.
    const root = name.split('.', 1)[0];

    if (root !== undefined && name.includes('.') && callables.has(`${root}.*`)) continue;
    phantoms.add(name);
  }

  return [...phantoms].sort();
}
