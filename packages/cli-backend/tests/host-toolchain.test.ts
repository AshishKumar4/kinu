// The `laptop` row for the machine the CLI is running on.
//
// Asserted through the surface that makes the row matter — the agent's own
// execution block (`— runs: …`), which is where the model decides to send work —
// and by moving PATH, because the point of this module is that the row FOLLOWS
// the machine instead of describing a machine like it. `git` and `npm` used to
// be claimed unconditionally.
import { describe, expect, test } from 'bun:test';
import { renderDynamicContextBlock } from '@proteus/core';
import { hostToolchainCapabilities } from '../src/host-toolchain';

const STRUCTURAL_ONLY =
  '- laptop: connected — runs: native_binary, shell, fs_shared, net_outbound, process_spawn';

/** The row exactly as the model receives it, through the real renderer. */
function runsLine(): string {
  const block = renderDynamicContextBlock({
    executors: [{
      name: 'laptop', kind: 'laptop',
      capabilities: [...hostToolchainCapabilities()],
      available: true, configured: true, active: true, status: 'active',
    }],
  });
  const line = block?.split('\n').find((row) => row.startsWith('- laptop:'));
  if (line === undefined) throw new Error('no rendered laptop row');
  return line;
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
    // This process is Bun, so `bun` resolves — and `bun` executes both .js and
    // .ts. That is the evidence, not the assumption that a developer has them.
    expect(Bun.which('bun', { PATH: process.env.PATH ?? '' })).not.toBeNull();
    expect(runsLine()).toContain('javascript');
    expect(runsLine()).toContain('typescript');

    // Move the machine out from under it and the languages go with it: nothing
    // is left but what this executor's own wiring guarantees.
    expect(withPath('/nonexistent-host-toolchain-probe', runsLine)).toBe(STRUCTURAL_ONLY);
  });

  test('git and npm are probed, not assumed', () => {
    const line = withPath('/nonexistent-host-toolchain-probe', runsLine);

    // The row this replaced declared both on every host, so a machine with
    // neither was told to `git clone` and had no git.
    expect(line).not.toContain('git');
    expect(line).not.toContain('npm');
  });

  test('never claims docker or gpu, even where a docker client is on PATH', () => {
    // A `docker` client resolving says nothing about a reachable daemon, and the
    // capability reads "Docker" — it promises containers run. Nothing on PATH
    // establishes usable hardware for `gpu` at all. Both stay out regardless.
    const line = runsLine();
    expect(line).not.toContain('docker');
    expect(line).not.toContain('gpu');
  });

  test('python follows the interpreter, in whichever direction this host sits', () => {
    const installed = Bun.which('python3', { PATH: process.env.PATH ?? '' }) !== null
      || Bun.which('python', { PATH: process.env.PATH ?? '' }) !== null;

    expect(runsLine().includes('python')).toBe(installed);
    expect(withPath('/nonexistent-host-toolchain-probe', runsLine)).not.toContain('python');
  });
});
