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
    createTimerTrigger: (opts) => { calls.push(`timer:${opts.cron ?? opts.atMs}`); return { id: "trg1", kind: opts.cron ? "timer_cron" : "timer_oneshot", nextFireAt: 123 }; },
    cancelTrigger: async (id) => { calls.push(`cancel:${id}`); return { ok: true, changed: true }; },
    ...over,
  };
}

describe("createAgentSelfProvider — shape", () => {
  test("is a well-formed CodemodeProvider", () => {
    const p = createAgentSelfProvider(fakeHost());
    expect(p.name).toBe("agent");
    expect(p.positionalArgs).toBe(true);
    expect(p.types).toContain("agent.schedule".replace("agent.", "")); // declares schedule
    for (const name of ["proposeCurriculum", "listCurriculum", "acceptCurriculumTask", "schedule", "cancelSchedule"]) {
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
    const ok = await p.tools.schedule.execute({ cron: "0 * * * *", label: "hourly" });
    expect(ok).toMatchObject({ id: "trg1", kind: "timer_cron" });
    expect(host.calls).toContain("timer:0 * * * *");
  });

  test("error from the host surfaces as an envelope, not a throw", async () => {
    const host = fakeHost({ proposeCurriculumTasks: async () => { throw new Error("boom"); } });
    const p = createAgentSelfProvider(host);
    const r = await p.tools.proposeCurriculum.execute(1);
    expect(r).toEqual({ error: expect.stringContaining("boom") });
  });
});
