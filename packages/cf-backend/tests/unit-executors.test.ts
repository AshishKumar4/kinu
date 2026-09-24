// Sticky last-active executor only when already active, else workspace: status/diff reads must not wake idle remotes.
import { describe, test, expect } from "bun:test";
import {
  executorLabel, executorSortKey, pickDefaultExecutor, releaseSubstrate,
  type ExecutorInfo,
} from "@kinu.run/core";

const avail = (...names: string[]) => names.map((name) => ({ name, available: true }));

const active = (...names: string[]) => names.map((name) => ({ name, available: true, active: true }));

describe("pickDefaultExecutor", () => {
  test("prefers lastActive when it is active", () => {
    expect(pickDefaultExecutor([...active("sandbox", "workspace")], "sandbox")).toBe("sandbox");
    expect(pickDefaultExecutor([...avail("sandbox", "workspace")], "workspace")).toBe("workspace");
  });

  test("ignores lastActive when it is unavailable, falls back to active static priority", () => {
    const execs = [{ name: "sandbox", available: true, active: true }, { name: "device", available: false }];
    expect(pickDefaultExecutor(execs, "device")).toBe("sandbox");
  });

  test("static priority favors active user's desktop when connected (device > sandbox)", () => {
    expect(pickDefaultExecutor([...active("sandbox", "device", "workspace")])).toBe("device");
    expect(pickDefaultExecutor([...active("device", "workspace")])).toBe("device");
    expect(pickDefaultExecutor([...active("sandbox", "workspace")])).toBe("sandbox");
  });

  test("available but idle remote executors do not become default targets", () => {
    expect(pickDefaultExecutor([...avail("sandbox", "workspace")])).toBe("workspace");
  });

  test("falls back to workspace when nothing else is available", () => {
    expect(pickDefaultExecutor([{ name: "sandbox", available: false }])).toBe("workspace");
    expect(pickDefaultExecutor([])).toBe("workspace");
    expect(pickDefaultExecutor([], "sandbox")).toBe("workspace");
  });
});

/** The release engine runs in the sandbox container, so that row is the verdict; say nothing until executors load. */
describe("releaseSubstrate", () => {
  const exec = (over: Partial<ExecutorInfo>): ExecutorInfo => ({
    name: "sandbox", kind: "sandbox", capabilities: [], available: true,
    configured: true, active: false, status: "idle", ...over,
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

/** There is deliberately no second Nimbus row. */
describe("executor labels name one environment each", () => {
  // Nothing else enumerates the whole set: a new environment needs a row here.
  const NAMES = ["device", "sandbox", "workspace", "parent"];

  test("no two environments share a name", () => {
    const labels = NAMES.map(executorLabel);
    expect(new Set(labels).size).toBe(labels.length);
  });

  test("only the agent's own filesystem is called the Workspace", () => {
    // `parent` is someone else's workspace; no other environment may answer to the bare word.
    expect(executorLabel("workspace")).toBe("Workspace");

    for (const name of NAMES) {
      if (name === "workspace") continue;
      expect(executorLabel(name)).not.toBe("Workspace");
    }
  });

  test("there is no redundant Nimbus executor row", () => {
    expect(executorLabel("nimbus")).toBe("nimbus");
    expect(executorSortKey("nimbus")).toBe(99);
  });

  test("every known executor has a name of its own — none falls back to its namespace", () => {
    for (const name of NAMES) {
      expect(executorLabel(name)).not.toBe(name);
    }
  });
});
