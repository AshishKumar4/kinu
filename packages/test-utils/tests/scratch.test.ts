import { describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import * as v from 'valibot';
import { scratchDir, SCRATCH_ROOT_PREFIX } from '../src/scratch';

const repoRoot = resolve(import.meta.dir, '../../..');

const helper = new URL('../src/scratch.ts', import.meta.url).pathname;

describe('the shared scratch owner', () => {
  test('an explicit parent, nested roots, and file sidecars remain one owned lifetime', () => {
    const parent = scratchDir('scratch-owner');
    writeFileSync(join(parent, 'unowned-sentinel'), 'keep');

    const child = Bun.spawnSync([process.execPath, '-e', `
      import { writeFileSync, existsSync } from 'node:fs';
      import { join } from 'node:path';
      import { scratchDir, releaseScratch } from ${JSON.stringify(helper)};
      const root = scratchDir('child', ${JSON.stringify(parent)});
      const nested = scratchDir('nested', root);
      writeFileSync(join(root, 'agent.db'), 'db');
      writeFileSync(join(root, 'agent.db-wal'), 'wal');
      const removed = releaseScratch();
      console.log(JSON.stringify({ root, nested, removed, exists: [existsSync(root), existsSync(nested)] }));
    `], { cwd: repoRoot, stdout: 'pipe', stderr: 'pipe' });

    expect(child.exitCode, child.stderr.toString()).toBe(0);

    const receipt = v.parse(v.object({
      root: v.string(), nested: v.string(), removed: v.number(), exists: v.array(v.boolean()),
    }), JSON.parse(child.stdout.toString()));

    expect(dirname(receipt.root)).toBe(parent);
    expect(dirname(receipt.nested)).toBe(receipt.root);
    expect(receipt.root.slice(parent.length + 1)).toStartWith(`${SCRATCH_ROOT_PREFIX}child-`);
    expect(receipt.removed).toBe(2);
    expect(receipt.exists).toEqual([false, false]);
    expect(readdirSync(parent)).toEqual(['unowned-sentinel']);
  });

  test('the Bun preload releases owned roots and child temp files when a fixture throws', () => {
    const parent = scratchDir('scratch-preload');
    const childTmp = scratchDir('scratch-child-tmp');
    const fixture = join(parent, 'failure.test.ts');
    const receipt = join(parent, 'receipt.json');
    writeFileSync(fixture, `
      import { test } from 'bun:test';
      import { writeFileSync } from 'node:fs';
      import { tmpdir } from 'node:os';
      import { join } from 'node:path';
      import { scratchDir } from ${JSON.stringify(helper)};
      const ambient = join(tmpdir(), 'child-temporary-file');
      writeFileSync(ambient, 'temporary');
      const roots = [scratchDir('failed-fixture'), scratchDir('explicit-parent', ${JSON.stringify(parent)}), ambient];
      writeFileSync(${JSON.stringify(receipt)}, JSON.stringify(roots));
      test('the seeded fixture failure', () => { throw new Error('expected scratch fixture failure'); });
    `);

    const child = Bun.spawnSync([process.execPath, 'test', fixture], {
      cwd: repoRoot, stdout: 'pipe', stderr: 'pipe',
      env: { ...process.env, TMPDIR: childTmp },
    });

    expect(child.exitCode).not.toBe(0);
    expect(child.stderr.toString()).toContain('expected scratch fixture failure');
    const roots = v.parse(v.array(v.string()), JSON.parse(readFileSync(receipt, 'utf8')));
    expect(roots).toHaveLength(3);
    expect(roots.map(root => existsSync(root))).toEqual([false, false, false]);
  });

  test('a refused removal neither stops the other owned roots nor loses the failed one', () => {
    const preload = resolve(repoRoot, 'scripts/test-scratch-home.ts');
    const outside = scratchDir('scratch-release-outside');

    // One root's rmSync is refused ONCE by name in the child's mock — the only
    // mocked seam is the removal call itself. The preload mints its runner
    // root through the same owner, so `release` exercises the real contract:
    // the failed root, its sibling, the runner home and the child's TMPDIR
    // all go through the one attempt-everything pass. The blocked root's
    // parent is THIS test's owned directory — outside the child's runner
    // root, so a refused rmSync is not swept by the parent's recursive
    // delete, and owned here so nothing is written to the global /tmp.
    const child = Bun.spawnSync([process.execPath, '-e', `
      import { mock } from 'bun:test';
      import * as realFs from 'node:fs';
      import { join } from 'node:path';

      // The namespace is mutated by mock.module, so the real removal is bound
      // BEFORE registration — realFs.rmSync read later would be the mock.
      const realRmSync = realFs.rmSync;
      const BLOCKED = 'blocked-root';
      let armed = true;
      const rmSync = (path, options) => {
        if (armed && String(path).includes(BLOCKED)) {
          const cause = new Error('simulated removal refusal');
          (cause).code = 'EACCES';
          throw cause;
        }
        return realRmSync(path, options);
      };
      mock.module('node:fs', () => ({ ...realFs, rmSync, default: { ...realFs, rmSync } }));

      const scratchHome = await import(${JSON.stringify(preload)});
      const scratch = await import(${JSON.stringify(helper)});

      const blocked = scratch.scratchDir(BLOCKED, ${JSON.stringify(outside)});
      const sibling = scratch.scratchDir('sibling');
      realFs.writeFileSync(join(process.env.TMPDIR, 'child-temp-file'), 'temporary');
      let first;
      try { scratchHome.release(); } catch (error) { first = error; }

      // The post-release state is read BEFORE the disarm — the second pass
      // below is what finally removes the blocked root.
      const existsAfter = [realFs.existsSync(blocked), realFs.existsSync(sibling),
        realFs.existsSync(process.env.KINU_HOME), realFs.existsSync(process.env.TMPDIR)];

      armed = false;
      const secondRemoved = scratch.releaseScratch();

      console.log(JSON.stringify({
        isAggregate: first instanceof AggregateError,
        message: first?.message ?? null,
        innerCount: first?.errors?.length ?? null,
        innerCauseCode: first?.errors?.[0]?.cause?.code ?? null,
        existsAfter,
        secondRemoved,
        blockedAfter: realFs.existsSync(blocked),
      }));
    `], { cwd: repoRoot, stdout: 'pipe', stderr: 'pipe' });

    expect(child.exitCode, child.stderr.toString()).toBe(0);

    const report = v.parse(v.object({
      isAggregate: v.boolean(), message: v.string(), innerCount: v.number(),
      innerCauseCode: v.string(), existsAfter: v.array(v.boolean()),
      secondRemoved: v.number(), blockedAfter: v.boolean(),
    }), JSON.parse(child.stdout.toString()));

    // The failure is reported, not swallowed — as one aggregate naming the
    // cause — while the sibling, the runner home and the child's TMPDIR were
    // all released in the same pass.
    expect(report.isAggregate).toBe(true);
    expect(report.message).toContain('scratch not released');
    expect(report.innerCount).toBe(1);
    expect(report.innerCauseCode).toBe('EACCES');
    expect(report.existsAfter).toEqual([true, false, false, false]);
    // Ownership of the failed root survived the throw: an explicit later
    // release attempts it again and completes it.
    expect(report.secondRemoved).toBe(1);
    expect(report.blockedAfter).toBe(false);
  });
});
