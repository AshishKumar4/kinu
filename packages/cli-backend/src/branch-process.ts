/**
 * Branch isolation via child processes for Linux CLI.
 * Each MCTS branch gets its own SQLite file — structural isolation.
 *
 * On CF: subAgent(ExplorationAgent, id) uses Facets (co-located DOs)
 * On Linux: child_process.fork(branch-worker.ts) with its own SQLite DB
 */

import type {
  BranchHandle, BranchExploration, BranchReflection, SpawnBranch, AbortBranch,
} from '@proteus/core';
import type { CraftedTool, LLMProviderConfig, WorkMode } from '@proteus/core';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import type { LocalProviderCredentials } from './model-resolver';

const activeBranches = new Map<string, ChildProcess>();

/**
 * Wall clock on ONE branch RPC — an `explore` is a whole agent turn, not a single
 * completion.
 *
 * It was 120_000, commented "2 minutes per exploration", and that is under the
 * work. Measured against @cf/deepseek-ai/deepseek-v4-pro-0813 in one eval-tier
 * run: single turns of 151s and 294s, a five-turn conversation of 509s, and eight
 * algorithmic challenges averaging 92s each. So on the default model EVERY rollout
 * hit this ceiling — `Branch RPC timeout: explore` three times out of three — and
 * the consequence is not a visible error. The engine scores a failed branch 0
 * (mcts/engine.ts:351), every node keeps the DDL's `value = 0`, and `converge`
 * then correctly refuses to crown a winner over a zero-signal tree and abandons
 * it (mcts/convergence.ts:96-113). A CLI search therefore returned no winner and
 * said only that nothing scored, which is why this was invisible until a driven
 * eval wired `onProgress` and read the branch failures.
 *
 * 600_000 clears the longest turn measured here by roughly 2x. It stays a BOUND
 * rather than becoming unbounded, because the judge seam documents the failure it
 * prevents: an upstream that accepts a request and never answers leaves a promise
 * pending inside a background fiber that carries no wall clock, and the stall is
 * permanent (mcts/evaluation.ts DEFAULT_JUDGE_CALL_TIMEOUT_MS). It also sits under
 * the 900s ceiling the live suites give a search, so a stuck branch surfaces as a
 * named branch failure rather than as the test being killed with no account.
 */
export const BRANCH_RPC_TIMEOUT_MS = 600_000;

export interface BranchSpawnerConfig {
  llm: LLMProviderConfig;
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
 * a branch child process needs a real file to open (`PROTEUS_PARENT_DB` below).
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
    // directory per runtime: measured 107 new `/tmp/proteus-test-<n>/branches`
    // from one `bun test packages/cli-backend/` run, none of them ever used and
    // none of them removed.
    mkdirSync(branchRoot, { recursive: true });
    const dbPath = `${branchRoot}/${branchId}.db`;

    // Locate the worker script relative to this file
    const workerPath = join(dirname(fileURLToPath(import.meta.url)), 'branch-worker.ts');

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      PROTEUS_LLM_NAME: config.llm.name,
      PROTEUS_BASE_URL: config.llm.baseURL,
      PROTEUS_AUTH: config.llm.headers.Authorization ?? config.llm.headers.authorization ?? '',
      PROTEUS_MODEL: config.llm.model,
      PROTEUS_LLM_HEADERS: JSON.stringify(config.llm.headers),
      PROTEUS_PROVIDER_CREDENTIALS: JSON.stringify(branchSafeCredentials(config.providerCredentials)),
      PROTEUS_PARENT_DB: `${basePath}.db`,
    };
    if (config.codexConfigPath) env.PROTEUS_CONFIG_PATH = config.codexConfigPath;

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
      const timeout = setTimeout(() => {
        child.off('message', handler);
        reject(new Error(`Branch RPC timeout: ${method}`));
      }, BRANCH_RPC_TIMEOUT_MS);

      const handler = (msg: { method: string; result?: T; error?: string }) => {
        if (msg.method === method) {
          clearTimeout(timeout);
          child.off('message', handler);
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
