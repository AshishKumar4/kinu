// agent.* codemode provider — the agent's self-direction namespace.
import { describe, test, expect } from "bun:test";
import { Database } from "bun:sqlite";
import * as v from "valibot";
import { MissionGovernor } from "../src/mission-budget";
import { createAgentSelfProvider, type AgentSelfHost } from "../src/tools/agent-self";
import type { BackgroundJob } from "../src/jobs/store";
import { makeExecRaw, makeSql } from "./helpers";

const RunningJobReadSchema = v.object({
  id: v.string(),
  kind: v.string(),
  status: v.literal("running"),
  note: v.string(),
});

const ScheduledBudgetSchema = v.object({
  budget: v.object({
    label: v.string(),
    limits: v.object({ usd: v.number() }),
    spent: v.object({ tokens: v.number() }),
  }),
});

/** A real governor over in-memory SQLite — the ledger is the subject here, so
 *  stubbing it would test nothing. */
function realGovernor(): MissionGovernor {
  const db = new Database(":memory:");
  return new MissionGovernor({
    storage: {
      sql: makeSql(db),
      execRaw: makeExecRaw(db),
    },
  });
}

function fakeHost(over: Partial<AgentSelfHost> = {}): AgentSelfHost & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    proposeCurriculumTasks: async (count) => {
      calls.push(`propose:${count}`);
      return [{
        id: "t1", task: "task", rationale: "rationale", predictedSuccess: 0.5,
        targetsSkills: [], proposedAt: 1, status: "pending",
      }];
    },
    listCurriculumTasks: async (status) => { calls.push(`list:${status}`); return []; },
    setCurriculumTaskStatus: async (id, status) => { calls.push(`set:${id}:${status}`); return { ok: true }; },
    proposeScaffold: async (rationale, code, baseVersion) => { calls.push(`scaffold:${rationale.length}:${code.length}:${baseVersion ?? 'live'}`); return { ok: true, version: 2 }; },
    listScaffoldVersions: async (limit) => {
      calls.push(`archive:${limit ?? 'all'}`);
      return [{
        version: 0, written_at: 1, rationale: "initial", status: "current",
        parent_version: null, trials: 0, wins: 0, losses: 0, ties: 0, win_rate: null,
      }];
    },
    createTimerTrigger: async (opts) => { calls.push(`timer:${opts.cron ?? opts.atMs}:${opts.missionLabel ?? "uncapped"}`); return { id: "trg1", kind: opts.cron ? "timer_cron" : "timer_oneshot", nextFireAt: 123 }; },
    budget: realGovernor(),
    cancelTrigger: async (id) => { calls.push(`cancel:${id}`); return { ok: true, changed: true }; },
    getReplayEvals: async (limit) => {
      calls.push(`replay:${limit ?? 'all'}`);
      return [{
        id: "rpl-1", ranAt: 1, sampleSize: 1, acceptedCount: 1, negativeCount: 0,
        meanScore: 0.75, loss: 0.25, interval: { mean: 0.75, lo: 0.5, hi: 1, n: 1 },
        scaffoldVersion: 0, results: [],
      }];
    },
    armCompactNow: () => { calls.push("compactNow"); },
    jobResult: async (id) => { calls.push(`jobResult:${id}`); return null; },
    listBackgroundJobs: async (limit) => { calls.push(`jobs:${limit ?? 'all'}`); return []; },
    ...over,
  };
}

describe("createAgentSelfProvider — shape", () => {
  test("is a well-formed CodemodeProvider", () => {
    const p = createAgentSelfProvider(fakeHost());
    expect(p.name).toBe("agent");
    expect(p.positionalArgs).toBe(true);
    expect(p.types).toContain("agent.schedule".replace("agent.", "")); // declares schedule
    for (const name of ["proposeCurriculum", "listCurriculum", "acceptCurriculumTask", "proposeScaffold", "scaffoldVersions", "schedule", "cancelSchedule", "compactNow"]) {
      const descriptor = p.tools[name];
      if (!descriptor) throw new Error(`missing agent.${name}`);
      expect(descriptor.execute).toBeFunction();
      expect(descriptor.description.length).toBeGreaterThan(0);
    }
  });
});

describe("createAgentSelfProvider — delegation + validation", () => {
  test("curriculum tools call through with the right args", async () => {
    const host = fakeHost();
    const p = createAgentSelfProvider(host);
    await p.tools.proposeCurriculum.execute(3);
    await p.tools.listCurriculum.execute("pending");
    await p.tools.acceptCurriculumTask.execute("t1");
    expect(host.calls).toEqual(["propose:3", "list:pending", "set:t1:accepted"]);
  });

  test("proposeScaffold delegates rationale + code to the host pipeline", async () => {
    const host = fakeHost();
    const p = createAgentSelfProvider(host);
    const rationale = "Stream answers directly instead of buffering — observed across the last five sessions.";
    const code = "async function* run(rt, task) { await host.defaultInference(); }";
    const r = await p.tools.proposeScaffold.execute(rationale, code);
    expect(r).toEqual({ ok: true, version: 2 });
    expect(host.calls).toEqual([`scaffold:${rationale.length}:${code.length}:live`]);
  });

  test("proposeScaffold passes an archive baseVersion through (DGM branch)", async () => {
    const host = fakeHost();
    const p = createAgentSelfProvider(host);
    const rationale = "Revive the branching-heads stepping stone from v1 with a tighter merge step.";
    const code = "async function* run(rt, task) { await host.defaultInference(); }";
    const r = await p.tools.proposeScaffold.execute(rationale, code, 1);
    expect(r).toEqual({ ok: true, version: 2 });
    expect(host.calls).toEqual([`scaffold:${rationale.length}:${code.length}:1`]);
  });

  test("proposeScaffold rejects missing rationale/code or a bad baseVersion without delegating", async () => {
    const host = fakeHost();
    const p = createAgentSelfProvider(host);
    expect(await p.tools.proposeScaffold.execute("", "code")).toEqual(
      { error: expect.stringContaining("rationale must be a non-empty string") });
    expect(await p.tools.proposeScaffold.execute("a rationale", 42)).toEqual(
      { error: expect.stringContaining("code must be a non-empty string") });
    expect(await p.tools.proposeScaffold.execute("a rationale", "code", -1)).toEqual(
      { error: expect.stringContaining("baseVersion must be a non-negative integer") });
    expect(await p.tools.proposeScaffold.execute("a rationale", "code", 1.5)).toEqual(
      { error: expect.stringContaining("baseVersion must be a non-negative integer") });
    expect(host.calls).toEqual([]);
  });

  test("scaffoldVersions exposes the archive read-only via the host", async () => {
    const host = fakeHost();
    const p = createAgentSelfProvider(host);
    const r = await p.tools.scaffoldVersions.execute(10);
    expect(r).toMatchObject([{ version: 0, status: "current" }]);
    expect(host.calls).toEqual(["archive:10"]);
  });

  test("replayEvals exposes the loss curve read-only via the host", async () => {
    const host = fakeHost();
    const p = createAgentSelfProvider(host);
    const r = await p.tools.replayEvals.execute(5);
    expect(r).toMatchObject([{ id: "rpl-1", loss: 0.25 }]);
    expect(host.calls).toEqual(["replay:5"]);
    expect(p.types).toContain("replayEvals");
  });

  test("jobResult on a SETTLED job passes the row through unchanged — the result is there to read", async () => {
    const settled: BackgroundJob = {
      id: "bgjob-1", kind: "run", label: null, workMode: "build", status: "completed",
      result: '"the output"', error: null, createdAt: 1, settledAt: 2, epoch: 0, resumeAttempts: 0,
      retriedBy: null,
      attemptStartedAt: 1,
    };
    const host = fakeHost({ jobResult: async (id) => { host.calls.push(`jobResult:${id}`); return settled; } });
    const p = createAgentSelfProvider(host);
    expect(await p.tools.jobResult.execute("bgjob-1")).toEqual(settled);
  });

  test("jobResult on a job still RUNNING returns a note instead of an empty poll — no loop to spin on", async () => {
    // The mechanism defect B's fix rests on: a bare {status:'running'} read
    // invites another read a moment later (that is what a poll loop IS). The
    // shaped read states the wake contract instead, so there is nothing to gain
    // by reading again.
    const running: BackgroundJob = {
      id: "bgjob-2", kind: "agents", label: null, workMode: "build", status: "running",
      result: null, error: null, createdAt: 1, settledAt: null, epoch: 0, resumeAttempts: 0,
      retriedBy: null,
      attemptStartedAt: 1,
    };
    const host = fakeHost({ jobResult: async () => running });
    const p = createAgentSelfProvider(host);
    const r = v.parse(RunningJobReadSchema, await p.tools.jobResult.execute("bgjob-2"));
    expect(r.status).toBe("running");
    expect(r.id).toBe("bgjob-2");
    expect(r.kind).toBe("agents");
    // No result/error fields to misread as "it returned nothing" — and no
    // invitation to call again.
    expect("result" in r).toBe(false);
    expect("error" in r).toBe(false);
    expect(r.note).toContain("woken");
    expect(r.note).toMatch(/not.*finish sooner|will not make it finish/i);
  });

  test("jobResult on a null (unknown) job passes null through", async () => {
    const host = fakeHost();
    const p = createAgentSelfProvider(host);
    expect(await p.tools.jobResult.execute("no-such-job")).toBeNull();
    expect(host.calls).toEqual(["jobResult:no-such-job"]);
  });

  test("acceptCurriculumTask rejects a non-string id", async () => {
    const host = fakeHost();
    const p = createAgentSelfProvider(host);
    const r = await p.tools.acceptCurriculumTask.execute(42);
    expect(r).toEqual({ error: expect.stringContaining("id must be a non-empty string") });
    expect(host.calls).toEqual([]); // never delegated
  });

  test("schedule requires cron or atMs, and a future atMs", async () => {
    const host = fakeHost();
    const p = createAgentSelfProvider(host);
    expect(await p.tools.schedule.execute({})).toEqual({ error: expect.stringContaining("provide { cron } or { atMs }") });
    expect(await p.tools.schedule.execute({ atMs: 1 })).toEqual({ error: expect.stringContaining("must be in the future") });
    expect(await p.tools.schedule.execute({ cron: "not a cron" })).toEqual({ error: expect.stringContaining("unsupported cron expression") });
    expect(host.calls).toEqual([]);
    const ok = await p.tools.schedule.execute({ cron: "0 12 * * *", label: "daily" });
    expect(ok).toMatchObject({ id: "trg1", kind: "timer_cron" });
    expect(ok).not.toHaveProperty("budget");
    expect(host.calls).toContain("timer:0 12 * * *:uncapped");
  });

  test("a schedule with no budget carries no mission label — the uncapped default", async () => {
    const host = fakeHost();
    const p = createAgentSelfProvider(host);
    await p.tools.schedule.execute({ cron: "0 12 * * *" });
    expect(host.calls).toEqual(["timer:0 12 * * *:uncapped"]);
    expect(await p.tools.budget.execute()).toEqual([]);
  });

  test("a schedule that names a spending limit declares the ledger and hands the trigger its label", async () => {
    const host = fakeHost();
    const p = createAgentSelfProvider(host);
    const out = v.parse(ScheduledBudgetSchema, await p.tools.schedule.execute({
      cron: "0 12 * * *", budget_usd: 5, budget_label: "nightly-sweep",
    }));

    expect(out.budget).toMatchObject({ label: "nightly-sweep", limits: { usd: 5 }, spent: { tokens: 0 } });
    expect(host.calls).toEqual(["timer:0 12 * * *:nightly-sweep"]);
    // The label the trigger carries is the one agent.budget reads back.
    expect(await p.tools.budget.execute("nightly-sweep")).toMatchObject([{ label: "nightly-sweep" }]);
  });

  test("a recurring schedule re-declared under the same label keeps its cumulative spend", async () => {
    const host = fakeHost();
    const p = createAgentSelfProvider(host);
    await p.tools.schedule.execute({ cron: "0 12 * * *", budget_tokens: 1000, budget_label: "nightly" });
    host.budget.activate(["nightly"]);
    host.budget.debit(400);
    await p.tools.schedule.execute({ cron: "0 13 * * *", budget_tokens: 1000, budget_label: "nightly" });
    expect(await p.tools.budget.execute("nightly")).toMatchObject([{ spent: { tokens: 400 } }]);
  });

  test("budget rejects a non-string label without reading anything", async () => {
    const p = createAgentSelfProvider(fakeHost());
    expect(await p.tools.budget.execute(42)).toEqual({ error: expect.stringContaining("label must be a string") });
  });

  test("compactNow arms the ladder's forced rebuild and says where the fold lands", async () => {
    const host = fakeHost();
    const p = createAgentSelfProvider(host);
    expect(await p.tools.compactNow.execute()).toEqual({ armed: true, appliesAt: "next-turn-assembly" });
    // Idempotent from the caller's side: the flag itself is one-shot.
    expect(await p.tools.compactNow.execute()).toEqual({ armed: true, appliesAt: "next-turn-assembly" });
    expect(host.calls).toEqual(["compactNow", "compactNow"]);
    expect(p.types).toContain("compactNow");
  });

  test("compactNow surfaces a host failure as an envelope, not a throw", async () => {
    const p = createAgentSelfProvider(fakeHost({
      armCompactNow: () => { throw new Error("no compaction state"); },
    }));
    expect(await p.tools.compactNow.execute()).toEqual(
      { error: expect.stringContaining("no compaction state") });
  });

  test("error from the host surfaces as an envelope, not a throw", async () => {
    const host = fakeHost({ proposeCurriculumTasks: async () => { throw new Error("boom"); } });
    const p = createAgentSelfProvider(host);
    const r = await p.tools.proposeCurriculum.execute(1);
    expect(r).toEqual({ error: expect.stringContaining("boom") });
  });
});
