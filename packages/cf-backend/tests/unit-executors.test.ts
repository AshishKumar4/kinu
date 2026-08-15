// pickDefaultExecutor — which executor the diff/file-manager defaults to.
// Prefers the sticky last-active executor only when it is already active, else
// workspace. This keeps status/diff reads from waking idle remote executors.
import { describe, test, expect } from "bun:test";
import {
  EXECUTOR_LABELS, EXECUTOR_ORDER, executorLabel, pickDefaultExecutor, releaseSubstrate,
  type ExecutorInfo,
} from "../src/lib/executors";

const avail = (...names: string[]) => names.map((name) => ({ name, available: true }));
const active = (...names: string[]) => names.map((name) => ({ name, available: true, active: true }));

describe("pickDefaultExecutor", () => {
  test("prefers lastActive when it is active", () => {
    expect(pickDefaultExecutor([...active("sandbox", "workspace")], "sandbox")).toBe("sandbox");
    expect(pickDefaultExecutor([...avail("sandbox", "workspace")], "workspace")).toBe("workspace");
  });

  test("ignores lastActive when it is unavailable, falls back to active static priority", () => {
    const execs = [{ name: "sandbox", available: true, active: true }, { name: "laptop", available: false }];
    expect(pickDefaultExecutor(execs, "laptop")).toBe("sandbox");
  });

  test("static priority favors active user's desktop when connected (laptop > sandbox)", () => {
    expect(pickDefaultExecutor([...active("sandbox", "laptop", "workspace")])).toBe("laptop");
    expect(pickDefaultExecutor([...active("laptop", "workspace")])).toBe("laptop");
    expect(pickDefaultExecutor([...active("sandbox", "workspace")])).toBe("sandbox");
  });

  test("available but idle remote executors do not become default targets", () => {
    expect(pickDefaultExecutor([...avail("sandbox", "workspace")])).toBe("workspace");
  });

  test("falls back to workspace when nothing else is available", () => {
    expect(pickDefaultExecutor([{ name: "sandbox", available: false }])).toBe("workspace");
    expect(pickDefaultExecutor([])).toBe("workspace");
    expect(pickDefaultExecutor([], "sandbox")).toBe("workspace"); // lastActive not in list
  });
});

/**
 * releaseSubstrate — what the Releases surface says about whether the pipeline
 * can run at all. The release engine executes in the sandbox container, so the
 * sandbox executor row is the verdict; the surface must state an unavailable
 * substrate up front instead of rendering a pipeline that cannot run, and must
 * say nothing while the executor list has not loaded.
 */
describe("releaseSubstrate", () => {
  const exec = (over: Partial<ExecutorInfo>): ExecutorInfo => ({
    name: "sandbox", kind: "sandbox", capabilities: [], available: true, ...over,
  });

  test("says nothing before the executor list has loaded", () => {
    expect(releaseSubstrate([])).toEqual({ state: "unknown" });
  });

  test("an unavailable sandbox is unavailable, carrying the executor's own reason", () => {
    const verdict = releaseSubstrate([
      exec({ available: false, status: "not_configured", reason: "Sandbox executor not configured." }),
    ]);
    expect(verdict).toEqual({ state: "unavailable", reason: "Sandbox executor not configured." });
  });

  test("a loaded list with no sandbox row at all is unavailable with a stated reason", () => {
    const verdict = releaseSubstrate([exec({ name: "workspace", kind: "workspace" })]);
    expect(verdict.state).toBe("unavailable");
    if (verdict.state === "unavailable") expect(verdict.reason.length).toBeGreaterThan(0);
  });

  test("an available sandbox is ready; a previews-off reason rides along as the note", () => {
    expect(releaseSubstrate([exec({ status: "idle" })])).toEqual({ state: "ready", note: null });
    const withNote = releaseSubstrate([exec({ status: "idle", reason: "Sandbox previews are off: PREVIEW_HOST_SUFFIX is unset." })]);
    expect(withNote).toEqual({ state: "ready", note: "Sandbox previews are off: PREVIEW_HOST_SUFFIX is unset." });
  });
});

/**
 * The Environment surface renders one chip per environment, each carrying this
 * label. Nimbus runs the workspace filesystem and resident process plane;
 * there is deliberately no second Nimbus row.
 */
describe("executor labels name one environment each", () => {
  test("no two environments share a name", () => {
    const labels = EXECUTOR_ORDER.map(executorLabel);
    expect(new Set(labels).size).toBe(labels.length);
  });

  test("only the agent's own filesystem is called the Workspace", () => {
    // `parent` is legitimately a workspace too — someone else's, and its label
    // says whose. What no other environment may do is answer to the bare word.
    expect(EXECUTOR_LABELS.workspace).toBe("Workspace");
    for (const [name, label] of Object.entries(EXECUTOR_LABELS)) {
      if (name === "workspace") continue;
      expect(label).not.toBe("Workspace");
    }
  });

  test("there is no redundant Nimbus executor row", () => {
    expect(EXECUTOR_ORDER).not.toContain("nimbus");
    expect(Object.hasOwn(EXECUTOR_LABELS, "nimbus")).toBe(false);
  });

  test("every ordered executor has a name of its own — none falls back to its namespace", () => {
    for (const name of EXECUTOR_ORDER) {
      expect(Object.entries(EXECUTOR_LABELS).some(([key]) => key === name)).toBe(true);
      expect(executorLabel(name)).not.toBe(name);
    }
  });
});
