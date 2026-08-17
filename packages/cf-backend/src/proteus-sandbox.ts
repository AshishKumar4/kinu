/**
 * ProteusSandbox — the Durable Object that owns one agent workspace container.
 *
 * `getSandbox(env.Sandbox, id)` returns a handle whose exec / file / port methods
 * are all inherited from `@cloudflare/sandbox`'s `Sandbox`. What this subclass
 * adds is the one thing the base class cannot own: durability of `/workspace`
 * across the container's lifetime.
 *
 * It is an ADAPTER. Every decision — whether to restore, whether a snapshot is
 * due, what a failure means — lives in `createWorkspaceSnapshots` in
 * `@proteus/core`, along with the reasoning for why the container-start hook is
 * the only correct place for a restore. This file supplies the SDK calls, this
 * object's storage, and the R2 reads, and chooses nothing.
 *
 * Two Cloudflare-side facts the shape depends on, both verified against
 * `@cloudflare/sandbox@0.12.7` and `@cloudflare/containers@0.3.5`:
 *
 *  * `Container.start` and `Container.startAndWaitForPorts` both await
 *    `onStart()` inside `ctx.blockConcurrencyWhile`, so while it is held nothing
 *    — no exec, no read, no facet — can observe the container. They also both
 *    call it unconditionally after an already-running fast path, so it is
 *    at-least-once per container start; the restore is idempotent by asking the
 *    container what is mounted rather than trusting a marker.
 *  * Calling back into the container from `onStart` is supported: the base sets
 *    the container healthy BEFORE invoking the hook, so `containerFetch` routes
 *    straight through instead of re-entering the start path.
 */

import { Sandbox } from "@cloudflare/sandbox";
import {
  BACKUP_MIN_INTERVAL_MS, WORKSPACE_BACKUP_DIR, WORKSPACE_RESTORE_DEADLINE_MS,
  createWorkspaceSnapshots, snapshotObjectKeys, withContainerStartDeadline,
  type BackupOptions, type WorkspaceSnapshotPorts,
  type WorkspaceSnapshotState, type WorkspaceSnapshots,
} from "@proteus/core";
import * as v from "valibot";
import {
  CONTAINER_EVENT_HOST, EGRESS_HANDLER, EVENT_HANDLER,
  handleContainerEgress, handleContainerEvent, parseEgressParams,
  type ProteusEgressParams,
} from "./egress/outbound.js";

/** Storage key for this container's snapshot record. */
const SNAPSHOT_STATE_KEY = "proteus:workspace-snapshot";
/** Scheduled-callback name. Must name a method on this class — `Container.schedule`
 *  rejects anything else. */
const SNAPSHOT_CALLBACK = "snapshotWorkspaceIfDue";
/** The only field of the SDK's `meta.json` this object reads. Parsed rather than
 *  asserted: it is a persisted blob written by another package. */
const SnapshotMetadataSchema = v.object({ sizeBytes: v.number() });

export class ProteusSandbox extends Sandbox<Env> {
  #snapshots: WorkspaceSnapshots | undefined;

  /**
   * No raw sockets. The platform NEVER routes a port other than 80/443 through
   * an outbound handler, so without this, "every HTTP/S egress is intercepted"
   * would be a claim about the two ports the platform happens to route rather
   * than about all egress. The cost is deliberate: only HTTP/S and DNS leave an
   * agent's container, so git-over-SSH and raw database sockets are refused.
   */
  enableInternet = false;

  /**
   * MEASURED, NOT ASSUMED. The SDK's docs say "Sandboxes intercept HTTPS traffic
   * by default — `interceptHttps` is set to `true` on the Sandbox class". That is
   * FALSE for the whole stable line: the string appears exactly ONCE in the
   * shipped bundle of both 0.11.0 and 0.12.7 and it is a READ
   * (`if (this.interceptHttps) this.envVars = {…SANDBOX_INTERCEPT_HTTPS:"1"}`),
   * never an assignment, so the class inherits `interceptHttps = false` from
   * `@cloudflare/containers` (`dist/lib/container.js`, same default in 0.3.6 and
   * 0.3.7). Leaving it alone means every HTTPS request — which is every request
   * that matters — bypasses interception while the vault believes it is
   * substituting. Setting it true both exports `SANDBOX_INTERCEPT_HTTPS=1` so the
   * container trusts the ephemeral CA, and makes the base call
   * `interceptOutboundHttps('*', fetcher)`.
   *
   * A field rather than anything set in `onStart`: the base runs
   * `refreshOutboundInterception()` immediately before `container.start()`, and
   * `onStart` runs after the container is already up.
   */
  interceptHttps = true;

  /**
   * Bind this container's two egress handlers, with the secret bindings the
   * workspace has been granted.
   *
   * Called by the workspace Durable Object — which is where the grants live —
   * before the container is first used, and again whenever the owner's vault or
   * the workspace's grants change. Not in `onStart`: that hook is held inside a
   * concurrency gate every request on this object waits behind, and it runs
   * after the container is up, which is too late to install interception.
   *
   * The Container base persists this configuration to its own storage and
   * re-applies it before each `container.start()`, so it is once per change.
   */
  async configureEgress(params: ProteusEgressParams): Promise<void> {
    // Per-host before catch-all: per-host wins at request time, and binding it
    // second would leave a window where a container event took the egress path.
    await this.setOutboundByHost(CONTAINER_EVENT_HOST, EVENT_HANDLER, params);
    await this.setOutboundHandler(EGRESS_HANDLER, params);
  }

  /**
   * Container-start hook. Restores `/workspace` and arms the periodic snapshot,
   * both under a hard budget — see `withContainerStartDeadline` for why an
   * unbounded await here resets the object and why detaching the work loses it.
   */
  onStart(): Promise<void> {
    return withContainerStartDeadline(
      "ProteusSandbox.onStart",
      WORKSPACE_RESTORE_DEADLINE_MS,
      () => this.#startWorkspace(),
      (failure) => console.error(
        "[proteus] container-start work settled after its budget:",
        failure.reason instanceof Error ? failure.reason.message : String(failure.reason),
      ),
    );
  }

  async #startWorkspace(): Promise<void> {
    await super.onStart();
    const outcome = await this.#workspaceSnapshots().restore();
    console.log(`[proteus] workspace restore: ${outcome.kind}`
      + (outcome.backupId === undefined ? "" : ` ${outcome.backupId} (${outcome.mode})`));
    await this.#armSnapshotSchedule();
  }

  /**
   * Periodic snapshot tick. Registered through `Container.schedule`, which the
   * SDK documents as the supported alternative to touching `alarm()`, and which
   * persists the task in this object's own SQL. That matters: the implementation
   * this replaces fired a floating `createBackup()` from the turn loop, and a
   * promise left floating in a Durable Object is cancelled on eviction with its
   * rejection swallowed by the runtime.
   *
   * Public because `Container.schedule` dispatches by method name.
   */
  async snapshotWorkspaceIfDue(): Promise<void> {
    const outcome = await this.#workspaceSnapshots().snapshotIfDue();
    // The container's alarm loop reduces a thrown scheduled callback to a
    // console.error, so failures are reported here AND persisted on the record.
    if (outcome.kind === "failed") {
      console.error(`[proteus] workspace snapshot failed: ${outcome.reason ?? "unknown"}`);
    }
    // Tasks are one-shot — the alarm loop deletes the row after running it — so
    // the period is maintained by rearming. Not while the container is down:
    // waking a sleeping container to ask whether it changed would keep it alive
    // forever, and the next container start arms the schedule again.
    if (outcome.kind !== "not-running") await this.#rearmSnapshotSchedule();
  }

  /** Drop this container's snapshot from R2 and forget it. Called when the
   *  workspace itself is deleted; without it the archive outlives the agent
   *  until the bucket's lifecycle rule notices. */
  async discardWorkspaceSnapshot(): Promise<void> {
    const state = await this.#readSnapshotState();
    if (state === null) return;
    await this.#deleteSnapshot(state.backup.id);
    await this.ctx.storage.delete(SNAPSHOT_STATE_KEY);
  }

  // ── ports ────────────────────────────────────────────────────────────────

  #workspaceSnapshots(): WorkspaceSnapshots {
    this.#snapshots ??= createWorkspaceSnapshots(this.#ports());
    return this.#snapshots;
  }

  #ports(): WorkspaceSnapshotPorts {
    return {
      containerRunning: () => this.ctx.container?.running === true,
      bucketBinding: () => this.#usesBucketBinding(),
      readState: () => this.#readSnapshotState(),
      writeState: async (state) => { await this.ctx.storage.put(SNAPSHOT_STATE_KEY, state); },
      createBackup: (options) => this.createBackup(mutableBackupOptions(options)),
      restoreBackup: async (backup) => await this.restoreBackup(backup),
      checkChanges: async (dir, since) => {
        const checked = await this.checkChanges(dir, since === undefined ? {} : { since });
        return { status: checked.status, version: checked.version };
      },
      // `/proc/mounts` via exec rather than readFile: the file is synthetic and
      // reports zero length, which a file service has no reason to humour.
      readMounts: async () => (await this.exec("cat /proc/mounts")).stdout ?? "",
      countWorkspaceEntries: async () =>
        (await this.listFiles(WORKSPACE_BACKUP_DIR)).files.length,
      archiveBytes: async (id) =>
        (await this.#bucket().head(snapshotObjectKeys(id).archive))?.size,
      declaredBytes: (id) => this.#declaredBytes(id),
      deleteSnapshot: (id) => this.#deleteSnapshot(id),
      now: () => Date.now(),
      log: (message) => console.log(`[proteus] ${message}`),
    };
  }

  /** True when snapshots move through the `BACKUP_BUCKET` binding rather than
   *  presigned URLs. Derived from what is configured, not from a switch: the
   *  presigned path is the one that restores by MOUNTING the archive, so it is
   *  preferred whenever its credentials exist. Both paths keep every secret
   *  inside this object — presigned mode hands the container a URL, never a key.
   *  (`mountBucket` is a different story and is deliberately unused here: s3fs
   *  needs the key itself written into the container's filesystem.) */
  #usesBucketBinding(): boolean {
    const { R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, BACKUP_BUCKET_NAME } = this.env;
    const presigned = filled(R2_ACCESS_KEY_ID) && filled(R2_SECRET_ACCESS_KEY)
      && filled(BACKUP_BUCKET_NAME) && filled(this.env.CLOUDFLARE_R2_ACCOUNT_ID);
    return !presigned;
  }

  #bucket(): R2Bucket {
    const bucket = this.env.BACKUP_BUCKET;
    if (bucket === undefined) {
      throw new Error(
        "BACKUP_BUCKET R2 binding is missing, so /workspace cannot be snapshotted or "
        + "verified. Add it to wrangler.jsonc.",
      );
    }
    return bucket;
  }

  async #declaredBytes(backupId: string): Promise<number | undefined> {
    const object = await this.#bucket().get(snapshotObjectKeys(backupId).metadata);
    if (object === null) return undefined;
    const parsed = v.safeParse(SnapshotMetadataSchema, await object.json());
    return parsed.success ? parsed.output.sizeBytes : undefined;
  }

  async #deleteSnapshot(backupId: string): Promise<void> {
    const keys = snapshotObjectKeys(backupId);
    await this.#bucket().delete([keys.archive, keys.metadata]);
  }

  async #readSnapshotState(): Promise<WorkspaceSnapshotState | null> {
    return await this.ctx.storage.get<WorkspaceSnapshotState>(SNAPSHOT_STATE_KEY) ?? null;
  }

  async #armSnapshotSchedule(): Promise<void> {
    if ((await this.listSchedules(SNAPSHOT_CALLBACK)).length > 0) return;
    await this.#rearmSnapshotSchedule();
  }

  async #rearmSnapshotSchedule(): Promise<void> {
    await this.schedule(BACKUP_MIN_INTERVAL_MS / 1000, SNAPSHOT_CALLBACK, null);
  }
}

/** `BackupOptions` as the SDK wants it. Core's policy makes `excludes` readonly,
 *  as a shared constant must be; the SDK's own signature takes a mutable array. */
interface SdkBackupOptions extends Omit<BackupOptions, 'excludes'> {
  excludes?: string[];
}

function mutableBackupOptions(options: BackupOptions): SdkBackupOptions {
  return {
    ...options,
    excludes: options.excludes === undefined ? undefined : [...options.excludes],
  };
}

function filled(value: string | undefined): boolean {
  return value !== undefined && value.length > 0;
}

ProteusSandbox.outboundHandlers = {
  // `ctx.params` is whatever the owning DO passed to `setOutboundHandler` /
  // `setOutboundByHost`. It is trusted input — the container cannot influence
  // it — but it arrives typed `unknown`, so it is PARSED rather than asserted,
  // and both handlers treat undefined as "not configured yet" and refuse. An
  // unconfigured container therefore cannot egress: `enableInternet = false`
  // with no handler bound means the platform denies everything.
  //
  // SAFETY: the runtime object IS this Worker's env. The SDK declares the
  // parameter by the generated `Cloudflare.Env` contract, which this project
  // leaves empty and populates as `Env` in env.d.ts instead, and `Env` is
  // assignable to it, so nothing is narrowed that the wrangler binding block
  // does not already guarantee.
  [EGRESS_HANDLER]: (request, env, ctx) => handleContainerEgress(
    request, env as Env, parseEgressParams(ctx),
  ),
  // SAFETY: as above — the same generated `Cloudflare.Env` contract names the
  // object this Worker declares as `Env`.
  [EVENT_HANDLER]: (request, env, ctx) => handleContainerEvent(
    request, env as Env, parseEgressParams(ctx),
  ),
};
