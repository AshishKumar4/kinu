// The enumerator's own gate, over throwaway repositories.
//
// The invariant under test is the one the 2026-08-18 leak paid for: TRACKED IS
// AUTHORITATIVE. A merge from a pre-scrub branch re-added a gitignored
// transcript as a tracked file whose index blob held two live tokens; there was
// no working-tree copy, the old enumeration dropped any listed path missing
// from disk, and `secret-scan` exited 0 while `git ls-files` showed the leak.
// Ignore rules and disk presence may narrow only UNTRACKED additions — a
// tracked path is in every corpus because tracked is what git ships.
//
// The credential fixture is concatenated, never literal: this file is tracked,
// so the scan it exercises reads it.
import { execFileSync } from 'node:child_process';
import { describe, expect, spyOn, test } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { git, initRepo, scratchDir } from '@proteus/test-utils';
import { enumerateRepository, isTextSource, readRepositoryFile } from './sources';
import { scanText } from './secret-scan';

const FAKE_TOKEN = ['pta', '0123456789abcdef0123456789abcdef'].join('_');
const TRANSCRIPT = 'docs/requirements/OWNER-MESSAGES-VERBATIM.md';

// No GIT_* scrubbing here, deliberately: the enumerator spawns git with
// `gitEnv()`'s rebuilt environment itself, so a hook-exported `GIT_DIR` —
// which outranks `-C` and which Bun keeps feeding to children even after a
// test deletes it from `process.env` — cannot re-point a fixture enumeration
// at the developer's real checkout. Pinned below by
// 'a poisoned GIT_DIR/GIT_WORK_TREE cannot redirect enumeration'. These
// suites run under `pre-push`, so that property is exercised on every push.

/** A repository holding the incident's exact shape: one clean tracked file, one
 *  ignore rule, and `TRANSCRIPT` carrying a fake credential. */
function incidentRepo(): string {
  const repo = scratchDir('sources-enumeration');
  initRepo(repo);
  mkdirSync(join(repo, 'docs/requirements'), { recursive: true });
  writeFileSync(join(repo, 'README.md'), 'clean\n');
  writeFileSync(join(repo, '.gitignore'), `/${TRANSCRIPT}\n`);
  writeFileSync(join(repo, TRANSCRIPT), `the owner pasted ${FAKE_TOKEN} here\n`);
  git(repo, 'add', 'README.md', '.gitignore');
  return repo;
}

describe('tracked-ness is authoritative', () => {
  test('a tracked file matching an ignore rule stays enumerated, and is named as the anomaly', () => {
    const repo = incidentRepo();
    git(repo, 'add', '-f', TRANSCRIPT);
    const warn = spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { files, trackedIgnored } = enumerateRepository(repo);
      expect(files).toContain(TRANSCRIPT);
      expect(trackedIgnored).toEqual([TRANSCRIPT]);
      expect(warn.mock.calls.flat().join('\n')).toContain(TRANSCRIPT);
    } finally {
      warn.mockRestore();
    }
  });

  test('the same file untracked is excluded by the ignore rule, and is no anomaly', () => {
    const repo = incidentRepo();
    const { files, trackedIgnored } = enumerateRepository(repo);
    expect(files).not.toContain(TRANSCRIPT);
    expect(trackedIgnored).toEqual([]);
    // An untracked file the ignore rules do NOT cover is in — new files are the
    // ones most likely to violate.
    writeFileSync(join(repo, 'notes.md'), 'new\n');
    expect(enumerateRepository(repo).files).toContain('notes.md');
  });

  test('a tracked file deleted from the working tree stays enumerated; its index blob is still readable', () => {
    const repo = incidentRepo();
    git(repo, 'add', '-f', TRANSCRIPT);
    rmSync(join(repo, TRANSCRIPT));
    const warn = spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(enumerateRepository(repo).files).toContain(TRANSCRIPT);
      expect(readRepositoryFile(repo, TRANSCRIPT)).toContain(FAKE_TOKEN);
      // An untracked deletion is just a gone file.
      writeFileSync(join(repo, 'scratch.md'), 'x\n');
      rmSync(join(repo, 'scratch.md'));
      expect(enumerateRepository(repo).files).not.toContain('scratch.md');
    } finally {
      warn.mockRestore();
    }
  });

  test('the working tree wins over the index when both exist', () => {
    const repo = incidentRepo();
    git(repo, 'add', '-f', TRANSCRIPT);
    writeFileSync(join(repo, TRANSCRIPT), 'redacted\n');
    expect(readRepositoryFile(repo, TRANSCRIPT)).toBe('redacted\n');
  });

  test('an empty enumeration throws rather than handing every gate a clean tree', () => {
    const repo = scratchDir('sources-empty');
    initRepo(repo);
    expect(() => enumerateRepository(repo)).toThrow(/enumerated no file/);
  });

  test('a poisoned GIT_DIR/GIT_WORK_TREE cannot redirect enumeration away from the repo `-C` names — the pre-push hook shape', () => {
    const target = scratchDir('sources-enumeration-target');
    initRepo(target);
    writeFileSync(join(target, 'TARGET-MARKER.txt'), 'target\n');
    git(target, 'add', 'TARGET-MARKER.txt');

    const decoy = scratchDir('sources-enumeration-decoy');
    initRepo(decoy);
    writeFileSync(join(decoy, 'DECOY-MARKER.txt'), 'decoy\n');
    git(decoy, 'add', 'DECOY-MARKER.txt');

    // A git hook exports GIT_DIR/GIT_WORK_TREE into ITS OWN process
    // environment, and every child it spawns inherits that by default —
    // including a nested `bun`. Mutating `process.env` inside THIS test
    // process cannot reproduce that: measured directly, `execFileSync`'s
    // default (no `env` option) child-env inheritance is snapshotted at Bun's
    // own process start and never observes a later write here — the same
    // reason the old beforeAll/afterAll scrub in this file never actually
    // protected anything. So the poisoned environment is set on an actually
    // SPAWNED bun process below, which is the shape a hook produces, and
    // `enumerateRepository` runs inside THAT process rather than this one.
    const probeSources = join(import.meta.dir, 'sources.ts');
    const probe = execFileSync('bun', ['-e', `
      import { enumerateRepository } from ${JSON.stringify(probeSources)};
      process.stdout.write(JSON.stringify(enumerateRepository(${JSON.stringify(target)}).files));
    `], {
      env: { ...process.env, GIT_DIR: join(decoy, '.git'), GIT_WORK_TREE: decoy },
      encoding: 'utf8',
    });
    const files: string[] = JSON.parse(probe);
    expect(files).toContain('TARGET-MARKER.txt');
    expect(files).not.toContain('DECOY-MARKER.txt');
  });
});

// The incident, end to end through the gate's own pieces: the corpus the secret
// scan reads is the enumeration narrowed by `isTextSource` and materialised by
// `readRepositoryFile` — so the tracked+ignored transcript, with NO working-tree
// copy, still fails the scan on its index blob.
test('a tracked+ignored credential with no disk copy is a secret-scan finding; untracked it is out of corpus', () => {
  const repo = incidentRepo();
  git(repo, 'add', '-f', TRANSCRIPT);
  rmSync(join(repo, TRANSCRIPT));
  const warn = spyOn(console, 'error').mockImplementation(() => {});
  try {
    const corpus = enumerateRepository(repo).files.filter(isTextSource);
    expect(corpus).toContain(TRANSCRIPT);
    const findings = corpus.flatMap((f) => scanText(f, readRepositoryFile(repo, f)));
    expect(findings.map((f) => `${f.pattern}:${f.file}`)).toContain(`proteus-token:${TRANSCRIPT}`);

    git(repo, 'rm', '-q', '--cached', TRANSCRIPT);
    writeFileSync(join(repo, TRANSCRIPT), `the owner pasted ${FAKE_TOKEN} here\n`);
    expect(enumerateRepository(repo).files.filter(isTextSource)).not.toContain(TRANSCRIPT);
  } finally {
    warn.mockRestore();
  }
});
