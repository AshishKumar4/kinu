/**
 * The daemon's PATH walk and the CLI's `Bun.which` must agree on the shared toolchain table,
 * including refusing an executable directory named like a binary.
 */
import { scratchDir } from '../../test-utils/src/scratch';
import { describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, symlinkSync } from 'node:fs';

import { join } from 'node:path';
import * as v from 'valibot';
import { TOOLCHAIN_PROBE_BINARIES, toolchainCapabilities } from '@kinu.run/core';

interface WhichFrame {
  id: number;
  method: 'which';
  params: [string[]];
}

interface FrameSink {
  send(data: string): void;
}

/** A `which` frame touches no checkpoint store, so the daemon gets an empty one, as the hub's probe path does. */
interface DaemonContext {
  checkpoints?: undefined;
}

const require = createRequire(import.meta.url);

const rawDaemonModule: unknown = require('../../pc-agent/src/index.js');

const daemon = v.parse(v.object({ handle: v.function() }), rawDaemonModule);

function dispatch(frame: WhichFrame, ws: FrameSink, ctx: DaemonContext): void {
  daemon.handle(frame, ws, ctx);
}

const whichResult = v.object({ result: v.object({ present: v.array(v.string()) }) });

/** The daemon's answer for `names` against `PATH`, through the real RPC frame. */
function daemonResolves(PATH: string, names: readonly string[]): string[] {
  const frames: unknown[] = [];
  const previous = process.env.PATH;
  process.env.PATH = PATH;

  try {
    dispatch(
      { id: 1, method: 'which', params: [[...names]] },
      { send: (data: string) => frames.push(JSON.parse(data)) },
      {},
    );
  } finally {
    process.env.PATH = previous;
  }

  return v.parse(whichResult, frames[0]).result.present;
}

function bunResolves(PATH: string, names: readonly string[]): string[] {
  return names.filter((name) => Bun.which(name, { PATH }) !== null);
}

function withPathDir<T>(build: (dir: string) => void, fn: (dir: string) => T): T {
  const dir = scratchDir('scratch-path-parity');

  build(dir);

  return fn(dir);
}

function bothResolvers(dir: string) {
  return {
    daemon: daemonResolves(dir, TOOLCHAIN_PROBE_BINARIES),
    bun: bunResolves(dir, TOOLCHAIN_PROBE_BINARIES),
  };
}

function bothFindNothing(dir: string): void {
  const { daemon: d, bun: b } = bothResolvers(dir);

  expect(d).toEqual(b);
  expect(d).toEqual([]);
}

describe('PATH resolver parity', () => {
  test('a real executable resolves on both sides', () => {
    withPathDir(
      (dir) => writeFileSync(join(dir, 'node'), '#!/bin/sh\n', { mode: 0o755 }),
      (dir) => {
        const { daemon: d, bun: b } = bothResolvers(dir);
        expect(d).toEqual(b);
        expect(d).toEqual(['node']);
      },
    );
  });

  test('a directory named like a binary is not a binary on either side', () => {
    withPathDir(
      (dir) => {
        writeFileSync(join(dir, 'node'), '#!/bin/sh\n', { mode: 0o755 });
        mkdirSync(join(dir, 'bun'), { mode: 0o755 });
      },
      (dir) => {
        const { daemon: d, bun: b } = bothResolvers(dir);
        expect(d).toEqual(b);
        expect(d).not.toContain('bun');
        expect(toolchainCapabilities(d)).not.toContain('typescript');
        expect(toolchainCapabilities(d)).toEqual(['javascript']);
      },
    );
  });

  test('a non-executable file is not a binary on either side', () => {
    withPathDir(
      (dir) => writeFileSync(join(dir, 'python3'), 'not a program', { mode: 0o644 }),
      bothFindNothing,
    );
  });

  test('a symlink to an executable resolves on both sides', () => {
    withPathDir(
      (dir) => {
        writeFileSync(join(dir, 'real-python'), '#!/bin/sh\n', { mode: 0o755 });
        // A symlinked interpreter: a resolver that does not follow it loses `python` on pyenv/asdf machines.
        symlinkSync(join(dir, 'real-python'), join(dir, 'python3'));
      },
      (dir) => {
        const { daemon: d, bun: b } = bothResolvers(dir);
        expect(d).toEqual(b);
        expect(d).toEqual(['python3']);
        expect(toolchainCapabilities(d)).toEqual(['python']);
      },
    );
  });

  test('a dangling symlink is absent on both sides', () => {
    withPathDir(
      (dir) => symlinkSync(join(dir, 'gone'), join(dir, 'git')),
      bothFindNothing,
    );
  });

  test('an empty PATH resolves to nothing on both sides, and claims nothing', () => {
    const names = TOOLCHAIN_PROBE_BINARIES;
    expect(daemonResolves('/nonexistent-path-parity', names))
      .toEqual(bunResolves('/nonexistent-path-parity', names));
    expect(toolchainCapabilities(daemonResolves('/nonexistent-path-parity', names))).toEqual([]);
  });

  test('this machine gets the same answer from both resolvers', () => {
    // Against the real PATH, so a divergence neither crafted case covers still fails; order is part of the agreement.
    const PATH = process.env.PATH ?? '';
    expect(daemonResolves(PATH, TOOLCHAIN_PROBE_BINARIES))
      .toEqual(bunResolves(PATH, TOOLCHAIN_PROBE_BINARIES));
  });
});
