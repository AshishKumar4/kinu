/**
 * Branch isolation via child processes for Linux CLI.
 *
 * A branch is a LOGICAL actor of kind `branch` on the workspace's ONE database
 * — a `workspace_actors` row like every other actor — that happens to run its
 * rollouts in a separate OS process. What a branch needs isolated is the
 * PROCESS (an unbounded LLM loop that must not share this event loop), never
 * the store: an `<agent>/branches/<key>.db` of its own would give one logical
 * actor two state stores and leave the parent unable to read what its own
 * branch had written.
 *
 * On CF: a hosted logical actor of kind `branch` over the workspace's one
 * SQLite (`exploration-hosting.ts`).
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
} from './branch-protocol';
import type { LocalProviderCredentials } from './model-resolver';
import { registerLocalActor, localActorProcessBootstrap, retireLocalActor } from './actor-identity';


/**
 * A branch RPC carries NO wall clock.
 *
 * By owner ruling (2026-08-21): no wall clock over a turn, only one LLM call's
 * silence window plus its retries, which lives inside every branch worker's own
 * loop and fails the explore from there. An `explore` IS a whole agent turn, so
 * a per-turn envelope around this RPC would be a clock over exactly that.
 *
 * What makes a clock unnecessary is wiring, not patience: the two ways a promise
 * here could hang are both handled at their cause. A child that DIES has its
 * pending RPCs rejected by the exit hook in `call` below — that rejection is the
 * hook's job, never a clock's. A child that LIVES but stops answering is bounded
 * from inside its own turns, and its failure arrives as an error message over
 * this same pipe. The residue — a live worker wedged outside every instrumented
 * await — is the same residue every unbounded surface carries under the ruling,
 * disclosed rather than papered over with a number nobody measured.
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
  readonly parent: ActorHandle;
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
 * `rootDbPath` is the workspace's ONE database — the file a branch's own
 * process opens to bind its actor row and write its rollout traces. NULL when
 * this runtime has no such file: an in-memory agent database is a SQLite
 * sentinel rather than a path, and no second process can reach it.
 */
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
      KINU_ROOT_DB: rootDbPath,
      KINU_ACTOR_BOOTSTRAP: JSON.stringify(localActorProcessBootstrap(config.parent, binding)),
    };

    if (config.codexConfigPath) env.KINU_CONFIG_PATH = config.codexConfigPath;

    const child = fork(workerPath, [], {
      stdio: 'pipe',
      // Pass LLM credentials through env vars so the child can initialize its LLM
      env,
      // No execArgv needed — when running under bun, fork() inherits bun's runtime
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

    // The ONLY thing a branch owns outside the workspace's database: its own
    // OS process. Retiring the actor row and ending the process that holds it
    // are one act, so both arms below present the same teardown — and it is
    // idempotent, because a child that already exited leaves `exited` settled.
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
      // The handle retains the parent-defined tools contract. Crafted tools
      // never reach the wire: the worker reads them from the workspace's own
      // database, which is now the database it is already bound to.
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

      if (activeBranches.get(branchId) === child) activeBranches.delete(branchId);
    }
  };

  return { spawn, abort };
}


/**
 * What a call reply carries for the method that was called. Presence, not
 * truthiness, decides failure: an error whose message is empty is still a
 * failure, and treating it as success surfaces far away as a TypeError inside
 * the search loop.
 */
function resultOf(reply: BranchCallReply, method: BranchMethod): BranchExploration {
  if ('error' in reply) throw new Error(reply.error || `Branch worker failed ${method} without a message`);

  if (reply.method !== method) throw new Error(`Branch worker answered ${method} with ${reply.method}`);

  return reply.result;
}

