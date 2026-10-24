import { afterAll, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect } from 'effect';
import { refreshTools, type ToolsRefresh } from '../src/golden';
import { DEVBOX_SCRATCH_PREFIX } from './support/scratch';
import { manifestDelta, packagePaths, TOOLS_MANIFEST, TOOLS_STAGED, toolsApplyCommand, toolsFileKey, toolsManifestKey } from '../src/tools';

// Production, 2026-10-24 (ledger 1024-h): the owner's box restored its own snapshot under tools 334f3712 where the deploy
// pinned 0c6dd2b8, and fetched and installed the whole 358 MB tarball inside its 25 s start, 12-24 s on every box after a
// re-pin, for a change of one 0.7 MB binary. A start fetches the files that changed, by the pin's manifest; a pin that
// changes a package installs whole, as apt over the whole repository is the only install that leaves base packages be.

const scratch = mkdtempSync(join(tmpdir(), `${DEVBOX_SCRATCH_PREFIX}tools-refresh-`));

afterAll(() => { rmSync(scratch, { recursive: true, force: true }); });

const sha = (text: string): string => createHash('sha256').update(text).digest('hex');

const line = (body: string, path: string): string => `${sha(body)}  ${path}`;

describe('the manifest delta', () => {
  test('names each file whose sha256 moved or that is new, and each file the pin no longer holds', () => {
    const installed = [line('lower 1', 'usr/local/bin/devbox-block-lower'), line('bun', 'usr/local/bin/bun'), line('gone', 'usr/local/bin/old-tool')].join('\n');
    const next = [line('lower 2', 'usr/local/bin/devbox-block-lower'), line('bun', 'usr/local/bin/bun'), line('tini 2', 'usr/local/lib/devbox/debs/tini_0.19.0-2_amd64.deb')].join('\n');

    const delta = manifestDelta(installed, next);

    expect({ delta, packages: packagePaths(delta) }).toEqual({
      delta: {
        changed: [
          { sha256: sha('lower 2'), path: 'usr/local/bin/devbox-block-lower' },
          { sha256: sha('tini 2'), path: 'usr/local/lib/devbox/debs/tini_0.19.0-2_amd64.deb' },
        ],
        removed: ['usr/local/bin/old-tool'],
      },
      packages: ['usr/local/lib/devbox/debs/tini_0.19.0-2_amd64.deb'],
    });
  });
});

describe('the apply command, run against a scratch root', () => {
  test('places each verified file with its mode kept, removes what the pin dropped, writes the manifest and the stamp', () => {
    const root = mkdtempSync(join(scratch, 'apply-'));
    const staged = join(root, 'staged');
    const bin = join(root, 'usr/local/bin');

    mkdirSync(staged, { recursive: true });
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'devbox-block-lower'), 'lower 1');
    chmodSync(join(bin, 'devbox-block-lower'), 0o755);
    writeFileSync(join(bin, 'old-tool'), 'gone');
    writeFileSync(join(staged, sha('lower 2')), 'lower 2');
    writeFileSync(join(staged, sha('new tool')), 'new tool');
    writeFileSync(join(staged, 'manifest'), 'the next manifest\n');
    const delta = { changed: [{ sha256: sha('lower 2'), path: 'usr/local/bin/devbox-block-lower' }, { sha256: sha('new tool'), path: 'usr/local/bin/new-tool' }], removed: ['usr/local/bin/old-tool'] };

    const out = execFileSync('bash', ['-c', toolsApplyCommand(delta, 'pin-2', { root, staged })], { encoding: 'utf8' });

    expect({
      lower: readFileSync(join(bin, 'devbox-block-lower'), 'utf8'), mode: statSync(join(bin, 'devbox-block-lower')).mode & 0o777,
      added: statSync(join(bin, 'new-tool')).mode & 0o777, removed: !existsSync(join(bin, 'old-tool')),
      manifest: readFileSync(join(root, TOOLS_MANIFEST.slice(1)), 'utf8'), stamp: readFileSync(join(root, 'usr/local/lib/devbox/tools-installed'), 'utf8'),
      said: /^filesMs=\d+ files=2 removed=1 bytes=15$/mu.test(out),
    }).toEqual({ lower: 'lower 2', mode: 0o755, added: 0o755, removed: true, manifest: 'the next manifest\n', stamp: 'pin-2', said: true });
  });

  test('refuses a staged file whose bytes are not its sha256, and places nothing', () => {
    const root = mkdtempSync(join(scratch, 'apply-'));
    const staged = join(root, 'staged');

    mkdirSync(staged, { recursive: true });
    mkdirSync(join(root, 'usr/local/bin'), { recursive: true });
    writeFileSync(join(root, 'usr/local/bin/devbox-block-lower'), 'lower 1');
    writeFileSync(join(staged, sha('lower 2')), 'tampered');
    writeFileSync(join(staged, 'manifest'), 'm');

    expect(() => execFileSync('bash', ['-c', toolsApplyCommand({ changed: [{ sha256: sha('lower 2'), path: 'usr/local/bin/devbox-block-lower' }], removed: [] }, 'pin-2', { root, staged })], { encoding: 'utf8', stdio: 'pipe' }))
      .toThrow(/is not the pinned file/u);
    expect(readFileSync(join(root, 'usr/local/bin/devbox-block-lower'), 'utf8')).toBe('lower 1');
  });

  test('a file it cannot place stops it before the manifest and the stamp, so the next start moves the files again', () => {
    const root = mkdtempSync(join(scratch, 'apply-'));
    const staged = join(root, 'staged');

    mkdirSync(staged, { recursive: true });
    mkdirSync(join(root, 'usr/local/lib/devbox'), { recursive: true });
    writeFileSync(join(root, 'usr/local/bin'), 'a file where the directory should be');
    writeFileSync(join(root, TOOLS_MANIFEST.slice(1)), 'the old manifest\n');
    writeFileSync(join(root, 'usr/local/lib/devbox/tools-installed'), 'pin-1');
    writeFileSync(join(staged, sha('lower 2')), 'lower 2');
    writeFileSync(join(staged, 'manifest'), 'the next manifest\n');
    const delta = { changed: [{ sha256: sha('lower 2'), path: 'usr/local/bin/devbox-block-lower' }], removed: [] };

    expect(() => execFileSync('bash', ['-c', toolsApplyCommand(delta, 'pin-2', { root, staged })], { encoding: 'utf8', stdio: 'pipe' })).toThrow();
    expect({ manifest: readFileSync(join(root, TOOLS_MANIFEST.slice(1)), 'utf8'), stamp: readFileSync(join(root, 'usr/local/lib/devbox/tools-installed'), 'utf8') })
      .toEqual({ manifest: 'the old manifest\n', stamp: 'pin-1' });
  });
});

describe('a start\'s tools refresh', () => {
  const installed = [line('lower 1', 'usr/local/bin/devbox-block-lower'), line('bun', 'usr/local/bin/bun')].join('\n');
  const next = [line('lower 2', 'usr/local/bin/devbox-block-lower'), line('bun', 'usr/local/bin/bun')].join('\n');

  /** A box holding `stamp` and `manifest`, a store holding the pin's manifest when `published`, and what the refresh asked. */
  const box = ({ stamp, manifest, published, pinned = next, unfinished = false }: {
    readonly stamp: string; readonly manifest: string; readonly published: boolean; readonly pinned?: string; readonly unfinished?: boolean;
  }) => {
    const asked: string[] = [];

    const ports = {
      pin: 'pin-2',
      exec: async (command: string) => {
        const kinds: readonly (readonly [boolean, string])[] = [
          [command.startsWith('cat /usr/local/lib/devbox/tools-installed'), 'stamp'], [command.includes(`cat ${TOOLS_MANIFEST}`), 'manifest'],
          [command.includes('filesMs='), 'apply'], [command.includes('extractMs='), 'install'], [command.startsWith('mkdir'), 'mkdir'],
        ];

        asked.push(kinds.find(([matched]) => matched)?.[1] ?? command.slice(0, 20));

        if (command.startsWith('cat /usr/local/lib/devbox/tools-installed')) return { stdout: stamp, exitCode: 0 };

        if (command.includes(`cat ${TOOLS_MANIFEST}`)) return unfinished ? { stdout: '', exitCode: 3 } : { stdout: manifest, exitCode: 0 };

        if (command.includes('filesMs=')) return { stdout: 'filesMs=40 files=1 removed=0 bytes=712000\n', exitCode: 0 };

        if (command.includes('extractMs=')) return { stdout: 'extractMs=2100 installMs=1500 changed=0\n', exitCode: 0 };

        return { stdout: '', exitCode: 0 };
      },
      pipe: (key: string, path: string) => Effect.sync(() => { asked.push(`pipe ${key} -> ${path}`); }),
      read: async (key: string) => {
        asked.push(`read ${key}`);

        return published && key === toolsManifestKey('pin-2') ? pinned : null;
      },
      now: (() => {
        let at = 0;

        return () => (at += 100);
      })(),
    };

    return { asked, run: async (): Promise<ToolsRefresh> => await Effect.runPromise(refreshTools(ports)) };
  };

  test('a box at the pin does nothing more than read its stamp', async () => {
    const current = box({ stamp: 'pin-2', manifest: installed, published: true });

    expect({ refresh: (await current.run()).mode, asked: current.asked }).toEqual({ refresh: 'current', asked: ['stamp'] });
  });

  test('a box a pin behind fetches the changed file alone, by its sha256, and the manifest, and applies them', async () => {
    const behind = box({ stamp: 'pin-1', manifest: installed, published: true });
    const refresh = await behind.run();

    expect({ refresh, asked: behind.asked }).toEqual({
      refresh: { mode: 'incremental', files: 1, removed: 0, bytes: 712000, filesMs: 40, ms: refresh.ms },
      asked: ['stamp', `read ${toolsManifestKey('pin-2')}`, 'manifest', 'mkdir', `pipe ${toolsFileKey(sha('lower 2'))} -> ${TOOLS_STAGED}/${sha('lower 2')}`,
        `pipe ${toolsManifestKey('pin-2')} -> ${TOOLS_STAGED}/manifest`, 'apply'],
    });
  });

  test('a box with no manifest, a store with none for the pin, a pin that changes a package, or a full install cut short installs whole and says why', async () => {
    const unmanifested = box({ stamp: 'pin-1', manifest: '', published: true });
    const unpublished = box({ stamp: 'pin-1', manifest: installed, published: false });
    const repackaged = box({ stamp: 'pin-1', manifest: installed, published: true, pinned: `${next}\n${line('tini 2', 'usr/local/lib/devbox/debs/tini_0.19.0-2_amd64.deb')}` });
    const unfinished = box({ stamp: 'pin-1', manifest: next, published: true, unfinished: true });
    const runs = [await unmanifested.run(), await unpublished.run(), await repackaged.run(), await unfinished.run()];

    expect({ runs: runs.map(({ mode, reason, extractMs, installMs }) => ({ mode, reason, extractMs, installMs })), fetched: repackaged.asked.filter((step) => step.startsWith('pipe')) }).toEqual({
      runs: [
        { mode: 'full', reason: 'the box holds no tools manifest', extractMs: 2100, installMs: 1500 },
        { mode: 'full', reason: `the store holds no ${toolsManifestKey('pin-2')}.0`, extractMs: 2100, installMs: 1500 },
        { mode: 'full', reason: 'the pin changes 1 package files', extractMs: 2100, installMs: 1500 },
        { mode: 'full', reason: 'the box\'s last full install did not finish', extractMs: 2100, installMs: 1500 },
      ],
      fetched: ['pipe devbox-tools/pin-2.tgz -> /tmp/devbox-tools.tgz'],
    });
  });
});
