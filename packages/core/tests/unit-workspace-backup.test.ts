// The /workspace durability gate.
//
// The defect this replaces was a restore that silently did nothing: a lazy,
// one-shot wrapper read a per-agent config key, found it empty, marked the
// container restored, and let the agent run against whatever it found — for the
// rest of the container's life. Nothing observed that the restore had not
// happened, so nothing failed.
//
// This gate therefore asserts the OUTCOME of each decision, not that a function
// was reachable, and it asserts a denominator: `WORKSPACE_RESTORE_OUTCOMES` and
// `WORKSPACE_SNAPSHOT_OUTCOMES` are the implementation's own enumerations, and
// the last two tests fail if any member of either was never produced here.
// Adding an outcome without exercising it turns this suite red.
import { describe, test, expect } from "bun:test";
import {
  BACKUP_MIN_INTERVAL_MS, WORKSPACE_RESTORE_OUTCOMES, WORKSPACE_SNAPSHOT_OUTCOMES,
  createWorkspaceSnapshots, isDirectoryOverlayMounted, shouldBackupWorkspace,
  snapshotIntegrityFailure, snapshotObjectKeys, withContainerStartDeadline,
  workspaceBackupOptions, workspaceRestoreMode,
  type DirectoryBackup, type WorkspaceSnapshotPorts, type WorkspaceSnapshotState,
} from "../src/index";

const MOUNTED = [
  "proc /proc proc rw,relatime 0 0",
  "fuse-overlayfs /workspace fuse.fuse-overlayfs rw,nosuid,nodev,relatime,user_id=0 0 0",
].join("\n");
const NOT_MOUNTED = "proc /proc proc rw,relatime 0 0\n/dev/sda1 / ext4 rw 0 0";

/** Every outcome kind either suite produced, so the denominator is measured
 *  rather than asserted by eye. */
const seenRestore = new Set<string>();
const seenSnapshot = new Set<string>();

interface Recorder {
  readonly ports: WorkspaceSnapshotPorts;
  readonly calls: string[];
  state: WorkspaceSnapshotState | null;
}

/** A container and bucket that behave exactly as told. `archive`/`declared` are
 *  the two R2 reads; leaving one undefined is a missing object, and disagreeing
 *  sizes are a corrupt one. */
function harness(overrides: {
  state?: WorkspaceSnapshotState | null;
  mounts?: string;
  mountsAfterRestore?: string;
  entriesAfterRestore?: number;
  archive?: number | undefined;
  declared?: number | undefined;
  restoreSucceeds?: boolean;
  running?: boolean;
  bucketBinding?: boolean;
  change?: { status: "unchanged" | "changed" | "resync"; version: string } | Error;
  now?: number;
  createdBackup?: DirectoryBackup;
  createdArchive?: number | undefined;
  createdDeclared?: number | undefined;
} = {}): Recorder {
  const calls: string[] = [];
  let restored = false;
  const record: Recorder = {
    calls,
    state: overrides.state ?? null,
    ports: {
      containerRunning: () => overrides.running ?? true,
      bucketBinding: () => overrides.bucketBinding ?? false,
      readState: async () => record.state,
      writeState: async (next) => {
        calls.push(`writeState:${next.backup.id}:${next.changeVersion ?? "-"}`
          + `${next.lastFailure === undefined ? "" : ":failed"}`);
        record.state = next;
      },
      createBackup: async (options) => {
        calls.push(`createBackup:${options.dir}:localBucket=${String(options.localBucket)}`);
        return overrides.createdBackup ?? { id: "new-1", dir: options.dir };
      },
      restoreBackup: async (backup) => {
        calls.push(`restoreBackup:${backup.id}`);
        restored = true;
        return { success: overrides.restoreSucceeds ?? true };
      },
      checkChanges: async (dir, since) => {
        calls.push(`checkChanges:${dir}:since=${since ?? "-"}`);
        const change = overrides.change ?? { status: "changed" as const, version: "v2" };
        if (change instanceof Error) throw change;
        return change;
      },
      readMounts: async () => {
        calls.push("readMounts");
        if (restored) return overrides.mountsAfterRestore ?? MOUNTED;
        return overrides.mounts ?? NOT_MOUNTED;
      },
      countWorkspaceEntries: async () => {
        calls.push("countWorkspaceEntries");
        return restored ? overrides.entriesAfterRestore ?? 3 : 0;
      },
      archiveBytes: async (id) => {
        calls.push(`archiveBytes:${id}`);
        return id === "new-1" ? overrides.createdArchive : overrides.archive;
      },
      declaredBytes: async (id) => {
        calls.push(`declaredBytes:${id}`);
        return id === "new-1" ? overrides.createdDeclared : overrides.declared;
      },
      deleteSnapshot: async (id) => { calls.push(`deleteSnapshot:${id}`); },
      now: () => overrides.now ?? 10 * BACKUP_MIN_INTERVAL_MS,
      log: (message) => calls.push(`log:${message}`),
    },
  };
  return record;
}

const soundState = (over: Partial<WorkspaceSnapshotState> = {}): WorkspaceSnapshotState => ({
  backup: { id: "snap-1", dir: "/workspace" },
  at: 0,
  sizeBytes: 4096,
  changeVersion: "v1",
  lastFailure: undefined,
  ...over,
});

async function restoreOf(record: Recorder) {
  const outcome = await createWorkspaceSnapshots(record.ports).restore();
  seenRestore.add(outcome.kind);
  return outcome;
}

async function tickOf(record: Recorder) {
  const outcome = await createWorkspaceSnapshots(record.ports).snapshotIfDue();
  seenSnapshot.add(outcome.kind);
  return outcome;
}

describe("restore — the restore must be observed to have happened", () => {
  test("a container with no snapshot history restores nothing and does not fail", async () => {
    const h = harness({ state: null });
    expect((await restoreOf(h)).kind).toBe("no-snapshot");
    expect(h.calls.filter((c) => c.startsWith("restoreBackup"))).toHaveLength(0);
  });

  test("a sound snapshot is transferred and its mount verified afterwards", async () => {
    const h = harness({ state: soundState(), archive: 4096, declared: 4096 });
    const outcome = await restoreOf(h);
    expect(outcome.kind).toBe("restored");
    expect(outcome.backupId).toBe("snap-1");
    expect(outcome.mode).toBe("mount");
    expect(h.calls).toContain("restoreBackup:snap-1");
    // Mounts are read twice: once for idempotence, once as the postcondition.
    expect(h.calls.filter((c) => c === "readMounts")).toHaveLength(2);
  });

  test("a mount already in place is not transferred a second time", async () => {
    const h = harness({ state: soundState(), mounts: MOUNTED, archive: 4096, declared: 4096 });
    expect((await restoreOf(h)).kind).toBe("already-restored");
    expect(h.calls.filter((c) => c.startsWith("restoreBackup"))).toHaveLength(0);
  });

  // ── the two seeded failures ───────────────────────────────────────────────

  test("MISSING backup: the archive is gone, so the container refuses to start", async () => {
    // The realistic shape: an R2 lifecycle rule reaped the large archive object
    // and left the small metadata object behind.
    const h = harness({ state: soundState(), archive: undefined, declared: 4096 });
    await expect(restoreOf(h)).rejects.toThrow(/archive object is missing from the bucket/);
    expect(h.calls.filter((c) => c.startsWith("restoreBackup"))).toHaveLength(0);
  });

  test("MISSING backup: the whole generation is gone", async () => {
    const h = harness({ state: soundState(), archive: undefined, declared: undefined });
    await expect(restoreOf(h)).rejects.toThrow(/metadata object is missing or has no sizeBytes/);
    expect(h.calls.filter((c) => c.startsWith("restoreBackup"))).toHaveLength(0);
  });

  test("CORRUPT backup: a size that disagrees with its metadata refuses to start", async () => {
    const h = harness({ state: soundState(), archive: 11, declared: 4096 });
    await expect(restoreOf(h)).rejects.toThrow(/archive is 11 bytes, metadata declares 4096/);
    expect(h.calls.filter((c) => c.startsWith("restoreBackup"))).toHaveLength(0);
  });

  test("a size that disagrees with THIS container's own record refuses to start", async () => {
    const h = harness({ state: soundState(), archive: 8192, declared: 8192 });
    await expect(restoreOf(h)).rejects.toThrow(/this container recorded 4096/);
  });

  test("metadata present but nonsensical refuses to start", async () => {
    const h = harness({ state: soundState(), archive: 0, declared: 0 });
    await expect(restoreOf(h)).rejects.toThrow(/metadata declares 0 bytes/);
  });

  test("a restore reporting failure throws rather than continuing", async () => {
    const h = harness({
      state: soundState(), archive: 4096, declared: 4096, restoreSucceeds: false,
    });
    await expect(restoreOf(h)).rejects.toThrow(/reported failure/);
  });

  // The whole point of the redesign: success from the thing being observed is
  // not evidence that the observer saw anything.
  test("a restore reporting SUCCESS with no mount to show for it throws", async () => {
    const h = harness({
      state: soundState(), archive: 4096, declared: 4096, mountsAfterRestore: NOT_MOUNTED,
    });
    await expect(restoreOf(h)).rejects.toThrow(/reported success, but \/workspace is not an overlay mount/);
  });

  test("extract-mode success with an empty workspace to show for it throws", async () => {
    const h = harness({
      state: soundState({ backup: { id: "snap-1", dir: "/workspace", localBucket: true } }),
      archive: 4096, declared: 4096, entriesAfterRestore: 0,
    });
    await expect(restoreOf(h)).rejects.toThrow(/reported success, but \/workspace is empty/);
  });

  test("extract-mode restore verifies content instead of a mount", async () => {
    const h = harness({
      state: soundState({ backup: { id: "snap-1", dir: "/workspace", localBucket: true } }),
      archive: 4096, declared: 4096,
    });
    const outcome = await restoreOf(h);
    expect(outcome.kind).toBe("restored");
    expect(outcome.mode).toBe("extract");
    expect(h.calls).toContain("countWorkspaceEntries");
    expect(h.calls.filter((c) => c === "readMounts")).toHaveLength(0);
  });
});

describe("periodic snapshot — gated on checkChanges", () => {
  test("a stopped container is not woken to be asked whether it changed", async () => {
    const h = harness({ running: false });
    expect((await tickOf(h)).kind).toBe("not-running");
    expect(h.calls).toHaveLength(0);
  });

  test("unchanged costs no archive, no upload, no new object", async () => {
    const h = harness({
      state: soundState(), change: { status: "unchanged", version: "v9" },
    });
    expect((await tickOf(h)).kind).toBe("unchanged");
    expect(h.calls.filter((c) => c.startsWith("createBackup"))).toHaveLength(0);
    // The watermark advances so the next check is relative to now.
    expect(h.calls).toContain("writeState:snap-1:v9");
  });

  test("changed inside the period does NOT advance the watermark", async () => {
    const h = harness({
      state: soundState({ at: 10 * BACKUP_MIN_INTERVAL_MS }),
      change: { status: "changed", version: "v9" },
    });
    expect((await tickOf(h)).kind).toBe("within-period");
    expect(h.calls.filter((c) => c.startsWith("writeState"))).toHaveLength(0);
    expect(h.calls.filter((c) => c.startsWith("createBackup"))).toHaveLength(0);
  });

  test("changed past the period snapshots, verifies, records, and drops the old one", async () => {
    const h = harness({
      state: soundState(), change: { status: "changed", version: "v9" },
      createdArchive: 2048, createdDeclared: 2048,
    });
    const outcome = await tickOf(h);
    expect(outcome.kind).toBe("snapshotted");
    expect(outcome.bytes).toBe(2048);
    expect(h.calls).toContain("createBackup:/workspace:localBucket=false");
    expect(h.calls).toContain("writeState:new-1:v9");
    // Retention: one live generation, and only after the replacement is durable.
    expect(h.calls.indexOf("writeState:new-1:v9"))
      .toBeLessThan(h.calls.indexOf("deleteSnapshot:snap-1"));
  });

  test("a resync — the container lost its change state — counts as changed", async () => {
    const h = harness({
      state: soundState(), change: { status: "resync", version: "v9" },
      createdArchive: 2048, createdDeclared: 2048,
    });
    expect((await tickOf(h)).kind).toBe("snapshotted");
  });

  test("a first-ever snapshot needs no prior state and deletes nothing", async () => {
    const h = harness({
      state: null, change: { status: "resync", version: "v1" },
      createdArchive: 512, createdDeclared: 512,
    });
    expect((await tickOf(h)).kind).toBe("snapshotted");
    expect(h.calls.filter((c) => c.startsWith("deleteSnapshot"))).toHaveLength(0);
  });

  test("a fresh snapshot that did not land intact is deleted, not recorded", async () => {
    const h = harness({
      state: soundState(), change: { status: "changed", version: "v9" },
      createdArchive: 7, createdDeclared: 2048,
    });
    const outcome = await tickOf(h);
    expect(outcome.kind).toBe("failed");
    expect(outcome.reason).toMatch(/is not sound: archive is 7 bytes/);
    expect(h.calls).toContain("deleteSnapshot:new-1");
    // The old generation survives, and the failure is persisted rather than
    // living only in a log line the alarm loop swallows.
    expect(h.state?.backup.id).toBe("snap-1");
    expect(h.state?.lastFailure?.reason).toMatch(/is not sound/);
  });

  test("a checkChanges failure is recorded and does not snapshot blindly", async () => {
    const h = harness({ state: soundState(), change: new Error("container gone") });
    const outcome = await tickOf(h);
    expect(outcome.kind).toBe("failed");
    expect(outcome.reason).toMatch(/checkChanges failed: container gone/);
    expect(h.calls.filter((c) => c.startsWith("createBackup"))).toHaveLength(0);
  });

  test("bucket-binding mode is passed through to the snapshot options", async () => {
    const h = harness({
      state: null, bucketBinding: true, change: { status: "changed", version: "v1" },
      createdArchive: 512, createdDeclared: 512,
    });
    await tickOf(h);
    expect(h.calls).toContain("createBackup:/workspace:localBucket=true");
  });
});

describe("pure decisions", () => {
  test("shouldBackupWorkspace never fires on an unchanged directory", () => {
    expect(shouldBackupWorkspace("unchanged", 0, 10 * BACKUP_MIN_INTERVAL_MS)).toBe(false);
  });

  test("fires on changed or resync once the period elapsed", () => {
    const now = 10 * BACKUP_MIN_INTERVAL_MS;
    expect(shouldBackupWorkspace("changed", now - BACKUP_MIN_INTERVAL_MS, now)).toBe(true);
    expect(shouldBackupWorkspace("resync", now - BACKUP_MIN_INTERVAL_MS - 1, now)).toBe(true);
  });

  test("debounces a second snapshot inside the period", () => {
    const now = 1_000_000;
    expect(shouldBackupWorkspace("changed", now - 1, now)).toBe(false);
    expect(shouldBackupWorkspace("changed", now, now)).toBe(false);
  });

  test("first-ever snapshot fires immediately once something changed", () => {
    expect(shouldBackupWorkspace("changed", 0, BACKUP_MIN_INTERVAL_MS)).toBe(true);
  });

  test("snapshot options exclude derived files and carry a real TTL", () => {
    const o = workspaceBackupOptions(false);
    expect(o.dir).toBe("/workspace");
    expect(o.localBucket).toBe(false);
    expect(o.gitignore).toBe(true);
    expect(o.excludes).toContain("node_modules");
    expect(o.compression?.format).toBe("zstd");
    // The SDK default is 3 days and is enforced at restore time only.
    expect(o.ttl).toBeGreaterThan(3 * 24 * 60 * 60);
  });

  test("restore mode follows the handle, not the current configuration", () => {
    expect(workspaceRestoreMode({ id: "a", dir: "/workspace" })).toBe("mount");
    expect(workspaceRestoreMode({ id: "a", dir: "/workspace", localBucket: true }))
      .toBe("extract");
  });

  test("mount detection reads fstab field order and unescapes mountpoints", () => {
    expect(isDirectoryOverlayMounted(MOUNTED, "/workspace")).toBe(true);
    expect(isDirectoryOverlayMounted(NOT_MOUNTED, "/workspace")).toBe(false);
    // The overlay must be AT the directory, not merely mentioned on the line.
    expect(isDirectoryOverlayMounted("overlay /workspace/sub overlay rw 0 0", "/workspace"))
      .toBe(false);
    expect(isDirectoryOverlayMounted("/dev/sda1 /workspace ext4 rw 0 0", "/workspace"))
      .toBe(false);
    expect(isDirectoryOverlayMounted("fuse-overlayfs /my\\040space fuse.fuse-overlayfs rw 0 0",
      "/my space")).toBe(true);
  });

  test("integrity failures name what is wrong", () => {
    expect(snapshotIntegrityFailure({ declaredBytes: 10, storedBytes: 10 })).toBeNull();
    expect(snapshotIntegrityFailure({ declaredBytes: undefined, storedBytes: 10 }))
      .toMatch(/metadata object is missing/);
    expect(snapshotIntegrityFailure({ declaredBytes: 10, storedBytes: undefined }))
      .toMatch(/archive object is missing/);
    expect(snapshotIntegrityFailure({ declaredBytes: 0, storedBytes: 0 }))
      .toMatch(/declares 0 bytes/);
  });

  test("object keys are the SDK's layout, checked never written", () => {
    expect(snapshotObjectKeys("abc")).toEqual({
      archive: "backups/abc/data.sqsh", metadata: "backups/abc/meta.json",
    });
  });
});

// No wall-clock sleeps and no guessed durations: the work here is a promise the
// test controls, so a 0 ms budget wins deterministically — a pending promise
// that has not been settled cannot win a race against a timer that has fired.
describe("container-start budget", () => {
  test("work inside the budget returns its value", async () => {
    const value = await withContainerStartDeadline("t", 1_000, async () => "ok", () => {
      throw new Error("must not be called");
    });
    expect(value).toBe("ok");
  });

  test("overrunning fails the start rather than waiting for the runtime to reset", async () => {
    const stuck = Promise.withResolvers<void>();
    await expect(withContainerStartDeadline(
      "restore", 0, () => stuck.promise, () => {},
    )).rejects.toThrow(/exceeded its 0ms container-start budget/);
    stuck.resolve();
  });

  test("a failure after the budget is reported, not swallowed", async () => {
    const late: string[] = [];
    const stuck = Promise.withResolvers<void>();
    await expect(withContainerStartDeadline(
      "restore", 0, () => stuck.promise,
      ({ reason }) => late.push(reason instanceof Error ? reason.message : String(reason)),
    )).rejects.toThrow(/exceeded its 0ms/);
    // The work settles only now, after the race is already lost.
    stuck.reject(new Error("late"));
    await drainMicrotasks();
    expect(late).toEqual(["late"]);
  });

  test("a failure inside the budget propagates unchanged", async () => {
    await expect(withContainerStartDeadline(
      "restore", 1_000, () => Promise.reject(new Error("nope")), () => {
        throw new Error("must not be called");
      },
    )).rejects.toThrow("nope");
  });
});

/** The `.catch` that reports a late failure runs in a microtask, so yielding the
 *  queue is enough — there is nothing to wait for on the clock. */
async function drainMicrotasks(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

// ── the denominator ────────────────────────────────────────────────────────
// These run last (bun executes files top to bottom) and are the reason this is
// a gate and not a sample: a new outcome kind that nothing above produces fails
// here, so the suite cannot quietly stop covering the decision it guards.
describe("denominator", () => {
  test("every restore outcome the implementation can produce was produced here", () => {
    expect(WORKSPACE_RESTORE_OUTCOMES.length).toBeGreaterThan(0);
    expect([...seenRestore].sort()).toEqual([...WORKSPACE_RESTORE_OUTCOMES].sort());
  });

  test("every snapshot outcome the implementation can produce was produced here", () => {
    expect(WORKSPACE_SNAPSHOT_OUTCOMES.length).toBeGreaterThan(0);
    expect([...seenSnapshot].sort()).toEqual([...WORKSPACE_SNAPSHOT_OUTCOMES].sort());
  });
});
