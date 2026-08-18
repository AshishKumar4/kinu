/**
 * Cross-implementation PATH-resolver parity.
 *
 * The `laptop` capability row is produced by ONE table (core
 * `execution/toolchain.ts`) and TWO resolvers, because only a host can look at
 * its own PATH: `Bun.which` when the CLI is that host, and the zero-dep daemon's
 * own walk when the host is at the far end of a device tunnel. The table being
 * shared is what stops the POLICY drifting; this test is what stops the
 * MECHANISM drifting, and a disagreement is not cosmetic — it is a capability
 * the model routes work by, decided by which side happened to answer.
 *
 * The directory case is why this file exists. A directory can carry a binary's
 * name and carry the execute bit, and the daemon's `accessSync(X_OK)` said yes
 * to it: a directory named `bun` claimed `javascript` and `typescript` for a
 * machine that could run neither.
 */
import { describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as v from 'valibot';
import { TOOLCHAIN_PROBE_BINARIES, toolchainCapabilities } from '@proteus/core';

/** The `which` frame the hub sends: a fixed list of bare binary names. */
interface WhichFrame {
  id: number;
  method: 'which';
  params: [string[]];
}

/** The socket half `handle` answers through — it only ever sends. */
interface FrameSink {
  send(data: string): void;
}

/** The per-connection context. A `which` frame touches no checkpoint store, so
 *  the daemon is handed an empty one, exactly as the hub's probe path does. */
interface DaemonContext {
  checkpoints?: undefined;
}

const require = createRequire(import.meta.url);
const rawDaemonModule: unknown = require('../../pc-agent/src/index.js');
const daemon = v.parse(v.object({ handle: v.function() }), rawDaemonModule);

/** The daemon's dispatch, called with the frame and sink shapes above. Valibot
 *  has proven it callable; the argument types are ours to get right, and the
 *  answer is parsed on the way back. */
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

/** The CLI host's answer for the same question, on the same PATH. */
function bunResolves(PATH: string, names: readonly string[]): string[] {
  return names.filter((name) => Bun.which(name, { PATH }) !== null);
}

/** A PATH directory laid out by `build`, cleaned up after `fn`. */
function withPathDir<T>(build: (dir: string) => void, fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'proteus-scratch-path-parity-'));
  try {
    build(dir);
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Both resolvers, on one PATH, asked about the whole shared probe list. */
function bothResolvers(dir: string) {
  return {
    daemon: daemonResolves(dir, TOOLCHAIN_PROBE_BINARIES),
    bun: bunResolves(dir, TOOLCHAIN_PROBE_BINARIES),
  };
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
        // Executable, named `bun`, and not a program. This is the regression:
        // the daemon reported it, so the row claimed two languages the machine
        // has no interpreter for.
        mkdirSync(join(dir, 'bun'), { mode: 0o755 });
      },
      (dir) => {
        const { daemon: d, bun: b } = bothResolvers(dir);
        expect(d).toEqual(b);
        expect(d).not.toContain('bun');
        // And the consequence the row would have carried: `typescript` rests on
        // `bun`/`deno`/`tsx`, none of which is really here.
        expect(toolchainCapabilities(d)).not.toContain('typescript');
        expect(toolchainCapabilities(d)).toEqual(['javascript']);
      },
    );
  });

  test('a non-executable file is not a binary on either side', () => {
    withPathDir(
      (dir) => writeFileSync(join(dir, 'python3'), 'not a program', { mode: 0o644 }),
      (dir) => {
        const { daemon: d, bun: b } = bothResolvers(dir);
        expect(d).toEqual(b);
        expect(d).toEqual([]);
      },
    );
  });

  test('a symlink to an executable resolves on both sides', () => {
    withPathDir(
      (dir) => {
        writeFileSync(join(dir, 'real-python'), '#!/bin/sh\n', { mode: 0o755 });
        // The normal shape of an interpreter on PATH. Both resolvers must follow
        // it, or a pyenv/asdf machine loses `python` on one side only.
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
      (dir) => {
        const { daemon: d, bun: b } = bothResolvers(dir);
        expect(d).toEqual(b);
        expect(d).toEqual([]);
      },
    );
  });

  test('an empty PATH resolves to nothing on both sides, and claims nothing', () => {
    const names = TOOLCHAIN_PROBE_BINARIES;
    expect(daemonResolves('/nonexistent-path-parity', names))
      .toEqual(bunResolves('/nonexistent-path-parity', names));
    expect(toolchainCapabilities(daemonResolves('/nonexistent-path-parity', names))).toEqual([]);
  });

  test('this machine gets the same answer from both resolvers', () => {
    // The end-to-end claim: whichever side answers, the row is the same. Run
    // against the real PATH, so a divergence neither crafted case covers still
    // fails here.
    // Both filter the same ordered table, so order is part of the agreement.
    const PATH = process.env.PATH ?? '';
    expect(daemonResolves(PATH, TOOLCHAIN_PROBE_BINARIES))
      .toEqual(bunResolves(PATH, TOOLCHAIN_PROBE_BINARIES));
  });
});
