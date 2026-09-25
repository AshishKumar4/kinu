/**
 * Branch isolation via child processes. A branch is a logical actor on the workspace's one database;
 * only the process is isolated, never the store.
 */

import { explorationActorKey, type ActorHandle, type BranchExploration, type BranchHandle, type JsonValue, type SpawnBranch, type AbortBranch, type LLMProviderConfig } from '@kinu.run/core';
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import * as v from 'valibot';
import { diagnostics, KinuError } from '@kinu.run/core/obs';
import {
  BRANCH_EXPLORE, BRANCH_READY, BRANCH_REFLECT, BranchReplySchema,
  type BranchCall, type BranchCallReply, type BranchMethod,
} from '@kinu.run/core';
import type { LocalProviderCredentials } from './model-resolver';
import { registerLocalActor, localActorProcessBootstrap, retireLocalActor } from './actor-identity';

export const BRANCH_CREDENTIAL_ENV = ['KINU_AUTH', 'KINU_LLM_HEADERS', 'KINU_PROVIDER_CREDENTIALS'] as const;

/**
 * No wall clock on branch RPCs or startup (owner ruling 2026-08-21): a dead child rejects pending
 * calls via the exit hook, and a live one bounds its own LLM calls and reports errors over the pipe.
 */

interface PendingCall {
  readonly method: BranchMethod;
  readonly resolve: (reply: BranchCallReply) => void;
  readonly reject: (reason: Error) => void;
}

interface BranchSpawnerConfig {
  readonly parent: ActorHandle;
  /** The parent's default endpoint for bare ids, or null. */
  llm: LLMProviderConfig | null;
  providerCredentials?: LocalProviderCredentials;
  oauthConfigPath?: string;
}

interface BranchSpawner {
  spawn: SpawnBranch;
  abort: AbortBranch;
}

/** The workspace database the branch process opens; null for an in-memory database no other process can reach. */
export function createBranchSpawner(
  rootDbPath: string | null,
  config: BranchSpawnerConfig,
): BranchSpawner {
  const activeBranches = new Map<string, ChildProcess>();

  const spawn: SpawnBranch = async (branchId: string): Promise<BranchHandle> => {
    if (rootDbPath === null) {
      throw new Error(
        'Branch isolation needs a file-backed agent database: a branch runs in its own '
        + 'process and binds its actor row over the workspace database. This runtime\'s '
        + 'database is in-memory, so no second process can reach it.',
      );
    }

    const binding = registerLocalActor(config.parent, { name: explorationActorKey(branchId), creationId: branchId, kind: 'branch', lifetime: 'task' });

    const workerPath = join(dirname(fileURLToPath(import.meta.url)), 'branch-worker.ts');

    const credentials: Record<(typeof BRANCH_CREDENTIAL_ENV)[number], string> = {
      KINU_AUTH: config.llm?.headers.Authorization ?? config.llm?.headers.authorization ?? '',
      KINU_LLM_HEADERS: JSON.stringify(config.llm?.headers ?? {}),
      KINU_PROVIDER_CREDENTIALS: JSON.stringify(config.providerCredentials ?? {}),
    };

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...credentials,
      KINU_LLM_NAME: config.llm?.name ?? '',
      KINU_BASE_URL: config.llm?.baseURL ?? '',
      KINU_MODEL: config.llm?.model ?? '',
      KINU_ROOT_DB: rootDbPath,
      KINU_ACTOR_BOOTSTRAP: JSON.stringify(localActorProcessBootstrap(config.parent, binding)),
    };

    if (config.oauthConfigPath) env.KINU_CONFIG_PATH = config.oauthConfigPath;

    const child = fork(workerPath, [], {
      stdio: 'pipe',
      env,
      // No execArgv: under bun, fork() inherits bun's runtime.
    });

    activeBranches.set(branchId, child);
    const exited = Promise.withResolvers<void>();
    let nextId = 1;
    const pending = new Map<number, PendingCall>();
    const startup = Promise.withResolvers<void>();

    const failEveryCall = (error: Error): void => {
      for (const waiter of pending.values()) waiter.reject(error);
      pending.clear();
    };

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
    // `error` covers both a failed spawn and a send the closed channel refused.
    child.on('error', (error) => {
      startup.reject(error);
      failEveryCall(error);
    });
    // A dead child ends its pending RPCs; without this a mid-call exit hangs the caller forever.
    child.once('exit', (code) => {
      child.off('message', onMessage);

      if (activeBranches.get(branchId) === child) activeBranches.delete(branchId);
      exited.resolve();
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

    // Retiring the actor row and ending the process are one idempotent teardown.
    const teardown = async () => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      await exited.promise;
    };

    try {
      await startup.promise;
    } catch (error) {
      await retireLocalActor(config.parent, binding.name, binding.reference, teardown);
      throw error;
    }

    return {
      release: () => retireLocalActor(config.parent, binding.name, binding.reference, teardown),
      // Crafted tools never cross the wire; the worker reads them from the shared database.
      explore: (request) =>
        call(BRANCH_EXPLORE, {
          history: request.priorHistory,
          languages: [...request.languages],
          mode: request.mode,
          siblings: [...request.siblings ?? []],
        }).then((reply) => resultOf(reply, BRANCH_EXPLORE)),
      generateReflection: (task, outcome) =>
        call(BRANCH_REFLECT, outcome ? { task, outcome } : { task })
          .then((reply) => resultOf(reply, BRANCH_REFLECT)),
    };
  };

  const abort: AbortBranch = async (branchId: string, _reason?: string) => {
    const child = activeBranches.get(branchId);

    if (child) {
      child.kill('SIGTERM');

      if (activeBranches.get(branchId) === child) activeBranches.delete(branchId);
    }
  };

  return { spawn, abort };
}

/** Presence, not truthiness, decides failure: an empty error message is still a failure. */
function resultOf(reply: BranchCallReply, method: BranchMethod): BranchExploration {
  if ('error' in reply) throw new Error(reply.error || `Branch worker failed ${method} without a message`);

  if (reply.method !== method) throw new Error(`Branch worker answered ${method} with ${reply.method}`);

  return reply.result;
}

