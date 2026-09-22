// The `workspace` row for a directory-bound session declares what this machine's PATH proves, and follows PATH when it moves.
import { describe, expect, test } from 'bun:test';
import { renderDynamicContextBlock } from '@kinu.run/core';
import { hostToolchainCapabilities, HOST_UNMEASURED_CAPABILITIES } from '../src/host-toolchain';

const STRUCTURAL_ONLY =
  '- workspace: active, runs: native_binary, shell, fs_shared, net_outbound, process_spawn';

/** What no PATH lookup settles; declared, since an omission reads to the model like a measured absence. */
const NOT_MEASURED = ', not measured here: docker, gpu';

/** The row as the model receives it, through the real renderer and the two sets `cli-backend/src/runtime.ts` registers. */
function runsLine(): string {
  const block = renderDynamicContextBlock({
    executors: [{
      name: 'workspace', kind: 'workspace',
      capabilities: [...hostToolchainCapabilities()],
      unmeasuredCapabilities: [...HOST_UNMEASURED_CAPABILITIES],
      available: true, configured: true, active: true, status: 'active',
    }],
  });

  const line = block?.split('\n').find((row) => row.startsWith('- workspace:'));

  if (line === undefined) throw new Error('no rendered workspace row');

  return line;
}

function claims(): string {
  return runsLine().split(', not measured here: ')[0] ?? '';
}

function withPath<T>(PATH: string, fn: () => T): T {
  const previous = process.env.PATH;
  process.env.PATH = PATH;

  try {
    return fn();
  } finally {
    process.env.PATH = previous;
  }
}

describe('host toolchain row', () => {
  test('claims a language only while a binary that runs it is on PATH', () => {
    // This process is Bun, so `bun` resolves and executes both .js and .ts.
    expect(Bun.which('bun', { PATH: process.env.PATH ?? '' })).not.toBeNull();
    expect(claims()).toContain('javascript');
    expect(claims()).toContain('typescript');

    expect(withPath('/nonexistent-host-toolchain-probe', runsLine)).toBe(STRUCTURAL_ONLY + NOT_MEASURED);
  });

  test('git and npm are probed, not assumed', () => {
    const line = withPath('/nonexistent-host-toolchain-probe', claims);

    expect(line).not.toContain('git');
    expect(line).not.toContain('npm');
  });

  test('never claims docker or gpu, and says so rather than omitting them', () => {
    // A resolving `docker` client proves no reachable daemon, and nothing on PATH proves `gpu` hardware: never claimed, never dropped.
    expect(claims()).not.toContain('docker');
    expect(claims()).not.toContain('gpu');
    expect(runsLine()).toContain(NOT_MEASURED);
  });

  test('python follows the interpreter, in whichever direction this host sits', () => {
    const installed = Bun.which('python3', { PATH: process.env.PATH ?? '' }) !== null
      || Bun.which('python', { PATH: process.env.PATH ?? '' }) !== null;

    expect(claims().includes('python')).toBe(installed);
    expect(withPath('/nonexistent-host-toolchain-probe', claims)).not.toContain('python');
  });
});
