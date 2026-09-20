#!/usr/bin/env bun
/**
 * Prepare the vendored Mossaic SDK: verify the pinned source, then build it.
 *
 * `@mossaic/sdk` is not on npm. Its source is vendored under
 * `third_party/mossaic/` at one upstream commit, and `third_party/mossaic/sdk`
 * is a real workspace, so `packages/cf-backend` depends on it as `workspace:*`
 * and resolves it through its ORDINARY export map — `dist/*.js` and
 * `dist/*.d.ts`. Upstream's map also carries a `"workspace"` condition pointing
 * at `src/`; nothing here turns that condition on, because a global custom
 * condition would hand every consumer raw `.ts` and leave the built artefact
 * untested.
 *
 * `dist/` is therefore load-bearing and is NOT committed — a committed build
 * output drifts from its source the day nobody rebuilds it. So installation has
 * to produce it, which is what the root `prepare` hook does by running this
 * file after `ladder --install-hooks`.
 *
 * Two jobs, in order, and nothing else:
 *
 *   1. Verify every vendored byte against `third_party/mossaic/upstream.json`.
 *      The file SET is compared as well as the digests: a path added to the
 *      tree and not to the manifest is drift a digest loop alone cannot see.
 *      This runs first because building edited "upstream" source would produce
 *      an artefact the provenance record does not describe.
 *   2. Run upstream's own build — `tsdown` over `sdk/tsdown.config.ts`, the
 *      config that already knows the five entry points, the `@shared` alias,
 *      the `cloudflare:*` externals and the ESM/extension settings the export
 *      map expects. Kinu re-describes none of it.
 *
 * No stamp, no cache, no skip-if-unchanged: a conditional rebuild needs state
 * that can be wrong, and a wrong skip ships a stale `dist` against fresh
 * source. Measure the cost before adding one.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import * as v from 'valibot';
import { MOSSAIC_MANIFEST, MOSSAIC_ROOT, MOSSAIC_SDK, isMossaicVendored, trackedFiles } from './sources';

const REPO_ROOT = join(import.meta.dir, '..');

const Manifest = v.object({
  repository: v.string(),
  commit: v.pipe(v.string(), v.regex(/^[0-9a-f]{40}$/u)),
  vendored: v.record(v.string(), v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/u))),
});

/** One vendored path whose bytes are not the pinned upstream bytes. */
export interface SourceDrift {
  readonly file: string;
  readonly detail: string;
}

/** The pinned upstream identity, and every way this checkout departs from it. */
export interface SourceVerdict {
  readonly repository: string;
  readonly commit: string;
  readonly checked: number;
  readonly drift: readonly SourceDrift[];
}

/**
 * Every vendored path, against the manifest. Paths are reported
 * manifest-relative (the upstream-relative path), which is what makes a finding
 * a statement about the upstream tree rather than about this checkout.
 */
export function verifyPinnedSource(
  root: string = REPO_ROOT,
  files: readonly string[] = trackedFiles(),
): SourceVerdict {
  const manifest = v.parse(Manifest, JSON.parse(readFileSync(join(root, MOSSAIC_MANIFEST), 'utf8')));
  const present = new Set(files.filter(isMossaicVendored).map((file) => file.slice(`${MOSSAIC_ROOT}/`.length)));
  const drift: SourceDrift[] = [];

  for (const file of [...present].sort()) {
    const pinned = manifest.vendored[file];

    if (pinned === undefined) {
      drift.push({ file, detail: `present in the tree, absent from ${MOSSAIC_MANIFEST}` });
      continue;
    }

    const digest = createHash('sha256').update(readFileSync(join(root, MOSSAIC_ROOT, file))).digest('hex');

    if (digest !== pinned) drift.push({ file, detail: `sha256 ${digest}, pinned ${pinned}` });
  }

  for (const file of Object.keys(manifest.vendored).sort()) {
    if (!present.has(file)) drift.push({ file, detail: `pinned in ${MOSSAIC_MANIFEST}, absent from the tree` });
  }

  return { repository: manifest.repository, commit: manifest.commit, checked: present.size, drift };
}

/**
 * The compiler upstream builds with, where the dts generator will find it.
 *
 * Measured 2026-09-20, bun 1.4.0, `linker = "hoisted"`. `typescript` is an
 * OPTIONAL PEER of `rolldown-plugin-dts` (range `^5 || ^6 || ~7.0`), and bun
 * hoists the plugin to the repo root, where that peer binds to Kinu's own
 * `typescript@7.0.2`. The plugin reads its compiler with
 * `createRequire(import.meta.url)`, so its location decides the version and no
 * flag, env var or cwd changes the answer. Two consequences, both measured:
 * `require('typescript')` at 7.0.2 returns a package with NO JS API
 * (`createProgram === undefined`), and the plugin's `isTS70Installed()` then
 * selects the `tsgo` generator, which passes `--rootDir <dirname(tsconfig)>`
 * — i.e. `sdk/` — while `sdk/tsconfig.json` includes `../shared` and
 * `../worker/core`. Every vendored file outside `sdk/` is then TS6059 and no
 * `.d.ts` is emitted at all.
 *
 * Upstream's own lock binds `tsdown@0.22.3(typescript@6.0.3)`, and
 * `sdk/package.json` pins `typescript: ^6.0.3`, which bun DOES install — nested
 * at `<sdk>/node_modules/typescript`, invisible to the hoisted plugin. So the
 * canonical build needs exactly one thing this install does not provide: the
 * peer edge pnpm makes natively. This creates it, in install-generated state,
 * every time, from the version the vendored manifest pins.
 *
 * Not a scoped override: bun 1.4.0 ignores all three spellings
 * (`overrides: { pkg: { typescript } }`, `overrides: { "pkg>typescript" }`,
 * `resolutions: { "pkg/typescript" }`) — measured, each installs 20 packages
 * and writes no nested directory. Not the isolated linker, which would change
 * every resolution in the repo. Not a `patches/` entry, which would pin a
 * build tool's internals to make a resolution edge appear.
 */
function bindPinnedCompiler(root: string): void {
  const compiler = join(root, MOSSAIC_SDK, 'node_modules/typescript');

  if (!existsSync(compiler)) {
    throw new Error(
      `${MOSSAIC_SDK}: the pinned typescript is not installed at ${compiler}. `
      + 'Run `bun install` at the repository root first.',
    );
  }

  const peer = join(root, 'node_modules/rolldown-plugin-dts/node_modules/typescript');

  mkdirSync(dirname(peer), { recursive: true });
  rmSync(peer, { recursive: true, force: true });
  symlinkSync(compiler, peer, 'dir');
}

/** Upstream's own build, over upstream's own config. Throws on a non-zero exit. */
export function buildSdk(root: string = REPO_ROOT): void {
  bindPinnedCompiler(root);

  const built = Bun.spawnSync(['bun', 'run', 'build'], {
    cwd: join(root, MOSSAIC_SDK),
    stdout: 'inherit',
    stderr: 'inherit',
  });

  if (built.exitCode !== 0) throw new Error(`${MOSSAIC_SDK}: tsdown exited ${String(built.exitCode)}`);
}

if (import.meta.main) {
  const verdict = verifyPinnedSource();

  if (verdict.drift.length > 0) {
    const lines = verdict.drift.map(({ file, detail }) => `  ${file}: ${detail}`).join('\n');

    console.error(
      `mossaic-sdk: ${String(verdict.drift.length)} path(s) diverge from `
      + `${verdict.repository} ${verdict.commit}\n${lines}\n`
      + `  fix: restore the upstream bytes, or re-vendor the closure and rewrite ${MOSSAIC_MANIFEST}`,
    );
    process.exit(1);
  }

  console.log(`mossaic-sdk: ${String(verdict.checked)} vendored files match ${verdict.commit}; building`);
  buildSdk();
}
