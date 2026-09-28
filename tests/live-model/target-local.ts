/**
 * The in-process `cli-backend` runtime a live suite drives.
 *
 * A THIN WRAP, deliberately: the provisioning sequence the live suites share,
 * in one order, with the same guards. Anything that looks like a policy
 * decision below is a citation of the harness comment that decided it, and
 * those comments are the record of what each step cost to learn.
 *
 * WHAT IT MUST NOT SKIP, in provisioning order, because each one has a measured
 * failure behind it:
 *
 *   `initWorkspaceSchema` — `createWorkspace` alone leaves the store missing
 *     tables (`head_journal`), which a delegating turn then fails on.
 *   `openWorkspaceCLI`     — `createWorkspace` returns the BIRTH runtime, which
 *     registers no `ExecutorProvider` at all. Measured both ways on one scripted
 *     episode: degraded gave no `craft_cycle` row and `craft_reuse` eligible 0;
 *     opened gave `crafted:["doubleIt"]`, `reused:["doubleIt"]`, eligible 1.
 *     Three flash runs blamed that zero on the corpus.
 *   no `cwd`               — a bound directory makes the workspace shell the
 *     developer's own, and an episode reaches every registered provider
 *     through `eval`. A live run left `scratch-add/{add.js,add.test.js}` in a
 *     worktree root and `report.txt` in the repo root.
 *   `installPreTurnProfile` — `setProfileResolver` has exactly ONE caller in the
 *     product, `LocalAgentSession`'s constructor (`local-session.ts:625`), so a
 *     seam that returns the runtime without it hands back a workspace whose
 *     every routed model lane is dead: `rt.judgeModel` / `rt.fastLlm` /
 *     `rt.advisorLlm` all resolve undefined, their `?? rt.llm` fallback reaches
 *     the reflection lane, and that throws. It cost 11 failures across three
 *     suites on 2026-08-24. Called from `provision` for exactly that reason —
 *     this is the seam's own obligation, not the caller's to remember.
 *   `requireExecutorSurface` / `requireSandboxedExecutors` — before the model is
 *     driven, so a broken runtime costs nothing rather than being discovered
 *     after a paid episode.
 */
import { Database } from 'bun:sqlite';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { initWorkspaceSchema, type LLMProviderConfig } from '../../packages/core/src/index';
import { createWorkspace } from '../../packages/core/src/workspace-birth';
import { openWorkspaceCLI } from '../../packages/cli-backend/src/open';
import { makeWorkspaceSchemaSql, type CLIRuntime } from '../../packages/cli-backend/src/runtime';
import { installPreTurnProfile, requireExecutorSurface, requireSandboxedExecutors } from './harness';

export interface LocalTargetOptions {
  /** Scratch directory this target owns. Removed by `teardown`. */
  readonly dir: string;
  /** Workspace name. Carried into the store so a record names the subject. */
  readonly workspace: string;
  readonly purpose: string;
  readonly llm: LLMProviderConfig;
}

/** An opened workspace: the runtime a suite drives and the store it was opened on. */
export interface LocalTarget {
  readonly runtime: CLIRuntime;
  readonly db: Database;
  /** Close the store and remove the scratch directory. */
  teardown(): void;
}

/**
 * Open a local workspace and hand back the target over it.
 *
 * Throws rather than returning a degraded target: a target that can be observed
 * before it is usable is a target a suite can read a zero from.
 */
export async function provisionLocalTarget(opts: LocalTargetOptions): Promise<LocalTarget> {
  mkdirSync(opts.dir, { recursive: true });
  const dbPath = join(opts.dir, 'agent.db');
  const db = new Database(dbPath);
  db.exec('PRAGMA journal_mode = WAL');

  await createWorkspace(db, { name: opts.workspace, purpose: opts.purpose, llm: opts.llm });
  initWorkspaceSchema(makeWorkspaceSchemaSql(db));
  const { rt } = await openWorkspaceCLI(db, dbPath, { llm: opts.llm });

  requireExecutorSurface(opts.workspace, rt);
  requireSandboxedExecutors(opts.workspace, rt);
  installPreTurnProfile(rt, opts.llm);

  return {
    runtime: rt,
    db,
    teardown: () => {
      db.close();
      rmSync(opts.dir, { recursive: true, force: true });
    },
  };
}
