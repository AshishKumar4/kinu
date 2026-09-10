import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const GUARD = join(import.meta.dir, 'refuse-linked-install.ts');

const PRIMARY_ENTRY = join(import.meta.dir, '..', 'node_modules', 'valibot');

const minted: string[] = [];

const fixture = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'kinu-linked-install-'));
  minted.push(dir);
  mkdirSync(join(dir, 'node_modules'));
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'x', private: true, scripts: { preinstall: `bun ${GUARD}` } }));

  return dir;
};

const install = (cwd: string) => {
  const proc = Bun.spawnSync({ cmd: [process.execPath, 'install'], cwd, stdout: 'pipe', stderr: 'pipe' });

  return { exitCode: proc.exitCode, stderr: proc.stderr.toString() };
};

afterAll(() => { for (const dir of minted) rmSync(dir, { recursive: true, force: true }); });

describe('refuse-linked-install', () => {
  test('bun install refuses where a node_modules entry links outside the checkout', () => {
    const dir = fixture();
    symlinkSync(PRIMARY_ENTRY, join(dir, 'node_modules', 'valibot'));
    const refused = install(dir);
    expect(refused.exitCode).not.toBe(0);
    expect(refused.stderr).toContain('link outside this checkout');
  });

  test('bun install proceeds over a real node_modules and over none at all', () => {
    const real = fixture();
    mkdirSync(join(real, 'node_modules', 'valibot'));
    expect(install(real).exitCode).toBe(0);
    const empty = fixture();
    rmSync(join(empty, 'node_modules'), { recursive: true });
    expect(install(empty).exitCode).toBe(0);
  });
});
