/**
 * Branch isolation via child processes for Linux CLI.
 * Each MCTS branch gets its own SQLite file — structural isolation.
 *
 * On CF: subAgent(ExplorationAgent, id) uses Facets (co-located DOs)
 * On Linux: child_process.fork(branch-worker.ts) with its own SQLite DB
 */

import type {
  BranchHandle, BranchExploration, BranchReflection, SpawnBranch, AbortBranch,
} from '@kinu.run/core';
import type { CraftedTool, LLMProviderConfig, WorkMode } from '@kinu.run/core';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
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
 * pending RPCs rejected by the exit hook in `rpc` below (this file previously let
 * them dangle — the clock was silently doing that job too). A child that LIVES but
 * stops answering is bounded from inside its own turns, and its failure arrives as
 * an error message over this same pipe. The residue — a live worker wedged outside
 * every instrumented await — is the same residue every unbounded surface carries
 * under the ruling, disclosed rather than papered over with a number nobody
 * measured.
 */

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

interface ExploreBranchArgs {
  history: Array<{ role: string; content: string }>;
  tools: CraftedTool[];
  languages: readonly [string, ...string[]];
  mode: WorkMode;
  siblings: readonly string[];
}

interface ReflectBranchArgs {
  task: string;
  /** The environment's verdict on this branch's proposal, when it reached one. */
  outcome?: string;
}

type BranchRpcArgs = ExploreBranchArgs | ReflectBranchArgs;

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
      KINU_PROVIDER_CREDENTIALS: JSON.stringify(branchSafeCredentials(config.providerCredentials)),
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
    child.once('exit', () => {
      activeBranches.delete(branchId);
    });

    const rpc = <T>(method: string, args: BranchRpcArgs): Promise<T> => {
      const { promise, resolve, reject } = Promise.withResolvers<T>();
      let settled = false;
      // A DEAD CHILD ENDS ITS PENDING RPCS. Without this a worker that exits
      // mid-call leaves its caller's promise pending forever — the removed wall
      // clock was silently doing this job, and this is the job: liveness at the
      // cause, not timekeeping.
      const onExit = () => {
        if (settled) return;
        settled = true;
        reject(new Error(`Branch worker exited before answering ${method}`));
      };
      child.once('exit', onExit);
      const handler = (msg: { method: string; result?: T; error?: string }) => {
        if (msg.method === method) {
          child.off('message', handler);
          child.off('exit', onExit);
          settled = true;
          // Presence, not truthiness: an error whose message is empty is
          // still a failure, and treating it as success used to surface far
          // away as a TypeError inside the search loop.
          if (msg.error !== undefined) {
            reject(new Error(msg.error || `Branch worker failed ${method} without a message`));
          } else if (msg.result === undefined) {
            reject(new Error(`Branch worker returned no result for ${method}`));
          } else {
            resolve(msg.result);
          }
        }
      };
      child.on('message', handler);
      child.send({ method, args });
      return promise;
    };

    // Wait for child to signal readiness
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Branch worker startup timeout')), 30_000);
      const handler = (msg: { method: string }) => {
        if (msg.method === 'ready') {
          clearTimeout(timeout);
          child.off('message', handler);
          resolve();
        }
      };
      child.on('message', handler);
      child.on('error', (err) => { clearTimeout(timeout); reject(err); });
      child.on('exit', (code) => {
        if (code !== 0) { clearTimeout(timeout); reject(new Error(`Branch worker exited with code ${code}`)); }
      });
    });

    return {
      explore: (history: Array<{ role: string; content: string }>, tools: CraftedTool[], languages: readonly [string, ...string[]], mode: WorkMode, siblings: readonly string[] = []) =>
        rpc<BranchExploration>('explore', { history, tools, languages, mode, siblings }),
      generateReflection: (task: string, outcome?: string) => {
        const args: ReflectBranchArgs = { task };
        if (outcome) args.outcome = outcome;
        return rpc<BranchReflection>('reflect', args);
      },
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

function branchSafeCredentials(credentials: LocalProviderCredentials | undefined): LocalProviderCredentials {
  if (!credentials) return {};
  const { codexOAuth: _codexOAuth, ...safe } = credentials;
  return safe;
}
