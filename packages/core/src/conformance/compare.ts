/**
 * Backend conformance comparator — reality vs the manifest, both directions.
 *
 * The comparator never observes anything itself: each backend package owns a
 * harness that runs its REAL composition root (the actual `buildBuiltinTools`
 * call site, the actual schema path) and hands the observed sets here. Keeping
 * observation in the backend and judgment in core is what stops the gate from
 * growing a parallel re-implementation of the wiring it checks.
 */

import * as v from 'valibot';
import { JsonObjectSchema, type JsonObject } from '../utils/json.js';
import {
  BACKEND_CONFORMANCE,
  CONFORMANCE_PLANES,
  type CapabilityStatus,
  type ConformanceManifest,
  type ConformancePlane,
  type ConformanceRoot,
  type ObservedSurface,
  type RootStatuses,
} from './manifest.js';

export type ConformanceFindingKind =
  /** Declared wired on this root, but the real composition output lacks it. */
  | 'missing'
  /** Observed on this root, but the manifest has no entry for it at all. */
  | 'undeclared'
  /** Observed on this root, but declared deliberately absent — the manifest
   *  (or the wiring) is wrong, and the recorded reason is stale. */
  | 'contradicted';

export interface ConformanceFinding {
  readonly kind: ConformanceFindingKind;
  readonly plane: ConformancePlane;
  readonly root: ConformanceRoot;
  readonly name: string;
  /** For `contradicted`: the now-stale reason the manifest recorded. */
  readonly staleReason?: string;
}

export interface ConformanceReport {
  readonly root: ConformanceRoot;
  readonly findings: readonly ConformanceFinding[];
  /** Planes the manifest declares but this harness did not measure. Loud by
   *  design: an unmeasured plane is never conformant, it is unmeasured. */
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
      const status = statuses[observed.root];
      if ('wired' in status && !seen.has(name)) {
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

// ── Observation helpers shared by the per-backend harnesses ─────────────────

/** SQLite bookkeeping and FTS5 shadow tables are implementation artifacts of
 *  a declared virtual table, not capabilities; observing them would make every
 *  FTS index five spurious manifest rows. */
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

/** The action enum of a builtin tool's input schema — the artifact the model
 *  actually sees, from the ToolSet the composition root actually built. */
const ToolSchema = v.object({ inputSchema: v.optional(v.unknown()) });
const ActionEnumSchema = v.object({
  properties: v.object({
    action: v.object({ enum: v.array(v.string()) }),
  }),
});

export function observedActionEnum<Tool>(tool: Tool): Set<string> {
  const parsedTool = v.safeParse(ToolSchema, tool);
  if (!parsedTool.success) return new Set();
  const raw = schemaJson(parsedTool.output.inputSchema);
  const parsedAction = v.safeParse(ActionEnumSchema, raw);
  return new Set(parsedAction.success ? parsedAction.output.properties.action.enum : []);
}

/** Unwrap an AI-SDK schema wrapper (jsonSchema(...) carries the raw object on
 *  jsonSchema; a plain object schema is already raw). */
function schemaJson<Schema>(schema: Schema): JsonObject | null {
  const wrapped = v.safeParse(v.object({ jsonSchema: JsonObjectSchema }), schema);
  if (wrapped.success) return wrapped.output.jsonSchema;
  const direct = v.safeParse(JsonObjectSchema, schema);
  return direct.success ? direct.output : null;
}

// ── Phantom callables ────────────────────────────────────────────────────────

/**
 * Call-shaped names in LLM-facing text that resolve to nothing.
 *
 * The defect this locks: an event brief told the model to "use
 * read_external_payload(event_id)" — a function that has never existed in any
 * namespace, on any backend. Text that names a callable is an API contract
 * with the model; this extracts every `name(...)`-shaped instruction and
 * reports the ones absent from the caller's set of real callables.
 */
export function phantomCallables(text: string, callables: ReadonlySet<string>): string[] {
  const phantoms = new Set<string>();
  for (const m of text.matchAll(/\b([a-z][a-z0-9_]*(?:\.[a-z][a-zA-Z0-9_]*)*)\(/g)) {
    const name = m[1];
    if (!name) continue;
    // Single short words before `(` are overwhelmingly prose ("run(", "do(");
    // an instruction names either a namespaced call or a snake_case function.
    if (!name.includes('.') && !name.includes('_')) continue;
    if (callables.has(name)) continue;
    // A namespaced call resolves if its namespace root is a real callable
    // surface (`workspace.readdir(...)` under a wired `workspace` namespace).
    const root = name.split('.', 1)[0];
    if (root && name.includes('.') && callables.has(`${root}.*`)) continue;
    phantoms.add(name);
  }
  return [...phantoms].sort();
}
