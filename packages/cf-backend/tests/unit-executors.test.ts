// pickDefaultExecutor — which executor the diff/file-manager defaults to.
// Prefers the sticky last-active executor only when it is already active, else
// workspace. This keeps status/diff reads from waking idle remote executors.
import { describe, test, expect } from "bun:test";
import { pickDefaultExecutor } from "../src/lib/executors";

const avail = (...names: string[]) => names.map((name) => ({ name, available: true }));
const active = (...names: string[]) => names.map((name) => ({ name, available: true, active: true }));

describe("pickDefaultExecutor", () => {
  test("prefers lastActive when it is active", () => {
    expect(pickDefaultExecutor([...active("sandbox", "workspace", "nimbus")], "nimbus")).toBe("nimbus");
    expect(pickDefaultExecutor([...avail("sandbox", "workspace")], "workspace")).toBe("workspace");
  });

  test("ignores lastActive when it is unavailable, falls back to active static priority", () => {
    const execs = [{ name: "sandbox", available: true, active: true }, { name: "laptop", available: false }];
    expect(pickDefaultExecutor(execs, "laptop")).toBe("sandbox");
  });

  test("static priority favors active user's desktop when connected (laptop > nimbus > sandbox)", () => {
    expect(pickDefaultExecutor([...active("nimbus", "laptop", "workspace")])).toBe("laptop");
    expect(pickDefaultExecutor([...active("laptop", "workspace")])).toBe("laptop");
    expect(pickDefaultExecutor([...active("nimbus", "sandbox", "workspace")])).toBe("nimbus");
  });

  test("available but idle remote executors do not become default targets", () => {
    expect(pickDefaultExecutor([...avail("sandbox", "nimbus", "workspace")])).toBe("workspace");
  });

  test("falls back to workspace when nothing else is available", () => {
    expect(pickDefaultExecutor([{ name: "sandbox", available: false }])).toBe("workspace");
    expect(pickDefaultExecutor([])).toBe("workspace");
    expect(pickDefaultExecutor([], "sandbox")).toBe("workspace"); // lastActive not in list
  });
});
