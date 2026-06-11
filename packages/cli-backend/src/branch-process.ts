/**
 * Branch isolation via child processes for Linux CLI.
 * Each MCTS branch gets its own SQLite file — structural isolation.
 *
 * On CF: subAgent(ExplorationAgent, id) uses Facets (co-located DOs)
 * On Linux: child_process.fork(branch-worker.ts) with its own SQLite DB
 */

import type { BranchHandle, SpawnBranch, AbortBranch } from '@proteus/core';
import type { CraftedTool, LLMProviderConfig } from '@proteus/core';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import type { LocalProviderCredentials } from './model-resolver.js';

const activeBranches = new Map<string, ChildProcess>();

export interface BranchSpawnerConfig {
  llm: LLMProviderConfig;
  providerCredentials?: LocalProviderCredentials;
  codexConfigPath?: string;
}

export function createBranchSpawner(basePath: string, config: BranchSpawnerConfig): { spawn: SpawnBranch; abort: AbortBranch } {
  mkdirSync(`${basePath}/branches`, { recursive: true });

  const spawn: SpawnBranch = async (branchId: string): Promise<BranchHandle> => {
    const dbPath = `${basePath}/branches/${branchId}.db`;

    // Locate the worker script relative to this file
    const workerPath = join(dirname(fileURLToPath(import.meta.url)), 'branch-worker.ts');

    const child = fork(workerPath, [dbPath], {
      stdio: 'pipe',
      // Pass LLM credentials through env vars so the child can initialize its LLM
      env: {
        ...process.env,
        PROTEUS_LLM_NAME: config.llm.name,
        PROTEUS_BASE_URL: config.llm.baseURL,
        PROTEUS_AUTH: config.llm.headers.Authorization ?? config.llm.headers.authorization ?? '',
        PROTEUS_MODEL: config.llm.model,
        PROTEUS_LLM_HEADERS: JSON.stringify(config.llm.headers),
        PROTEUS_PROVIDER_CREDENTIALS: JSON.stringify(branchSafeCredentials(config.providerCredentials)),
        ...(config.codexConfigPath ? { PROTEUS_CONFIG_PATH: config.codexConfigPath } : {}),
        PROTEUS_PARENT_DB: `${basePath}.db`, // Parent DB path for loading crafted tools
      },
      // No execArgv needed — when running under bun, fork() inherits bun's runtime
    });
    activeBranches.set(branchId, child);
    child.once('exit', () => {
      activeBranches.delete(branchId);
    });

    const rpc = <T>(method: string, args: unknown): Promise<T> =>
      new Promise((resolve, reject) => {
        const timeoutMs = 120_000; // 2 minutes per exploration
        const timeout = setTimeout(() => {
          child.off('message', handler);
          reject(new Error(`Branch RPC timeout: ${method}`));
        }, timeoutMs);

        const handler = (msg: { method: string; result?: T; error?: string }) => {
          if (msg.method === method) {
            clearTimeout(timeout);
            child.off('message', handler);
            if (msg.error) reject(new Error(msg.error));
            else resolve(msg.result as T);
          }
        };
        child.on('message', handler);
        child.send({ method, args });
      });

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
      explore: (history: Array<{ role: string; content: string }>, tools: CraftedTool[]) =>
        rpc('explore', { history, tools }),
      generateReflection: (task: string) => rpc('reflect', { task }),
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
