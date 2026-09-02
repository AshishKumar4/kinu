#!/usr/bin/env bun
/**
 * `bun run coverage:check` — read the merged lcov and print per-package
 * numbers as machine-readable JSON, for a later ratchet gate.
 *
 * Deliberately no threshold: Main sets the floor after the review, and a
 * threshold nobody measured is the exact defect AGENTS.md documents for gates
 * generally. What this DOES enforce is the same liveness rule every gate here
 * carries: a merged lcov that is empty or missing is a hard failure, never a
 * zero that reads like a number.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseLcov, type LcovRecord } from './coverage-lcov';

const ROOT = new URL('..', import.meta.url).pathname;
const LCOV = join(ROOT, 'coverage', 'lcov.info');

interface PkgTally {
  linesHit: number; linesFound: number;
  functionsHit: number; functionsFound: number;
  branchesHit: number; branchesFound: number;
  files: number;
}

function packageOf(file: string): string {
  if (file.startsWith('packages/')) return file.split('/')[1] ?? 'packages';
  if (file.startsWith('scripts/')) return 'scripts';
  return 'tests';
}

function main(): number {
  if (!existsSync(LCOV)) {
    console.error('coverage:check: no coverage/lcov.info — run `bun run coverage` first');
    return 1;
  }
  const records: LcovRecord[] = parseLcov(readFileSync(LCOV, 'utf8'));
  if (records.length === 0) {
    console.error('coverage:check: merged lcov parsed to zero file records — a gate over nothing');
    return 1;
  }

  const tallies = new Map<string, PkgTally>();
  for (const record of records) {
    const pkg = packageOf(record.file);
    const t = tallies.get(pkg) ?? {
      linesHit: 0, linesFound: 0, functionsHit: 0, functionsFound: 0,
      branchesHit: 0, branchesFound: 0, files: 0,
    };
    t.linesHit += record.lines.hit; t.linesFound += record.lines.found;
    t.functionsHit += record.functions.hit; t.functionsFound += record.functions.found;
    t.branchesHit += record.branches.hit; t.branchesFound += record.branches.found;
    t.files += 1;
    tallies.set(pkg, t);
  }

  const pct = (hit: number, found: number): number | null =>
    found === 0 ? null : Number(((hit / found) * 100).toFixed(2));

  const packages = [...tallies.entries()]
    .map(([name, t]) => ({
      package: name,
      files: t.files,
      lines: { hit: t.linesHit, found: t.linesFound, pct: pct(t.linesHit, t.linesFound) },
      functions: { hit: t.functionsHit, found: t.functionsFound, pct: pct(t.functionsHit, t.functionsFound) },
      branches: { hit: t.branchesHit, found: t.branchesFound, pct: pct(t.branchesHit, t.branchesFound) },
    }))
    .sort((a, b) => a.package.localeCompare(b.package));

  const totals = packages.reduce((acc, p) => ({
    files: acc.files + p.files,
    linesHit: acc.linesHit + p.lines.hit, linesFound: acc.linesFound + p.lines.found,
    functionsHit: acc.functionsHit + p.functions.hit, functionsFound: acc.functionsFound + p.functions.found,
    branchesHit: acc.branchesHit + p.branches.hit, branchesFound: acc.branchesFound + p.branches.found,
  }), { files: 0, linesHit: 0, linesFound: 0, functionsHit: 0, functionsFound: 0, branchesHit: 0, branchesFound: 0 });

  console.log(JSON.stringify({
    generatedFrom: 'coverage/lcov.info',
    totalFiles: totals.files,
    total: {
      lines: { hit: totals.linesHit, found: totals.linesFound, pct: pct(totals.linesHit, totals.linesFound) },
      functions: { hit: totals.functionsHit, found: totals.functionsFound, pct: pct(totals.functionsHit, totals.functionsFound) },
      branches: { hit: totals.branchesHit, found: totals.branchesFound, pct: pct(totals.branchesHit, totals.branchesFound) },
    },
    packages,
  }, null, 2));
  return 0;
}

if (import.meta.main) process.exit(main());
