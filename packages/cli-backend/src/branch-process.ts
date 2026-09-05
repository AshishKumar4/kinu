/**
 * Branch isolation via child processes for Linux CLI.
 * Each MCTS branch gets its own SQLite file — structural isolation.
 *
 * On CF: subAgent(ExplorationAgent, id) uses Facets (co-located DOs)
 * On Linux: child_process.fork(branch-worker.ts) with its own SQLite DB
 */

import type { BranchExploration, BranchHandle, JsonValue, SpawnBranch, AbortBranch, LLMProviderConfig } from '@kinu.run/core';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import * as v from 'valibot';
import { diagnostics, KinuError } from '@kinu.run/core/obs';
import {
  BRANCH_EXPLORE, BRANCH_READY, BRANCH_REFLECT, BranchReplySchema,
  type BranchCall, type BranchCallReply, type BranchMethod,
} from './branch-protocol';
import type { LocalProviderCredentials } from './model-resolver';

const activeBranches = new Map<string, ChildProcess>();

/**
 * A branch RPC carries NO wall clock any more.
 *
 * It carried core's former per-turn envelope — "an `explore` is a whole agent
 * turn" — and that constant is gone by owner ruling (2026-08-21): no wall
 * clock over a turn, only one LLM call's silence window plus its retries, which
 * lives inside every branch worker's own loop and fails the explore from there.
 *
 * What makes a clock unnecessary is wiring, not patience: the two ways a promise
 * here could hang are both handled at their cause. A child that DIES has its
 * pending RPCs rejected by the exit hook in `call` below (this file previously let
 * them dangle — the clock was silently doing that job too). A child that LIVES but
 * stops answering is bounded from inside its own turns, and its failure arrives as
 * an error message over this same pipe. The residue — a live worker wedged outside
 * every instrumented await — is the same residue every unbounded surface carries
 * under the ruling, disclosed rather than papered over with a number nobody
 * measured.
 *
 * Startup carries no clock either. The wait ends on the worker's ready reply,
 * on its error, or on its exit. A non-zero exit rejects with the code. A zero
 * exit before ready rejects too, because a worker that left without answering
 * never will. The residue — a live child that never sends ready — is the same
 * residue as above.
 */

interface PendingCall {
  readonly method: BranchMethod;
  readonly resolve: (reply: BranchCallReply) => void;
  readonly reject: (reason: Error) => void;
}

export interface BranchSpawnerConfig {
  /** The parent's default endpoint for bare ids — null when nothing derives
   *  one. The child then resolves explicit specs through its own registry and
   *  has no default, exactly like the parent. */
  llm: LLMProviderConfig | null;
  providerCredentials?: LocalProviderCredentials;
  codexConfigPath?: string;
}

export interface BranchSpawner {
  spawn: SpawnBranch;
  abort: AbortBranch;
}

/**
 * `basePath` is the agent database's path with `.db` removed — the directory a
 * branch's own store goes next to. NULL when this runtime has no such
 * directory: an in-memory agent database is a SQLite sentinel, not a path, and
 * a branch child process needs a real file to open (`KINU_PARENT_DB` below).
 * Joining onto the sentinel is what created a literal `:memory:/branches`
 * directory in the primary checkout and 15 worktrees — and an empty directory
 * is invisible to `git status`, which is why sixteen "clean" trees held one.
 */
export function createBranchSpawner(
  basePath: string | null,
  config: BranchSpawnerConfig,
): BranchSpawner {
  const branchRoot = basePath === null ? null : `${basePath}/branches`;

  const spawn: SpawnBranch = async (branchId: string): Promise<BranchHandle> => {
    if (branchRoot === null || basePath === null) {
      throw new Error(
        'Branch isolation needs a file-backed agent database: each branch opens its own '
        + 'SQLite store beside it and reads the parent\'s. This runtime\'s database is '
        + 'in-memory, so there is nowhere to put one.',
      );
    }
    // Created HERE, by the first branch that needs somewhere to put its
    // database — not when the spawner is built. Building one is what every
    // `createCLIRuntime` does, MCTS or not, so the eager mkdir wrote a
    // directory per runtime: measured 107 new `/tmp/kinu-test-<n>/branches`
    // from one `bun test packages/cli-backend/` run, none of them ever used and
    // none of them removed.
    mkdirSync(branchRoot, { recursive: true });
    const dbPath = `${branchRoot}/${branchId}.db`;

    // Locate the worker script relative to this file
    const workerPath = join(dirname(fileURLToPath(import.meta.url)), 'branch-worker.ts');

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      KINU_LLM_NAME: config.llm?.name ?? '',
      KINU_BASE_URL: config.llm?.baseURL ?? '',
      KINU_AUTH: config.llm?.headers.Authorization ?? config.llm?.headers.authorization ?? '',
      KINU_MODEL: config.llm?.model ?? '',
      KINU_LLM_HEADERS: JSON.stringify(config.llm?.headers ?? {}),
      KINU_PROVIDER_CREDENTIALS: JSON.stringify(config.providerCredentials ?? {}),
      KINU_PARENT_DB: `${basePath}.db`,
    };
    if (config.codexConfigPath) env.KINU_CONFIG_PATH = config.codexConfigPath;

    const child = fork(workerPath, [dbPath], {
      stdio: 'pipe',
      // Pass LLM credentials through env vars so the child can initialize its LLM
      env,
      // No execArgv needed — when running under bun, fork() inherits bun's runtime
    });
    activeBranches.set(branchId, child);
    let nextId = 1;
    const pending = new Map<number, PendingCall>();
    const startup = Promise.withResolvers<void>();
    const failEveryCall = (error: Error): void => {
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear();
    };

    // The one listener on this child. Every inbound message parses against
    // the shared reply schema. Ready settles startup; a call reply settles
    // exactly the wait with its id.
    const onMessage = (raw: JsonValue): void => {
      const parsed = v.safeParse(BranchReplySchema, raw);
      if (!parsed.success) {
        diagnostics.failure('branch.reply_malformed', new KinuError(
          'bad_input',
          `branch worker sent a reply outside the protocol: ${parsed.issues.map((issue) => issue.message).join('; ')}`,
        ));
        failEveryCall(new Error('Branch worker sent a malformed reply'));
        return;
      }
      const reply = parsed.output;
      if (reply.method === BRANCH_READY) {
        startup.resolve();
        return;
      }
      const waiter = pending.get(reply.id);
      if (!waiter) {
        diagnostics.event('branch.reply_unmatched', { id: reply.id, method: reply.method });
        return;
      }
      pending.delete(reply.id);
      waiter.resolve(reply);
    };
    child.on('message', onMessage);
    // `error` fires for a spawn that failed and for a send the closed channel
    // refused; either way nothing pending can be answered. Settling an
    // already-settled startup is a no-op, so one listener covers the child's
    // whole life.
    child.on('error', (error) => {
      startup.reject(error);
      failEveryCall(error);
    });
    // A DEAD CHILD ENDS ITS PENDING RPCS. Without this a worker that exits
    // mid-call leaves its caller's promise pending forever — the removed wall
    // clock was silently doing this job, and this is the job: liveness at the
    // cause, not timekeeping.
    child.once('exit', (code) => {
      child.off('message', onMessage);
      activeBranches.delete(branchId);
      disposeBranchFiles(dbPath);
      startup.reject(code === 0 || code === null
        ? new Error('Branch worker exited before sending ready')
        : new Error(`Branch worker exited with code ${code}`));
      for (const waiter of pending.values()) {
        waiter.reject(new Error(`Branch worker exited before answering ${waiter.method}`));
      }
      pending.clear();
    });

    const call = <M extends BranchMethod>(
      method: M,
      args: Extract<BranchCall, { method: M }>['args'],
    ): Promise<BranchCallReply> => {
      const id = nextId;
      nextId += 1;
      const { promise, resolve, reject } = Promise.withResolvers<BranchCallReply>();
      pending.set(id, { method, resolve, reject });
      child.send({ method, id, args });
      return promise;
    };
    try {
      await startup.promise;
    } catch (error) {
      child.kill('SIGTERM');
      throw error;
    }

    return {
      // The handle still takes tools because BranchHandle names them. They
      // never reach the wire: the worker reads crafted tools from the parent
      // database.
      explore: (history, _tools, languages, mode, siblings = []) =>
        call(BRANCH_EXPLORE, { history, languages: [...languages], mode, siblings: [...siblings] })
          .then((reply) => resultOf(reply, BRANCH_EXPLORE)),
      generateReflection: (task, outcome) =>
        call(BRANCH_REFLECT, outcome ? { task, outcome } : { task })
          .then((reply) => resultOf(reply, BRANCH_REFLECT)),
    };
  };

  const abort: AbortBranch = async (branchId: string, _reason?: string) => {
    const child = activeBranches.get(branchId);
    if (child) {
      child.kill('SIGTERM');
      activeBranches.delete(branchId);
    }
  };

  return { spawn, abort };
}

/** The branch database is live-worker trace state, including every possible
 * SQLite sidecar. No post-exit reader exists, so its worker's exit releases it. */
function disposeBranchFiles(dbPath: string): void {
  for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(dbPath + suffix, { force: true });
}

/**
 * What a call reply carries for the method that was called. Presence, not
 * truthiness, decides failure: an error whose message is empty is still a
 * failure, and treating it as success used to surface far away as a
 * TypeError inside the search loop.
 */
function resultOf(reply: BranchCallReply, method: BranchMethod): BranchExploration {
  if ('error' in reply) throw new Error(reply.error || `Branch worker failed ${method} without a message`);
  if (reply.method !== method) throw new Error(`Branch worker answered ${method} with ${reply.method}`);
  return reply.result;
}

