/**
 * Nimbus long-running processes: `startProcess` answers the id every other process member takes, and a handle that
 * cannot start one says so. Each process it starts is a job of the actor's from its start: running while it runs, held
 * in a `bg:` fiber, ended with it, and told to the actor when it ends or a restart loses it. Staging rc28, 2026-10-20:
 * a process `startProcess` started from eval had no job, so nothing held the workspace awake for it, and it stopped with
 * the idle workspace after 4 of 180 iterations, unrecorded and untold.
 */
import { Database } from "bun:sqlite";
import * as v from "valibot";
import { describe, expect, test } from "bun:test";
import {
  BackgroundJobRunner, BackgroundJobStore, createNimbusWorkspaceExecutor, initBackgroundJobsTable, MAX_CONCURRENT_DETACHED_JOBS,
  nimbusSessionFiles, nimbusSessionShell, processRetryTool, type AdoptsJobs, type NimbusStartResult, WORKSPACE_ROOT,
} from "../src/index";
import { retryBackgroundJob } from "../src/read-models/background-jobs";
import type { ProgrammaticTurn } from "../src/types/backend-host";
import type { Schedule } from "../src/types/primitives";
import { sessionFilesOver, type SessionBox } from "@kinu.run/test-utils/vfs";
import { createTestActors, hostDeliveries, NO_JOBS } from "@kinu.run/test-utils";
import { createTestRuntime, makeExecRaw, makeSql } from "./helpers";


function handleWith(start: () => Promise<NimbusStartResult>): SessionBox {
  return {
    ready: async () => {},
    exec: async (command: string) => ({
      command, success: true, stdout: "", stderr: "", exitCode: 0, duration: 0, timestamp: 0,
    }),
    startProcess: start,
    files: sessionFilesOver(),
  };
}

/** The hosted workspace over `box`, composed as cf-backend composes it. */
function workspaceOver(box: SessionBox, runtimeCatalog?: boolean, jobs: AdoptsJobs = NO_JOBS) {
  const { rt } = createTestRuntime();

  return createNimbusWorkspaceExecutor({
    box, runtimeCatalog, jobs,
    inline: { vfs: nimbusSessionFiles(box.files, { home: WORKSPACE_ROOT }), shell: nimbusSessionShell(box, { home: WORKSPACE_ROOT }), craftStore: rt.craftStore },
  });
}

function runningStart(overrides: Partial<NimbusStartResult> = {}): NimbusStartResult {
  return {
    command: "node server.js",
    pid: 3000002,
    process: {
      pid: 3000002, command: "node server.js", argv: ["node", "server.js"], cwd: "/home/main", state: "running",
      exitCode: null, startTime: 1, endTime: null, longRunning: true, attachedTty: false,
    },
    ports: [],
    startedAt: 1_786_641_209_776,
    ...overrides,
  };
}

describe("nimbus processes — one id from start to stop", () => {
  test("the id startProcess answers is the one logs, listProcesses and stopProcess take", async () => {
    const { box: ending, killed } = endingBox();

    const box: SessionBox = {
      ...ending,
      processes: {
        ...ending.processes,
        list: async () => [runningStart().process, { ...runningStart().process, pid: 9, command: "ls", longRunning: false, state: "exited" }],
        logs: async (pid: number) => ({ pid, chunks: [], text: `server ${String(pid)} ready\n` }),
      },
    };

    const nimbus = workspaceOver(box, undefined, actorJobs().runner);
    const started = await nimbus.tools.startProcess.execute("node server.js");

    expect(started).toEqual({ processId: "3000002", jobId: expect.stringMatching(/^bgjob-/u) });
    expect(await nimbus.tools.logs?.execute("3000002")).toBe("server 3000002 ready\n");

    // Only what startProcess started is listed: a finished exec is no process to stop.
    expect(await nimbus.tools.listProcesses?.execute()).toEqual([{ processId: "3000002", pid: 3000002, status: "running", command: "node server.js" }]);
    expect(await nimbus.tools.stopProcess?.execute("3000002")).toEqual({ stopped: true });
    expect(killed).toEqual([3000002]);
  });

  test("a handle without startProcess names the class on the first attempt", async () => {
    const box = handleWith(async () => runningStart());
    Reflect.deleteProperty(box, "startProcess");
    const nimbus = workspaceOver(box);
    const out = await nimbus.tools.startProcess?.execute('node server.js');
    // `unsupported`, not `unavailable`: retrying cannot add a method to this handle.
    expect(out).toEqual({
      success: false,
      reason: "unsupported",
      error: "Nimbus SDK handle does not expose startProcess",
    });
  });
});

/** What `startProcess` answers once a job took its process. */
const StartedJobSchema = v.object({ processId: v.string(), jobId: v.string() });

/** One actor's job ledger over its own database: the runner production gives each actor, its fiber run inline and named,
 *  its wakes the turns it queues. `db` lets a second runner (a restart) open the same rows. */
function actorJobs(db = new Database(":memory:")) {
  initBackgroundJobsTable(makeExecRaw(db));
  const sql = makeSql(db);
  const store = new BackgroundJobStore(sql, createTestActors(sql, makeExecRaw(db)).main);
  const lanes: string[] = [];
  const runs: Promise<unknown>[] = [];
  const woke: ProgrammaticTurn[] = [];

  const fiber: Schedule["fiber"] = async (name, fn) => {
    lanes.push(name);
    const run = fn({ stash: () => {}, snapshot: null });
    runs.push(run);

    return await run;
  };

  const host = {
    broadcast: () => {},
    enqueueTurn: async (turn: ProgrammaticTurn) => {
      woke.push(turn);

      return { status: "queued" as const };
    },
  };

  const runner = new BackgroundJobRunner({ store, fiber, inbox: hostDeliveries(host).signals });

  return { db, runner, store, lanes, woke, settled: () => Promise.all(runs) };
}

/** A box whose one process ends when the test ends it, with the exit code it is given; a kill ends it too. */
function endingBox() {
  const end = Promise.withResolvers<number>();
  const killed: number[] = [];
  const execIds: (string | undefined)[] = [];

  const box: SessionBox = {
    ...handleWith(async () => runningStart()),
    startProcess: async (_command, options) => {
      execIds.push(options?.execId);

      return runningStart();
    },
    processes: {
      kill: async (pid: number) => {
        killed.push(pid);
        end.resolve(143);

        return { ok: true, pid };
      },
      whenEnded: async () => await end.promise,
    },
  };

  return { box, killed, execIds, end: (code: number) => { end.resolve(code); } };
}

describe("nimbus processes — each one a job of the actor's from its start", () => {
  test("the process runs as a job, held in its lane, and its end completes the job and wakes the actor", async () => {
    const jobs = actorJobs();
    const { box, end, execIds } = endingBox();
    const started = await workspaceOver(box, undefined, jobs.runner).tools.startProcess.execute("node server.js");

    expect(started).toEqual({ processId: "3000002", jobId: expect.stringMatching(/^bgjob-/u) });
    const { jobId } = v.parse(StartedJobSchema, started);

    // Started under its job's id, as a job's commands are: a port it serves is its job's.
    expect(execIds).toEqual([jobId]);

    expect(jobs.store.get(jobId)).toMatchObject({ kind: "startProcess", status: "running", label: "Workspace: node server.js" });
    expect(jobs.lanes).toEqual(["bg:startProcess"]);
    expect(jobs.woke).toEqual([]);

    end(0);
    await jobs.settled();

    expect(jobs.store.get(jobId)).toMatchObject({ status: "completed", result: JSON.stringify({ processId: "3000002", exitCode: 0 }) });
    expect(jobs.woke.map((turn) => turn.text)).toEqual([expect.stringContaining(`Background startProcess job ${jobId} completed`)]);
  });

  test("cancelling its job stops the process", async () => {
    const jobs = actorJobs();
    const { box, killed } = endingBox();
    const { jobId } = v.parse(StartedJobSchema, await workspaceOver(box, undefined, jobs.runner).tools.startProcess.execute("node server.js"));

    expect(await jobs.runner.cancel(jobId)).toBe(true);
    await jobs.settled();

    expect(killed).toEqual([3000002]);
    expect(jobs.store.get(jobId)?.status).toBe("cancelled");
  });

  test("a process no job takes is stopped, and the call says why", async () => {
    const jobs = actorJobs();
    const held = [];

    for (let n = 0; n < MAX_CONCURRENT_DETACHED_JOBS; n++) held.push(jobs.runner.create("shell", { command: "sleep" }, "build", new AbortController()));
    const { box, killed } = endingBox();
    const refused = await workspaceOver(box, undefined, jobs.runner).tools.startProcess.execute("node server.js");

    expect(refused).toMatchObject({ success: false, reason: "cancelled", error: expect.stringContaining("too many jobs already running") });
    expect(killed).toEqual([3000002]);
    expect(jobs.store.list(20).filter((job) => job.kind === "startProcess")).toEqual([]);
    expect(held).toHaveLength(MAX_CONCURRENT_DETACHED_JOBS);
  });

  test("a restart that lost the process fails its job and wakes the actor", async () => {
    const before = actorJobs();
    const { box } = endingBox();
    const { jobId } = v.parse(StartedJobSchema, await workspaceOver(box, undefined, before.runner).tools.startProcess.execute("node server.js"));

    // The restart: a new runner over the same rows, finding the job's lane still stashed running.
    const after = actorJobs(before.db);

    await after.runner.recover({ phase: "running", jobId, kind: "startProcess" });

    expect(after.store.get(jobId)).toMatchObject({ status: "failed", error: expect.stringContaining("the workspace restarted before it finished") });
    expect(after.woke.map((turn) => turn.text)).toEqual([expect.stringContaining(`Background startProcess job ${jobId} failed`)]);
  });

  test("a retry starts its command again as the process of its own job, which the process's end completes", async () => {
    const jobs = actorJobs();
    const first = endingBox();
    const { jobId } = v.parse(StartedJobSchema, await workspaceOver(first.box, undefined, jobs.runner).tools.startProcess.execute("node server.js"));

    first.end(1);
    await jobs.settled();
    const again = endingBox();

    const retried = await retryBackgroundJob({
      jobs: jobs.store, jobRunner: jobs.runner, logActivity: () => {}, rawTools: async () => ({ startProcess: processRetryTool(again.box) }),
    }, jobId);

    expect(retried).toEqual({ ok: true, jobId: expect.stringMatching(/^bgjob-/u) });
    const { jobId: retryId } = v.parse(v.object({ jobId: v.string() }), retried);

    expect(again.execIds).toEqual([retryId]);
    expect(jobs.store.get(jobId)?.retriedBy).toBe(retryId);
    expect(jobs.store.get(retryId)).toMatchObject({ kind: "startProcess", status: "running", label: "Workspace: node server.js" });

    await jobs.runner.cancel(retryId);
    await jobs.settled();

    expect(again.killed).toEqual([3000002]);
    expect(jobs.store.get(retryId)?.status).toBe("cancelled");
  });

  test("a handle that cannot tell when a process ends starts none", async () => {
    let started = 0;

    const box = handleWith(async () => {
      started += 1;

      return runningStart();
    });

    expect(await workspaceOver(box, undefined, actorJobs().runner).tools.startProcess.execute("node server.js")).toEqual({
      success: false, reason: "unsupported", error: "Nimbus SDK handle does not expose a process's end",
    });
    expect(started).toBe(0);
  });
});

describe("nimbus capabilities — declared exactly when they run", () => {
  test("without a runtime source, python and native_binary are not claimed", () => {
    const nimbus = workspaceOver(handleWith(async () => runningStart()));
    expect(nimbus.capabilities.has("python")).toBe(false);
    expect(nimbus.capabilities.has("native_binary")).toBe(false);
    expect(nimbus.capabilities.has("javascript")).toBe(true);
    expect(nimbus.capabilities.has("process_long")).toBe(true);
    expect(nimbus.capabilities.has("net_inbound")).toBe(false);
  });

  test("with the runtime catalog bound, python and native_binary are real and declared", () => {
    const nimbus = workspaceOver(handleWith(async () => runningStart()), true);

    expect(nimbus.capabilities.has("python")).toBe(true);
    expect(nimbus.capabilities.has("native_binary")).toBe(true);
  });
});
