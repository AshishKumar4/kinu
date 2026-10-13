/**
 * The daemon's `which` answers the shared toolchain table from executable files on PATH, through its real RPC frame:
 * a directory named like a binary, a file that cannot run and a link to nothing are not binaries.
 */
import { scratchDir } from '../../test-utils/src/scratch';
import { describe, expect, test } from 'bun:test';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync, symlinkSync } from 'node:fs';

import { join } from 'node:path';
import * as v from 'valibot';
import { TOOLCHAIN_PROBE_BINARIES, toolchainCapabilities } from '@kinu.run/core';

interface WhichFrame {
  id: string;
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
      { id: 'which-probe', method: 'which', params: [[...names]] },
      { send: (data: string) => frames.push(JSON.parse(data)) },
      {},
    );
  } finally {
    process.env.PATH = previous;
  }

  return v.parse(whichResult, frames[0]).result.present;
}

function withPathDir<T>(build: (dir: string) => void, fn: (dir: string) => T): T {
  const dir = scratchDir('scratch-path-parity');

  build(dir);

  return fn(dir);
}

const daemonFinds = (dir: string): string[] => daemonResolves(dir, TOOLCHAIN_PROBE_BINARIES);

function findsNothing(dir: string): void {
  expect(daemonFinds(dir)).toEqual([]);
}

describe('the daemon\'s which', () => {
  test('a real executable resolves', () => {
    withPathDir(
      (dir) => writeFileSync(join(dir, 'node'), '#!/bin/sh\n', { mode: 0o755 }),
      (dir) => { expect(daemonFinds(dir)).toEqual(['node']); },
    );
  });

  test('a directory named like a binary is not a binary', () => {
    withPathDir(
      (dir) => {
        writeFileSync(join(dir, 'node'), '#!/bin/sh\n', { mode: 0o755 });
        mkdirSync(join(dir, 'bun'), { mode: 0o755 });
      },
      (dir) => {
        const d = daemonFinds(dir);
        expect(d).not.toContain('bun');
        expect(toolchainCapabilities(d)).not.toContain('typescript');
        expect(toolchainCapabilities(d)).toEqual(['javascript']);
      },
    );
  });

  test('a non-executable file is not a binary', () => {
    withPathDir(
      (dir) => writeFileSync(join(dir, 'python3'), 'not a program', { mode: 0o644 }),
      findsNothing,
    );
  });

  test('a symlink to an executable resolves', () => {
    withPathDir(
      (dir) => {
        writeFileSync(join(dir, 'real-python'), '#!/bin/sh\n', { mode: 0o755 });
        // A symlinked interpreter: a resolver that does not follow it loses `python` on pyenv/asdf machines.
        symlinkSync(join(dir, 'real-python'), join(dir, 'python3'));
      },
      (dir) => {
        const d = daemonFinds(dir);
        expect(d).toEqual(['python3']);
        expect(toolchainCapabilities(d)).toEqual(['python']);
      },
    );
  });

  test('a dangling symlink is absent', () => {
    withPathDir(
      (dir) => symlinkSync(join(dir, 'gone'), join(dir, 'git')),
      findsNothing,
    );
  });

  test('an empty PATH resolves to nothing, and claims nothing', () => {
    expect(toolchainCapabilities(daemonResolves('/nonexistent-path-parity', TOOLCHAIN_PROBE_BINARIES))).toEqual([]);
  });
});
