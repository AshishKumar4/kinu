/**
 * Host implementation of core's FileCheckpoints seam over core's shadow-git engine (checkpoints/engine.ts), the one the
 * pc-agent daemon runs too (tests/checkpoint-parity.test.ts). Snapshots are parentless commits; the user's own `.git/` and
 * git config are never touched.
 */

import { createHash } from 'node:crypto';
import { execFile, type ExecFileException } from 'node:child_process';
import * as fs from 'node:fs';
import { homedir, devNull, tmpdir } from 'node:os';
import * as path from 'node:path';
import { kinuHome } from './home';
import {
  createCheckpointEngine, DEFAULT_CHECKPOINT_KEEP,
  type CheckpointHost, type CheckpointTurnMeta, type FileCheckpoints,
} from '@kinu.run/core';
import { classify, diagnostics } from '@kinu.run/core/obs';

export interface HostCheckpointsOpts {
  agent: string;
  /** Shadow store root. Default: $KINU_HOME/checkpoints */
  base?: string;
  /** Checkpoints kept per working directory. Default: DEFAULT_CHECKPOINT_KEEP. */
  keep?: number;
  /** git binary. Default 'git'. */
  gitBin?: string;
}

/** git's exit status, or null when it never finished (a signal, an overfull buffer). */
function exitCodeOf(error: ExecFileException | null): number | null {
  if (error === null) return 0;

  return Number.isInteger(error.code) ? Number(error.code) : null;
}

/** This process as the engine reads it. */
function nodeCheckpointHost(): CheckpointHost {
  return {
    fs, path, homedir: homedir(), tmpdir: tmpdir(), devNull, env: process.env,
    sha256: (text) => createHash('sha256').update(text).digest('hex'),
    run: (bin, args, options) => new Promise((resolve) => {
      execFile(bin, [...args], options, (error, stdout, stderr) => {
        resolve({
          code: exitCodeOf(error),
          stdout: String(stdout), stderr: String(stderr), missing: classify({ cause: error }) === 'enoent',
        });
      });
    }),
    now: () => Date.now(),
    log: (message) => { diagnostics.event('checkpoint.snapshot_failed', { message }); },
  };
}

/** The CLI's agent over core's one checkpoint engine (the device daemon runs a generated copy of it). */
export function createHostCheckpoints(opts: HostCheckpointsOpts): FileCheckpoints {
  const engine = createCheckpointEngine(nodeCheckpointHost(), {
    base: opts.base ?? path.join(kinuHome(), 'checkpoints'),
    keep: opts.keep ?? DEFAULT_CHECKPOINT_KEEP,
    gitBin: opts.gitBin ?? 'git',
  });

  let turn: CheckpointTurnMeta | null = null;

  return {
    beginTurn(meta) {
      turn = meta;
    },
    async ensureCheckpoint(dir, reason = 'pre-mutation') {
      const outcome = await engine.ensure({ agent: opts.agent, dir, turn, reason });

      return outcome !== null && 'id' in outcome ? outcome.id : null;
    },
    list: (query = {}) => engine.list(opts.agent, query),
    plan: (dir, id) => engine.plan(opts.agent, dir, id),
    restore: (dir, id) => engine.restore(opts.agent, dir, id),
    status: () => engine.status(),
    workdirForPath: (target) => engine.workdirForPath(target),
  };
}
