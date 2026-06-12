// Pure backup-policy decision for /workspace persistence.
import { describe, test, expect } from "bun:test";
import {
  shouldBackupWorkspace, workspaceBackupOptions, BACKUP_MIN_INTERVAL_MS,
} from "../src/index.ts";

describe("shouldBackupWorkspace", () => {
  test("never backs up a turn that didn't touch the sandbox", () => {
    expect(shouldBackupWorkspace(false, 0, 10 * BACKUP_MIN_INTERVAL_MS)).toBe(false);
  });

  test("backs up when sandbox used and the debounce window elapsed", () => {
    const now = 1_000_000;
    expect(shouldBackupWorkspace(true, now - BACKUP_MIN_INTERVAL_MS, now)).toBe(true);
    expect(shouldBackupWorkspace(true, now - BACKUP_MIN_INTERVAL_MS - 1, now)).toBe(true);
  });

  test("debounces a second backup inside the window", () => {
    const now = 1_000_000;
    expect(shouldBackupWorkspace(true, now - 1, now)).toBe(false);
    expect(shouldBackupWorkspace(true, now, now)).toBe(false);
  });

  test("first-ever backup (lastBackupAt=0) fires immediately when used", () => {
    expect(shouldBackupWorkspace(true, 0, BACKUP_MIN_INTERVAL_MS)).toBe(true);
  });
});

describe("workspaceBackupOptions", () => {
  test("targets /workspace via localBucket, excludes node_modules, honors gitignore", () => {
    const o = workspaceBackupOptions();
    expect(o.dir).toBe("/workspace");
    expect(o.localBucket).toBe(true);
    expect(o.gitignore).toBe(true);
    expect(o.excludes).toContain("node_modules");
    expect(o.ttl).toBeGreaterThan(0);
  });
});
