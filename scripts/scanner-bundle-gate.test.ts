import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  BUNDLE_BANNER, SCANNER_BUNDLE, SCANNER_SOURCE, buildScannerBundle, judgeBundle,
} from './scanner-bundle-gate';

const REPO_ROOT = join(import.meta.dir, '..');
const WIRED_BUNFIG = `[install.security]\nscanner = "./${SCANNER_BUNDLE}"\n`;

describe('the committed scanner bundle', () => {
  test('is a fresh build of the source, imports nothing, and is what bunfig names', async () => {
    const committed = readFileSync(join(REPO_ROOT, SCANNER_BUNDLE), 'utf8');
    const bunfig = readFileSync(join(REPO_ROOT, 'bunfig.toml'), 'utf8');
    const verdict = judgeBundle(committed, await buildScannerBundle(), bunfig);
    expect(verdict.findings).toEqual([]);
    // `bun build --target=bun` prepends its own `// @bun` pragma; the banner follows it.
    expect(committed.startsWith(`// @bun\n${BUNDLE_BANNER}`)).toBe(true);
    // The decoder is inlined, so the bundle is materially larger than its
    // banner and carries valibot's parser rather than an import of it.
    expect(verdict.bytes).toBeGreaterThan(4_000);
    expect(committed).not.toMatch(/from ['"]valibot['"]/u);
  });
});

describe('the gate goes red', () => {
  const fresh = `${BUNDLE_BANNER}\nexport const scanner = { version: "1", scan: async () => [] };\n`;

  test('when the committed bundle differs from the fresh build by one byte', () => {
    const stale = `${fresh} `;
    const verdict = judgeBundle(stale, fresh, WIRED_BUNFIG);
    expect(verdict.findings).toHaveLength(1);
    expect(verdict.findings[0]).toContain('bun run build:scanner');
  });

  test('when a bare import survives bundling', () => {
    const external = `${BUNDLE_BANNER}\nimport * as v from "valibot";\nexport const scanner = v;\n`;
    const verdict = judgeBundle(external, external, WIRED_BUNFIG);
    expect(verdict.findings).toHaveLength(1);
    expect(verdict.findings[0]).toContain('SecurityScannerNotInDependencies');
  });

  test('when bunfig names the source, or nothing', () => {
    for (const bunfig of [`[install.security]\nscanner = "./${SCANNER_SOURCE}"\n`, '[install]\nlinker = "hoisted"\n']) {
      const verdict = judgeBundle(fresh, fresh, bunfig);
      expect(verdict.findings).toHaveLength(1);
      expect(verdict.findings[0]).toContain(SCANNER_BUNDLE);
    }
  });

  test('and green only when all three hold', () => {
    expect(judgeBundle(fresh, fresh, WIRED_BUNFIG).findings).toEqual([]);
  });
});
