// Layer gate — the deterministic, no-LLM regression gate over the turn
// pipeline, plus the proof that its per-layer resolution is real:
//
//   1. the decomposition is dependency-closed (walked over the real imports),
//   2. an injected single-layer fault craters its own slice and nothing else,
//   3. an uncovered layer reports null, never 100%.
//
// (1) is what makes (2) trustworthy: a registry-level fault only intercepts
// what the gate calls, so if one layer's production code reached another
// layer's subject, the matrix would report isolation the pipeline does not
// have. The import walk rules that out.
import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import {
  createPipelineSubjects, FAULTS, LAYERS, LOCKED_BASELINE, SUBJECT_SOURCE,
  LOCALIZATION_OTHER_MAX_PP, LOCALIZATION_OWN_MIN_PP,
  observePipeline, runFaultMatrix, runLayerGate,
  type SubjectName,
} from '../src/layergate/index';
import { createTestRuntime } from './helpers';

const SRC = resolve(import.meta.dir, '../src');
// The gate reads no storage: every prompt probe passes soulOverride, so the
// runtime handle only satisfies buildSystemPromptSync's signature.
const subjects = createPipelineSubjects(createTestRuntime().rt);

const measuredLayers = LAYERS.filter((layer) => layer.probes.length > 0);
const allProbes = LAYERS.flatMap((layer) => layer.probes);

const layerOf = new Map<SubjectName, string>();
for (const layer of LAYERS) {
  for (const subject of layer.subjects) layerOf.set(subject, layer.id);
}

function isSubjectName(value: string): value is SubjectName {
  return Object.hasOwn(SUBJECT_SOURCE, value);
}

// ── import-graph analysis ────────────────────────────────────────

const IMPORT = /import\s+(type\s+)?([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g;

interface Import { readonly spec: string; readonly values: readonly string[] }

const parsed = new Map<string, Import[]>();
function importsOf(file: string): Import[] {
  const cached = parsed.get(file);
  if (cached) return cached;
  const out: Import[] = [];
  if (existsSync(file)) {
    for (const match of readFileSync(file, 'utf8').matchAll(IMPORT)) {
      const clause = match[2] ?? '';
      const named = clause.match(/\{([\s\S]*)\}/);
      const values = match[1] || !named
        ? []
        : named[1]!.split(',')
            .map((part) => part.trim())
            .filter((part) => part.length > 0 && !part.startsWith('type '))
            .map((part) => part.split(/\s+as\s+/)[0]!.trim());
      out.push({ spec: match[3]!, values });
    }
  }
  parsed.set(file, out);
  return out;
}

function resolveImport(from: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  // One spelling: a relative specifier under Bun names the module without an
  // extension, so the module is `<spec>.ts` or the directory's barrel. This used
  // to rewrite a trailing `.js` and returned null for every extensionless
  // specifier, which walks no edges and finds no subject reachable at all.
  const base = resolve(dirname(from), spec);
  return [`${base}.ts`, `${base}/index.ts`].find((path) => existsSync(path)) ?? null;
}

/** Every subject symbol imported anywhere in `entry`'s transitive closure. */
function reachableSubjects(entry: string): Map<SubjectName, string> {
  const seen = new Set<string>();
  const found = new Map<SubjectName, string>();
  const stack = [entry];
  while (stack.length > 0) {
    const file = stack.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const imported of importsOf(file)) {
      for (const value of imported.values) {
        if (isSubjectName(value) && layerOf.has(value) && !found.has(value)) {
          found.set(value, file.slice(SRC.length + 1));
        }
      }
      const target = resolveImport(file, imported.spec);
      if (target) stack.push(target);
    }
  }
  return found;
}

// ── the decomposition itself ─────────────────────────────────────

describe('layer gate — decomposition', () => {
  test('every subject is owned by exactly one layer', () => {
    const registry = Object.keys(SUBJECT_SOURCE).filter(isSubjectName);
    const owned = LAYERS.flatMap((layer) => layer.subjects);
    expect([...owned].sort()).toEqual([...registry].sort());
    expect(new Set(owned).size).toBe(owned.length);
  });

  test('SUBJECT_SOURCE names the file that really exports each subject', async () => {
    for (const [subject, relative] of Object.entries(SUBJECT_SOURCE)) {
      const file = resolve(SRC, relative);
      expect(existsSync(file)).toBe(true);
      // This checks the module graph. A moved subject fails here because the
      // file no longer carries it. Dynamic import is the only form that works.
      // The files are data in the map under test, and a static import per
      // subject would restate that map by hand.
      expect(Object.hasOwn(await import(file), subject)).toBe(true);
    }
  });

  test('subjects sharing a module share a layer', () => {
    // A call between two functions in one file is invisible to a registry
    // swap, so splitting a module across layers would report isolation the
    // code does not have.
    const byModule = new Map<string, Set<string>>();
    for (const [subject, module] of Object.entries(SUBJECT_SOURCE)) {
      if (!isSubjectName(subject)) throw new Error(`unknown layer-gate subject: ${subject}`);
      const layer = layerOf.get(subject);
      if (layer === undefined) throw new Error(`unowned layer-gate subject: ${subject}`);
      byModule.set(module, (byModule.get(module) ?? new Set()).add(layer));
    }
    const split = [...byModule]
      .filter(([, layers]) => layers.size > 1)
      .map(([module, layers]) => `${module} is split across ${[...layers].join(', ')}`);
    expect(split).toEqual([]);
  });

  test('the import walk actually resolves — the closure proof is not vacuous', () => {
    // prompt.ts genuinely calls compilePromptSurface; if the walk found
    // nothing, the cross-layer check above would pass for free.
    const reached = reachableSubjects(resolve(SRC, SUBJECT_SOURCE.buildSystemPromptSync));
    expect(reached.has('compilePromptSurface')).toBe(true);
    expect(reached.has('renderAgentsMdSection')).toBe(true);
    // …and it crosses module boundaries, not just direct imports.
    expect(reachableSubjects(resolve(SRC, SUBJECT_SOURCE.selectEvolutionBase)).has('checkMisevolution')).toBe(true);
  });

  test('no layer\'s production code reaches another layer\'s subject', () => {
    const violations: string[] = [];
    for (const [subject, relative] of Object.entries(SUBJECT_SOURCE)) {
      if (!isSubjectName(subject)) throw new Error(`unknown layer-gate subject: ${subject}`);
      const owner = layerOf.get(subject);
      if (owner === undefined) throw new Error(`unowned layer-gate subject: ${subject}`);
      for (const [reached, where] of reachableSubjects(resolve(SRC, relative))) {
        const reachedOwner = layerOf.get(reached)!;
        if (reachedOwner !== owner) {
          violations.push(`${owner}/${subject} (${relative}) reaches ${reachedOwner}/${reached} via ${where}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test('probe ids are unique and namespaced by their layer', () => {
    const ids = allProbes.map((probe) => probe.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const layer of LAYERS) {
      for (const probe of layer.probes) expect(probe.id.startsWith(`${layer.id}/`)).toBe(true);
    }
    expect(new Set(LAYERS.map((layer) => layer.id)).size).toBe(LAYERS.length);
  });
});

// ── coverage honesty ─────────────────────────────────────────────

describe('layer gate — coverage honesty', () => {
  test('observation digests use JSON wire semantics without collapsing root undefined', async () => {
    const jsonProjection = await observePipeline({}, [{
      id: 'projection', owns: 'test projection', subjects: [],
      probes: [{
        id: 'projection/value', asserts: 'JSON projection is deterministic',
        observe: () => ({ capabilities: new Set(['tools']), omitted: undefined }),
      }],
    }]);
    const canonical = await observePipeline({}, [{
      id: 'projection', owns: 'test projection', subjects: [],
      probes: [{
        id: 'projection/value', asserts: 'JSON projection is deterministic',
        observe: () => ({ capabilities: {} }),
      }],
    }]);
    const undefinedRoot = await observePipeline({}, [{
      id: 'projection', owns: 'test projection', subjects: [],
      probes: [{
        id: 'projection/value', asserts: 'root undefined stays distinct',
        observe: () => undefined,
      }],
    }]);
    const undefinedString = await observePipeline({}, [{
      id: 'projection', owns: 'test projection', subjects: [],
      probes: [{
        id: 'projection/value', asserts: 'the string is ordinary JSON',
        observe: () => 'undefined',
      }],
    }]);

    expect(jsonProjection).toEqual(canonical);
    expect(undefinedRoot).not.toEqual(undefinedString);
  });

  test('a non-serializable observation is quarantined, not a crashed run', async () => {
    const circular = { self: {} };
    circular.self = circular;
    const quarantine = [{
      id: 'quarantine', owns: 'test quarantine', subjects: [],
      probes: [
        { id: 'quarantine/circular', asserts: 'circular observation is quarantined', observe: () => circular },
        { id: 'quarantine/bigint', asserts: 'bigint observation is quarantined', observe: () => ({ value: 1n }) },
      ],
    }];
    const observations = await observePipeline({}, quarantine);
    expect(observations.size).toBe(2);
    const report = await runLayerGate({ subjects: {}, baseline: {}, layers: quarantine });
    expect(report.layers.map((score) => score.conformance)).toEqual([0]);
  });

  test('an unmeasured layer reports null, never 100%', async () => {
    const report = await runLayerGate({ subjects, baseline: LOCKED_BASELINE });
    const unmeasured = report.layers.filter((score) => score.probes === 0);
    expect(unmeasured.length).toBeGreaterThan(0);
    for (const score of unmeasured) {
      expect(score.conformance).toBeNull();
      expect(score.matched).toBe(0);
    }
    expect(report.unmeasured).toEqual(unmeasured.map((score) => score.layer));
  });

  test('every unmeasured layer says why, and owns no subject it silently skips', () => {
    for (const layer of LAYERS) {
      if (layer.probes.length > 0) continue;
      expect(layer.unmeasuredBecause?.length ?? 0).toBeGreaterThan(20);
      expect(layer.subjects).toEqual([]);
    }
  });

  test('the aggregate averages measured layers only', async () => {
    const report = await runLayerGate({ subjects, baseline: LOCKED_BASELINE });
    const measured = report.layers.filter((score) => score.conformance !== null);
    expect(report.measured.length).toBe(measured.length);
    expect(report.aggregate).toBeCloseTo(
      measured.reduce((acc, score) => acc + (score.conformance ?? 0), 0) / measured.length,
      12,
    );
  });

  test('the lock covers exactly the probe set — no stale keys, no unlocked probes', () => {
    expect(Object.keys(LOCKED_BASELINE).sort()).toEqual(allProbes.map((probe) => probe.id).sort());
  });
});

// ── the gate ─────────────────────────────────────────────────────

describe('layer gate — baseline', () => {
  test('the pipeline conforms to the locked baseline', async () => {
    const report = await runLayerGate({ subjects, baseline: LOCKED_BASELINE });
    const moved = report.layers
      .filter((score) => score.drifted.length > 0 || score.unlocked.length > 0)
      .map((score) => ({ layer: score.layer, drifted: score.drifted, unlocked: score.unlocked }));
    expect(moved).toEqual([]);
    expect(report.aggregate).toBe(1);
  });

  test('observation is deterministic — no clock, no RNG, no I/O', async () => {
    const first = await observePipeline(subjects);
    const second = await observePipeline(createPipelineSubjects(createTestRuntime().rt));
    expect([...second]).toEqual([...first]);
  });
});

// ── the validation of the gate ───────────────────────────────────

describe('layer gate — fault localization', () => {
  test('every measured layer has a fault, and every fault stays inside its layer', () => {
    expect(FAULTS.map((fault) => fault.layer).sort())
      .toEqual(measuredLayers.map((layer) => layer.id).sort());
    for (const fault of FAULTS) {
      const owner = LAYERS.find((layer) => layer.id === fault.layer);
      if (!owner) throw new Error(`fault has no layer: ${fault.layer}`);
      const owned = owner.subjects;
      expect(fault.patches.every((subject) => owned.includes(subject))).toBe(true);
      expect(fault.patches.length).toBeGreaterThan(0);
    }
  });

  test('a fault replaces exactly the subjects it declares', () => {
    for (const fault of FAULTS) {
      const faulted = fault.inject(subjects);
      const changed = Object.keys(SUBJECT_SOURCE).filter(isSubjectName)
        .filter((subject) => faulted[subject] !== subjects[subject]);
      expect(changed.sort()).toEqual([...fault.patches].sort());
    }
  });

  test(`an injected single-layer fault moves its own slice ≥${LOCALIZATION_OWN_MIN_PP}pp and every other <${LOCALIZATION_OTHER_MAX_PP}pp`, async () => {
    const impacts = await runFaultMatrix(subjects);
    expect(impacts).toHaveLength(FAULTS.length);
    const leaked = impacts
      .filter((impact) => !impact.localized)
      .map((impact) => ({ fault: impact.fault, own: impact.ownDropPp, other: impact.maxOtherDropPp }));
    expect(leaked).toEqual([]);
    for (const impact of impacts) {
      expect(impact.ownDropPp).toBeGreaterThanOrEqual(LOCALIZATION_OWN_MIN_PP);
      expect(impact.maxOtherDropPp).toBe(0);
    }
  });

  test('unmeasured layers never register a fault impact — null, not "unaffected"', async () => {
    const impacts = await runFaultMatrix(subjects);
    const unmeasured = LAYERS.filter((layer) => layer.probes.length === 0).map((layer) => layer.id);
    for (const impact of impacts) {
      for (const layer of unmeasured) expect(impact.dropPp[layer]).toBeNull();
    }
  });
});
