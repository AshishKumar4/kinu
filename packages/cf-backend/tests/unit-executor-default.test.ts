// pickDefaultExecutor — which executor the diff/file-manager defaults to.
// Prefers the sticky last-active executor when available, else static priority.
import { describe, test, expect } from "bun:test";
import { pickDefaultExecutor } from "../src/lib/executor-default";

const avail = (...names: string[]) => names.map((name) => ({ name, available: true }));

describe("pickDefaultExecutor", () => {
  test("prefers lastActive when it is available", () => {
    expect(pickDefaultExecutor([...avail("sandbox", "workspace", "nimbus")], "nimbus")).toBe("nimbus");
    expect(pickDefaultExecutor([...avail("sandbox", "workspace")], "workspace")).toBe("workspace");
  });

  test("ignores lastActive when it is unavailable, falls back to static priority", () => {
    const execs = [{ name: "sandbox", available: true }, { name: "laptop", available: false }];
    expect(pickDefaultExecutor(execs, "laptop")).toBe("sandbox");
  });

  test("static priority favors a real shell (sandbox > nimbus > laptop)", () => {
    expect(pickDefaultExecutor([...avail("nimbus", "laptop", "workspace")])).toBe("nimbus");
    expect(pickDefaultExecutor([...avail("laptop", "workspace")])).toBe("laptop");
  });

  test("falls back to workspace when nothing else is available", () => {
    expect(pickDefaultExecutor([{ name: "sandbox", available: false }])).toBe("workspace");
    expect(pickDefaultExecutor([])).toBe("workspace");
    expect(pickDefaultExecutor([], "sandbox")).toBe("workspace"); // lastActive not in list
  });
});
