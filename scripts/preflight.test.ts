/**
 * The preflight's checkpoint-workdir rule, and the sync its own header claims.
 *
 * The rule changed shape once the engine bounded its walk. Before that, a
 * project marker above the temp directory WAS the defect: `workdirForPath`
 * walked to it and every host write beneath resolved its checkpoint working
 * directory there, measured at 24,483 ms for one `laptop.writeFile`. With the
 * bound in place the same marker claims nothing, so refusing a push for it is
 * a false blocker — and a gate that fires on a fixed pathology is the gate
 * somebody switches off. What must stay red is the case that still bites:
 * the bound removed while a marker sits there.
 */

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PROJECT_MARKERS, engineBoundsTempWalk, judge, type Environment } from './preflight';

const REPO_ROOT = new URL('..', import.meta.url).pathname;
const ENGINE = 'packages/cli-backend/src/checkpoints.ts';
const engineSource = readFileSync(join(REPO_ROOT, ENGINE), 'utf8');

/** A healthy machine, so each case below moves exactly one fact. */
const HEALTHY: Environment = {
  temp: '/tmp',
  freeInodes: 900_000,
  freeBytes: 40 * 1024 ** 3,
  writeProbe: { ok: true },
  markedAncestors: [],
  workdirWalkBounded: true,
  scratchOrphans: 3,
  tempEntries: 151,
  mergeInProgress: null,
  conflictedPaths: 0,
};

describe('the markers this gate probes', () => {
  test('are exactly the markers the engine treats as a project root', () => {
    // The header claims this sync, and a hardcoded copy that drifted would make
    // the check pass over the very directory it is guarding.
    const declared = /const PROJECT_MARKERS = \[(?<list>[^\]]+)\]/u.exec(engineSource)?.groups?.list;
    expect(declared).toBeDefined();
    const names = [...(declared ?? '').matchAll(/'(?<name>[^']+)'/gu)].map((m) => m.groups?.name);
    expect(names).toEqual([...PROJECT_MARKERS]);
  });
});

describe('the engine bound this gate reads', () => {
  test('is present in the shipped engine', () => {
    expect(engineBoundsTempWalk(engineSource)).toBe(true);
  });

  test('reads as ABSENT once the temp break is removed', () => {
    // The red direction, cut at the one line that does the bounding. Without
    // this case the probe could return true for any source and nothing would
    // say so.
    const unbounded = engineSource.replace(
      'if (probe === temp || real === realTemp) break;',
      '',
    );
    expect(unbounded).not.toBe(engineSource);
    expect(engineBoundsTempWalk(unbounded)).toBe(false);
  });
});

describe('a project marker above the temp directory', () => {
  test('is tolerated while the engine bounds its walk', () => {
    expect(judge({ ...HEALTHY, markedAncestors: ['/tmp'] })).toEqual([]);
  });

  test('is a finding the moment the bound is gone, naming the engine and the cost', () => {
    const [problem] = judge({
      ...HEALTHY, markedAncestors: ['/tmp'], workdirWalkBounded: false,
    });
    expect(problem).toContain('/tmp');
    expect(problem).toContain(ENGINE);
    expect(problem).toContain('24,483 ms');
  });

  test('is not invented when no ancestor carries one', () => {
    // The denominator: an unbounded engine on a clean machine is not this
    // gate's finding, because nothing resolves anywhere unexpected.
    expect(judge({ ...HEALTHY, workdirWalkBounded: false })).toEqual([]);
  });
});

describe('a temp directory this user cannot write to', () => {
  test('is a finding that names the errno and the free space statfs still reports', () => {
    // The red direction for the 2026-09-05 incident: statfs showed gigabytes
    // free while every write under the tmpfs returned EDQUOT. Space that is
    // reported free and refused is the one condition `freeBytes` cannot see.
    const problems = judge({ ...HEALTHY, writeProbe: { ok: false, code: 'EDQUOT' } });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('EDQUOT');
    expect(problems[0]).toContain(`${String((40 * 1024 ** 3) >> 20)} MiB free`);
  });
});
