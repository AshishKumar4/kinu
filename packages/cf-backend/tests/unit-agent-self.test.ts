// agent.* codemode provider — the agent's self-direction namespace.
import { describe, test, expect } from "bun:test";
import { createAgentSelfProvider, type AgentSelfHost } from "../src/agent-self";

function fakeHost(over: Partial<AgentSelfHost> = {}): AgentSelfHost & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    proposeCurriculumTasks: async (count) => { calls.push(`propose:${count}`); return [{ id: "t1" }]; },
    listCurriculumTasks: async (status) => { calls.push(`list:${status}`); return []; },
    setCurriculumTaskStatus: async (id, status) => { calls.push(`set:${id}:${status}`); return { ok: true }; },
    proposeScaffold: async (rationale, code, baseVersion) => { calls.push(`scaffold:${rationale.length}:${code.length}:${baseVersion ?? 'live'}`); return { ok: true, version: 2 }; },
    listScaffoldVersions: async (limit) => { calls.push(`archive:${limit ?? 'all'}`); return [{ version: 0, status: "current" }]; },
    createTimerTrigger: (opts) => { calls.push(`timer:${opts.cron ?? opts.atMs}`); return { id: "trg1", kind: opts.cron ? "timer_cron" : "timer_oneshot", nextFireAt: 123 }; },
    cancelTrigger: async (id) => { calls.push(`cancel:${id}`); return { ok: true, changed: true }; },
    getReplayEvals: async (limit) => { calls.push(`replay:${limit ?? 'all'}`); return [{ id: "rpl-1", loss: 0.25 }]; },
    ...over,
  };
}

describe("createAgentSelfProvider — shape", () => {
  test("is a well-formed CodemodeProvider", () => {
    const p = createAgentSelfProvider(fakeHost());
    expect(p.name).toBe("agent");
    expect(p.positionalArgs).toBe(true);
    expect(p.types).toContain("agent.schedule".replace("agent.", "")); // declares schedule
    for (const name of ["proposeCurriculum", "listCurriculum", "acceptCurriculumTask", "proposeScaffold", "scaffoldVersions", "schedule", "cancelSchedule"]) {
      expect(typeof p.tools[name]?.execute).toBe("function");
      expect(p.tools[name]?.description.length).toBeGreaterThan(0);
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
    expect(r).toEqual([{ version: 0, status: "current" }]);
    expect(host.calls).toEqual(["archive:10"]);
  });

  test("replayEvals exposes the loss curve read-only via the host", async () => {
    const host = fakeHost();
    const p = createAgentSelfProvider(host);
    const r = await p.tools.replayEvals.execute(5);
    expect(r).toEqual([{ id: "rpl-1", loss: 0.25 }]);
    expect(host.calls).toEqual(["replay:5"]);
    expect(p.types).toContain("replayEvals");
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
    expect(host.calls).toContain("timer:0 12 * * *");
  });

  test("error from the host surfaces as an envelope, not a throw", async () => {
    const host = fakeHost({ proposeCurriculumTasks: async () => { throw new Error("boom"); } });
    const p = createAgentSelfProvider(host);
    const r = await p.tools.proposeCurriculum.execute(1);
    expect(r).toEqual({ error: expect.stringContaining("boom") });
  });
});
