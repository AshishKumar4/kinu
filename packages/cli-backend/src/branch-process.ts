/**
 * Branch isolation via child processes for Linux CLI.
 * Each MCTS branch gets its own SQLite file — structural isolation.
 *
 * On CF: subAgent(ExplorationAgent, id) uses Facets (co-located DOs)
 * On Linux: child_process.fork(branch-worker.ts) with its own SQLite DB
 */

import type { BranchHandle, SpawnBranch, AbortBranch } from '@proteus/core';
import type { CraftedTool } from '@proteus/core';
import { fork, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const activeBranches = new Map<string, ChildProcess>();

export function createBranchSpawner(basePath: string): { spawn: SpawnBranch; abort: AbortBranch } {
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
        PROTEUS_BASE_URL: process.env.PROTEUS_BASE_URL ?? '',
        PROTEUS_AUTH: process.env.PROTEUS_AUTH ?? '',
        PROTEUS_MODEL: process.env.PROTEUS_MODEL ?? '@cf/moonshotai/kimi-k2.6',
        PROTEUS_PARENT_DB: `${basePath}.db`, // Parent DB path for loading crafted tools
      },
      // No execArgv needed — when running under bun, fork() inherits bun's runtime
    });
    activeBranches.set(branchId, child);

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
      evaluate: (task: string) => rpc('evaluate', { task }),
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
