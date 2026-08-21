/**
 * Owner-only files are VERIFIED, not requested.
 *
 * The shape these replace was `writeFileSync(path, data, { mode: 0o600 })`
 * followed by `try { chmodSync(path, 0o600) } catch {}`. Both halves matter:
 * `mode` is honoured only on creation, so a file an earlier version left
 * group-readable keeps its bits on rewrite, and the chmod that was meant to fix
 * that was the one call whose failure was discarded. A refresh token then sits
 * in a world-readable file with nothing anywhere saying so.
 */

import { describe, test, expect, afterEach } from 'bun:test';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { enforceOwnerOnly, ensureSecretDir, writeSecretFile } from '../src/secret-file';

const roots: string[] = [];
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kinu-secret-'));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('writeSecretFile', () => {
  test('writes the content owner-only', () => {
    const path = join(scratch(), 'config.json');
    writeSecretFile(path, '{"refreshToken":"secret"}\n');
    expect(readFileSync(path, 'utf-8')).toBe('{"refreshToken":"secret"}\n');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test('narrows a file an earlier version left group- and world-readable', () => {
    // The regression `writeFileSync(..., { mode })` alone cannot fix: the mode
    // option is ignored for an existing file.
    const path = join(scratch(), 'config.json');
    writeFileSync(path, 'stale');
    chmodSync(path, 0o644);
    expect(statSync(path).mode & 0o077).not.toBe(0);

    writeSecretFile(path, 'fresh');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  test('creates missing parent directories', () => {
    const path = join(scratch(), 'nested', 'deeper', 'creds.json');
    writeSecretFile(path, '{}');
    expect(readFileSync(path, 'utf-8')).toBe('{}');
  });
});

describe('enforceOwnerOnly', () => {
  test('throws rather than leaving a secret readable beyond its owner', () => {
    // The swallow's whole failure mode, exercised directly: the narrowing does
    // not take, and the caller must find out instead of proceeding.
    const path = join(scratch(), 'token');
    writeFileSync(path, 'secret');
    chmodSync(path, 0o644);
    expect(() => enforceOwnerOnly(path, 0o644)).toThrow(/readable beyond its owner/);
    expect(statSync(path).mode & 0o777).toBe(0o644);
  });

  test('reports the path and preserves the cause when chmod itself fails', () => {
    const missing = join(scratch(), 'does-not-exist');
    let caught: unknown;
    try {
      enforceOwnerOnly(missing);
    } catch (error) {
      caught = error;
    }
    if (!(caught instanceof Error)) throw new Error('enforceOwnerOnly did not throw an Error');
    expect(caught.message).toContain(missing);
    // Go's %w, in the language: the ENOENT survives for the caller to classify.
    expect(caught.cause).toBeDefined();
  });
});

describe('ensureSecretDir', () => {
  test('creates the directory owner-traverse-only', () => {
    const dir = join(scratch(), 'home');
    ensureSecretDir(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  test('narrows an existing group-readable directory', () => {
    const dir = scratch();
    chmodSync(dir, 0o755);
    ensureSecretDir(dir);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });
});
