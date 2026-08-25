/**
 * The LOCAL target: the in-process `cli-backend` runtime, behind the seam.
 *
 * A THIN WRAP, deliberately. Every line here already existed in
 * `runBehaviourTask` (`tests/evals/harness.ts`) and in the four `*.eval.ts`
 * files' own `beforeAll` blocks, in the same order, with the same guards. This
 * moves that sequence behind {@link AgentEvalTarget} so a suite can be handed
 * either target; it changes nothing about what a local run does. Anything that
 * looks like a policy decision below is a citation of the harness comment that
 * decided it, and those comments are the record of what each step cost to learn.
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
 *   `hostRoot: null`       — the default `laptop` provider is rooted at
 *     `process.cwd()`, and an episode reaches every registered provider through
 *     `execute_tools`. A live run left `scratch-add/{add.js,add.test.js}` in a
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
 *
 * WHY THE PROBE RUNS THE VERIFIER RATHER THAN LOOKING FOR ONE. The seam's
 * contract is the RUNNING property (`VerifierProbe`), because the production
 * defect was a shell that existed and could not run the only registered
 * instrument. Locally the probe is expected to pass; it is executed anyway, so
 * that the two targets answer the same question and the cloud arm's failure is
 * legible as a difference rather than as a cloud-only quirk.
 */
import { Database } from 'bun:sqlite';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { LanguageModel } from 'ai';

import {
  createAgentStores, initWorkspaceSchema, listBackgroundJobs, listForkRuns,
  listRecordObjectives, readExplorationCanvas, SubordinateRosterStore, workspaceSpend,
  type AgentStores, type LLMProviderConfig, type RunEvent, type WorkspaceSpend,
} from '../../packages/core/src/index';
import { createWorkspace } from '../../packages/core/src/identity/index';
import { LocalAgentSession } from '../../packages/cli-backend/src/local-session';
import { openWorkspaceCLI } from '../../packages/cli-backend/src/open';
import {
  makeSqlExec, makeWorkspaceSchemaSql, type CLIRuntime,
} from '../../packages/cli-backend/src/runtime';
import {
  probeVerifier, walkRunEvents,
  type AgentEvalTarget, type EvalSearchLedger, type EvalTargetProbe,
  type EvalTargetWorkspace,
} from '@kinu.run/test-utils';
import { installPreTurnProfile, requireExecutorSurface, requireSandboxedExecutors } from './harness';

/**
 * Rows read per ledger question.
 *
 * These are EXISTENCE questions — "did a search run", "was a node written" —
 * so the bound only has to be above what one episode can produce, and it is far
 * above it. It is also the deployed side's ceiling for the same reads, so both
 * targets count over the same window and a difference between them is a
 * difference in the agent rather than in the reader.
 */
const LEDGER_PAGE = 200;

export interface LocalTargetOptions {
  /** Scratch directory this target owns. Removed by `teardown`. */
  readonly dir: string;
  /** Workspace name. Carried into the store so a record names the subject. */
  readonly workspace: string;
  readonly purpose: string;
  readonly llm: LLMProviderConfig;
  readonly model: LanguageModel;
  /** The arm's evolution setting, not a convenience default: a run whose
   *  evolution was off is not a measurement of evolution. */
  readonly evolution: boolean;
}

/**
 * Open a local workspace and hand back the target over it.
 *
 * Throws rather than returning a degraded target: a target that can be observed
 * before it is usable is a target a suite can read a zero from.
 */
/**
 * A local target, plus the runtime behind it.
 *
 * `runtime` is NOT on {@link AgentEvalTarget} and must not be: a deployed
 * workspace has no in-process runtime to hand out, so a seam member that
 * exposed one would be a member the cloud target cannot honour. It is here
 * because two suites legitimately drive the INNER API — the swarm eval calls
 * `tools.agents.execute` and reads the tool's own return value, the lifecycle
 * suite drives `EvolutionEngine` directly — and neither is expressible over a
 * chat turn. Those arms are local by nature; reaching the runtime through the
 * local factory is how they say so, instead of rebuilding the provisioning
 * sequence beside the seam and drifting from it.
 */
export interface LocalAgentEvalTarget extends AgentEvalTarget {
  readonly runtime: CLIRuntime;
  /** The store the workspace was opened on, for an arm that reads SQL directly. */
  readonly db: Database;
}

export async function provisionLocalTarget(opts: LocalTargetOptions): Promise<LocalAgentEvalTarget> {
  mkdirSync(opts.dir, { recursive: true });
  const dbPath = join(opts.dir, 'agent.db');
  const db = new Database(dbPath);
  db.exec('PRAGMA journal_mode = WAL');

  await createWorkspace(db, { name: opts.workspace, purpose: opts.purpose, llm: opts.llm });
  initWorkspaceSchema(makeWorkspaceSchemaSql(db));
  const { rt } = await openWorkspaceCLI(db, dbPath, { llm: opts.llm, hostRoot: null });

  requireExecutorSurface(opts.workspace, rt);
  requireSandboxedExecutors(opts.workspace, rt);
  installPreTurnProfile(rt, opts.llm);

  return new LocalEvalTarget(db, dbPath, rt, opts);
}

class LocalEvalTarget implements LocalAgentEvalTarget {
  readonly backend = 'local' as const;

  /** The product's own store bundle, built from the one SQL handle exactly as
   *  `LocalAgentSession` builds it (`local-session.ts:624`). Using the shared
   *  factory is what keeps this target's ledger reads the same reads the
   *  shipped agent makes, rather than a second set of queries over the same
   *  tables. */
  private readonly stores: AgentStores;

  constructor(
    readonly db: Database,
    private readonly dbPath: string,
    readonly runtime: CLIRuntime,
    private readonly opts: LocalTargetOptions,
  ) {
    this.stores = createAgentStores(() => this.runtime.storage.sql);
  }

  get describe(): string {
    return `local cli-backend runtime · workspace ${this.opts.workspace} · ${this.dbPath}`;
  }

  get workspace(): string {
    return this.opts.workspace;
  }

  get llm(): LLMProviderConfig {
    return this.opts.llm;
  }

  /**
   * ONE SESSION PER TURN, and `oneShot: true`, which is the harness's contract
   * rather than a convenience: it is the ONLY thing that arms the completion
   * gate (`local-session.ts:1514`), and an interactive declaration made
   * `completion_honesty` structurally unscoreable.
   *
   * `settleBackgroundWork` is awaited because the gate's confirming turn is
   * enqueued AFTER send resolves and runs on the pump. Reading before it settles
   * reports the zero denominator this tier exists to eliminate, from a turn that
   * was merely still running.
   */
  async sendTurn(text: string): Promise<void> {
    const session = new LocalAgentSession({
      rt: this.runtime,
      db: this.db,
      model: this.opts.model,
      onEvent: () => {},
      noAutoEvolve: !this.opts.evolution,
      oneShot: true,
    });
    await session.send(text);
    await session.settleBackgroundWork();
  }

  runEvents(): Promise<readonly RunEvent[]> {
    return Promise.resolve(walkRunEvents(this.stores.eventRecorder));
  }

  spend(): Promise<WorkspaceSpend> {
    return Promise.resolve(workspaceSpend({
      events: this.stores.eventRecorder, sql: this.runtime.storage.sql,
    }));
  }

  async probe(): Promise<EvalTargetProbe> {
    return {
      executors: (this.runtime.executionRouter?.listExecutors() ?? [])
        .map((executor) => ({ name: executor.name, kind: executor.kind })),
      verifier: await probeVerifier(this.workspaceFiles()),
    };
  }

  workspaceFiles(): EvalTargetWorkspace {
    const shell = this.runtime.shell;
    if (!shell) {
      throw new Error(`local target ${this.opts.workspace} has no rt.shell, so a measured task's `
        + 'verifier could not run its harness and every attempt would score zero for a reason '
        + 'that is not about the agent. Open the workspace through openWorkspaceCLI.');
    }
    return {
      vfs: this.runtime.storage.vfs,
      exec: async (command) => {
        const outcome = await shell.exec(command);
        return { stdout: outcome.stdout, exitCode: outcome.exitCode };
      },
    };
  }

  /**
   * The five reads that separate "a search ran" from "a tool returned".
   *
   * These are the reads `agent://SwarmNoopRootCause` used to rule out "the
   * swarm started and died silently" — every one was empty, which is how it
   * established that no node ever spawned. Taken through the product's own read
   * models rather than by counting rows, so the numbers a suite asserts on are
   * the numbers a user is shown, and so the cloud target's five RPCs answer the
   * same five questions.
   */
  searchLedger(): Promise<EvalSearchLedger> {
    const sql = this.runtime.storage.sql;
    return Promise.resolve({
      searchRuns: this.stores.mctsSearchStore.list(LEDGER_PAGE).length,
      forkRuns: listForkRuns(sql, null, LEDGER_PAGE).items.length,
      canvasNodes: readExplorationCanvas(sql, null, LEDGER_PAGE).items.length,
      recordObjectives: listRecordObjectives(sql, null, LEDGER_PAGE).items.length,
      backgroundJobs: listBackgroundJobs(this.stores.jobs, LEDGER_PAGE).length,
    });
  }

  /**
   * Additional agents on the roster, or none.
   *
   * `ensureSchema()` FIRST, and it is not defensive. `workspace_subordinates` is
   * created by this store's own idempotent DDL on first use rather than by
   * `initWorkspaceSchema` — the conformance manifest says so in as many words
   * ("Created by SubordinateRosterStore's own ensureSchema on first read, so it
   * exists on a subordinate that has hired and on one that has not"). So a
   * workspace that has hired nobody has no table, and reading it without this
   * throws `no such table`. A read that throws on an empty table is a read no
   * suite can use as evidence of ABSENCE, which is exactly what a delegation
   * assertion needs it for. Measured: this threw on the seam's own integration
   * test before the call was added.
   */
  roster(): Promise<readonly string[]> {
    const roster = new SubordinateRosterStore(makeSqlExec(this.db), this.runtime.storage.sql);
    roster.ensureSchema();
    return Promise.resolve(roster.list().map((entry) => entry.name).sort());
  }

  teardown(): Promise<void> {
    this.db.close();
    rmSync(this.opts.dir, { recursive: true, force: true });
    return Promise.resolve();
  }
}
