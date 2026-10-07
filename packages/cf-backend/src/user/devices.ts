import { Effect } from 'effect';
import {
  DEVICE_PTY_OPEN_METHOD, type DeviceExecOutput, NO_DEVICE_CONNECTED, watchedOutput, SEVERAL_DEVICES_CONNECTED, codexEgressAllowed, chatgptEgressAllowed, type RelayedProvider, isWorkspaceName, nanoid, type DeviceCheckpointHint, type DeviceConsentRequest, type JsonObject, type JsonValue, CapabilityDeniedError, ownerCaller, type UserCaller, type ResolvedCaller, DeviceSocketHub, DeviceRequestLedger, type ClaimedDeviceRequest, type DeviceCancelOutcome, randomToken, sha256Hex, type DeviceChatGptStatus, DEVICE_CONSENT_DENIED, DEVICE_CONSENT_UNANSWERED, DEVICE_TOKEN_ROTATION, DEVICE_UPDATE, cliArtifactPath, deviceUpdateState, readBuildStamp, type BuildStamp, type DeviceUpdateFrame, type DeviceUpdateState, DEVICE_CANCEL_METHOD, DEVICE_EXEC_ACK_METHOD, parseDeviceCancelAnswer, nextDeviceRequestId, DEVICE_METHOD, DEVICE_FRAMES, DEVICE_ERRORS, deviceFailure, deviceMethodHas, type DeviceTunnel, DEVICE_TIERS, SANDBOX_UNAVAILABLE, effectiveDeviceMode, parseDeviceTier, parseSandboxCapability, parseSandboxReason, sandboxReasonFix, sandboxCause, summarizeDeviceAction, type DeviceConsentDecision, type DeviceStatus, type DeviceFileScope, type DeviceFleetEntry, type DeviceSandboxStatus, type DeviceTier,
} from '@kinu.run/core';
import { attemptInItsWords, diagnostics, KinuError, renderThrownChain, settle, toKinuError } from '@kinu.run/core/obs';
import * as v from 'valibot';
import type { UserObjectHost } from './user-host';

interface DeviceConsentCheck {
  agentName: string;
  deviceId: string;
  method: string;
  params: JsonValue[];
  /** Present when the caller is the named workspace itself; the card then asks for the
   *  workspace's binding, which is what "always" records. */
  workspaceName?: string;
}

/** Measured from the last rotation (every accepted connect), so a copy of `device.json`
 *  that stops rotating expires on this clock. */
const DEVICE_TOKEN_TTL_MS = 180 * 24 * 60 * 60 * 1000;

const DEVICE_CONNECT_TICKET_TTL_MS = 60 * 1000;

const DEVICE_NAME_MAX_LENGTH = 80;

const MINTED_DEVICE_TOKEN = /^pdt_[A-Za-z0-9_-]{32,}$/;

function deviceCallFrame(deviceId: string, workspace: string | null, frameSandbox: JsonObject | null, opts: Parameters<UserDevices['deviceRpc']>[3]): NonNullable<Parameters<DeviceTunnel['rpc']>[2]> {
  const rpcOptions: NonNullable<Parameters<DeviceTunnel['rpc']>[2]> = { extra: { deviceId }, ...watchedOutput(opts) };

  if (opts?.checkpoint) {
    rpcOptions.extra = {
      ...rpcOptions.extra,
      checkpoint: {
        agent: workspace ?? opts.checkpoint.agent,
        turnId: opts.checkpoint.turnId,
        sessionId: opts.checkpoint.sessionId,
        dir: opts.checkpoint.dir,
      },
    };
  }

  if (frameSandbox !== null) rpcOptions.extra = { ...rpcOptions.extra, sandbox: frameSandbox };

  if (opts?.timeoutMs !== undefined) rpcOptions.timeoutMs = opts.timeoutMs;

  if (opts?.requestId !== undefined) rpcOptions.requestId = opts.requestId;

  return rpcOptions;
}

/** The agent a device call's consent is keyed on, or undefined when the call is not gated
 *  (stopping work, or an owner read of a consent-free method). */
function consentAgentFor(
  resolved: ResolvedCaller,
  claimed: string | undefined,
  call: { stopping: boolean; ownerRead: boolean },
): string | undefined {
  if (call.stopping) return undefined;

  if (resolved.kind !== 'workspace') return claimed;

  return call.ownerRead ? undefined : resolved.workspace;
}

export type DeviceCancellationOutcome = {
  requestId: string;
  outcome: DeviceCancelOutcome | 'failed';
  detail?: string;
};

const CancelledRequestIdSchema = v.pipe(v.string(), v.minLength(1));

/**
 * Every field past `type` is optional so older daemons still connect. Absent means absent:
 * a daemon that says nothing about sandboxing is refused commands rather than run unconfined.
 */
/** RFC 1035: a name is at most 255 octets. */
const HOSTNAME_MAX_LENGTH = 255;

export const DeviceHelloSchema = v.object({
  type: v.literal(DEVICE_FRAMES.hello),
  protocolVersion: v.optional(v.number()),
  features: v.optional(v.array(v.string())),
  os: v.optional(v.string()),
  hostname: v.optional(v.string()),
  /** The directory `kinu connect` ran in, and the machine's home.
   *  Absolute or ignored: a relative path names nothing the hub can scope a call to. */
  root: v.optional(v.string()),
  home: v.optional(v.string()),
  /** What the daemon proved at start. Words stay plain strings, narrowed by
   *  `sandboxVerdictFromHello`; a picklist would reject the whole HELLO over one unknown word. */
  sandbox: v.optional(v.object({
    capability: v.optional(v.nullable(v.string())),
    reason: v.optional(v.nullable(v.string())),
    reasonDetail: v.optional(v.nullable(v.string())),
    gpu: v.optional(v.array(v.string())),
  })),
  /** Where this machine keeps agent homes (`<home>/.kinu/agents`); the hub composes
   *  `<agentRoot>/<workspace>/home` per exec and never guesses a path. */
  agentRoot: v.optional(v.string()),
  /** Build stamp, `os.arch()`, and whether the owner allows pushed updates. All absent on older
   *  daemons, which get no UPDATE and keep the `daemon_outdated` reading. */
  version: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1))),
  arch: v.optional(v.string()),
  updateCheck: v.optional(v.boolean()),
  /** The daemon's runtime (`Bun 1.4.2`); a refusal holds until it changes. */
  runtime: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1))),
});

/** An object type rather than an interface, so it satisfies the row constraint `sqlx` puts
 *  on its result shape. */
type SandboxColumns = {
  sandbox_capability: string | null;
  sandbox_reason: string | null;
  sandbox_detail: string | null;
  sandbox_gpu: string | null;
};

/**
 * Unknown status words stay in the detail. No sandbox field means `daemon_outdated`; a proved
 * sandbox with no agent root cannot build a frame, so no command is promised a sandbox.
 */
function sandboxVerdictFromHello(
  hello: v.InferOutput<typeof DeviceHelloSchema>, agentRoot: string | null,
): SandboxVerdict {
  if (hello.sandbox === undefined) return { capability: 'files_only', reason: 'daemon_outdated', detail: null };
  const claimed = parseSandboxCapability(hello.sandbox.capability);

  if (claimed === 'sandboxed' && agentRoot === null) {
    return {
      capability: 'files_only',
      reason: 'daemon_outdated',
      detail: 'the daemon proved a sandbox but did not say where agent homes live',
    };
  }

  const word = hello.sandbox.reason ?? null;
  const line = hello.sandbox.reasonDetail ?? null;
  const reason = parseSandboxReason(word);

  if (reason === null && word !== null) {
    return { capability: claimed, reason, detail: line === null ? word : `${word}: ${line}` };
  }

  return { capability: claimed, reason, detail: line };
}

function absolutePathOrNull(value: string | undefined): string | null {
  const parsed = v.safeParse(AbsolutePathSchema, value);

  if (!parsed.success) return null;

  return parsed.output.replace(/\/+$/, '') || '/';
}

type SandboxVerdict = Pick<DeviceSandboxStatus, 'capability' | 'reason' | 'detail'>;

/** An absent or unrecognised word narrows to "not proved"; detail travels as written. */
function readSandboxColumns(row: SandboxColumns | undefined): SandboxVerdict & Pick<DeviceSandboxStatus, 'gpu'> {
  return {
    capability: parseSandboxCapability(row?.sandbox_capability),
    reason: parseSandboxReason(row?.sandbox_reason),
    detail: row?.sandbox_detail ?? null,
    gpu: v.parse(v.array(v.string()), JSON.parse(row?.sandbox_gpu ?? '[]')),
  };
}

/** Past PATH_MAX a path names no directory. */
const AbsolutePathSchema = v.pipe(v.string(), v.regex(/^\//), v.maxLength(4096));

export interface UserDevicesHost extends Pick<UserObjectHost, 'ctx' | 'env' | 'requireTier' | 'sqlx'> {
  chatgptSignIns(): Promise<ReadonlyArray<{ readonly id: string; readonly label: string; readonly status: DeviceChatGptStatus | null }>>;
}

/** The owner's machines: tunnels, tokens, consents, tiers and requests. */
export class UserDevices {
  // The reverse-WS tunnel from a user's machine terminates here, not on an agent, so every agent
  // can reach the device via `deviceRpc()`. A WebSocket cannot cross RPC; the worker forwards the upgrade.
  readonly _devices: DeviceSocketHub;

  /** Durable record of commands running on devices (see ./device-inflight.ts); the ledger owns the table. */
  readonly _inflight: DeviceRequestLedger;

  constructor(private readonly host: UserDevicesHost) {
    this._devices = new DeviceSocketHub(host.ctx);
    this._inflight = new DeviceRequestLedger(host.ctx.storage.sql);
  }

  /**
   * Verify + consume the connect ticket here so the upgrade is safe however it arrived, then rotate
   * the device token over the authenticated socket. A newcomer socket wins the slot.
   */
  async acceptDeviceSocket(request: Request, url: URL): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }

    const ticket = url.searchParams.get('ticket');
    const verified = ticket ? await this.verifyDeviceConnectTicket(await ownerCaller(this.host.env), ticket) : { ok: false as const };

    if (!verified.ok || !verified.deviceId) return new Response('unauthorized', { status: 401 });

    if (this._devices.isConnected(verified.deviceId)) {
      this.host.sqlx(`UPDATE user_devices SET replaced_at = ? WHERE id = ?`, Date.now(), verified.deviceId);
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    this._devices.accept(verified.deviceId, server);
    const now = Date.now();

    // Clear offline notices only on tracked workspaces; an unreachable one keeps its row for next accept.
    const label = this.deviceLabel(verified.deviceId);

    for (const { agent_name } of this.host.sqlx<{ agent_name: string }>(
      `SELECT agent_name FROM device_notice_pending`,
    )) {
      try {
        const workspace = this.host.env.OrchestratorAgent.get(
          this.host.env.OrchestratorAgent.idFromName(agent_name),
        );

        await workspace.announceDeviceAvailable({ id: verified.deviceId, label });
        this.host.sqlx(`DELETE FROM device_notice_pending WHERE agent_name = ?`, agent_name);
      } catch (cause) {
        diagnostics.event('device.available_announce_unreachable', {
          workspace: agent_name, error: renderThrownChain({ cause }),
        });
      }
    }

    this.host.sqlx(
      `UPDATE user_devices SET last_seen_at = ? WHERE id = ?`,
      now, verified.deviceId,
    );
    await this.devicesMoved();
    server.send(JSON.stringify({
      type: DEVICE_TOKEN_ROTATION,
      token: await this.rotateDeviceToken(verified.deviceId, verified.tokenWasCurrent === true),
    }));
    const init: ResponseInit & { webSocket: WebSocket } = { status: 101, webSocket: client };

    return new Response(null, init);
  }

  /** A grace is kept only when the machine used the current secret, so two copies of `device.json`
   *  cannot alternate. The absolute window restarts either way. */
  private async rotateDeviceToken(deviceId: string, keepGrace: boolean): Promise<string> {
    const token = `pdt_${randomToken(32)}`;
    const tokenHash = await sha256Hex(token);
    const now = Date.now();

    // Spending the grace retires the secret it replaced.
    if (!keepGrace) {
      const [dropped] = this.host.sqlx<{ token_hash: string }>(`SELECT token_hash FROM user_devices WHERE id = ?`, deviceId);
      this.retireDeviceTokens(deviceId, [dropped?.token_hash ?? null], now);
    }

    // One statement: right-hand sides read the old row, so `token_hash` is the prior secret.
    this.host.sqlx(
      `UPDATE user_devices
          SET prev_token_hash = CASE WHEN ? THEN token_hash ELSE NULL END,
              token_hash = ?,
              expires_at = ?
        WHERE id = ?`,
      keepGrace ? 1 : 0, tokenHash, now + DEVICE_TOKEN_TTL_MS, deviceId,
    );

    return token;
  }

  /** Kept for the token lifetime; an incident stays until the owner acknowledges it. */
  retireDeviceTokens(deviceId: string, hashes: ReadonlyArray<string | null>, now: number): void {
    this.host.sqlx(
      `DELETE FROM user_device_retired_tokens WHERE retired_at <= ? AND reuse_detected_at IS NULL`,
      now - DEVICE_TOKEN_TTL_MS,
    );

    for (const hash of hashes) {
      if (hash === null) continue;
      this.host.sqlx(
        `INSERT OR IGNORE INTO user_device_retired_tokens (token_hash, device_id, retired_at) VALUES (?, ?, ?)`,
        hash, deviceId, now,
      );
    }
  }

  /** Two copies of `device.json` exist and the hub cannot tell the owner's (RFC 9700 §4.14.2). */
  private async revokeOnTokenReuse(caller: UserCaller, tokenHash: string): Promise<void> {
    const [reused] = this.host.sqlx<{ device_id: string }>(
      `UPDATE user_device_retired_tokens SET reuse_detected_at = COALESCE(reuse_detected_at, ?)
        WHERE token_hash = ? AND device_id IN (SELECT id FROM user_devices WHERE revoked_at IS NULL)
        RETURNING device_id`,
      Date.now(), tokenHash,
    );

    if (!reused) return;
    diagnostics.event('device.token_reuse_revoked', { device: reused.device_id });
    await this.revokeDevice(caller, reused.device_id);
  }

  /**
   * Record a daemon's HELLO. Paths and agent root COALESCE so an older daemon can't erase them;
   * the sandbox verdict is per-boot, so silence overwrites a stale yes.
   */
  recordDeviceHello(deviceId: string, hello: v.InferOutput<typeof DeviceHelloSchema>): void {
    const agentRoot = absolutePathOrNull(hello.agentRoot);
    const verdict = sandboxVerdictFromHello(hello, agentRoot);
    this.host.sqlx(
      `UPDATE user_devices
          SET os = ?, hostname = ?, last_seen_at = ?,
              consented_root = COALESCE(?, consented_root),
              device_home = COALESCE(?, device_home),
              agent_root = COALESCE(?, agent_root),
              sandbox_capability = ?, sandbox_reason = ?, sandbox_detail = ?, sandbox_gpu = ?
        WHERE id = ?`,
      hello.os ?? null,
      hello.hostname !== undefined && hello.hostname.length <= HOSTNAME_MAX_LENGTH ? hello.hostname : null,
      Date.now(),
      absolutePathOrNull(hello.root),
      absolutePathOrNull(hello.home),
      agentRoot,
      verdict.capability,
      verdict.reason,
      verdict.detail,
      JSON.stringify(hello.sandbox?.gpu ?? []),
      deviceId,
    );

    // Per-boot fact like the sandbox verdict: silence overwrites, so an older CLI reads as itself.
    this.host.sqlx(
      `INSERT INTO user_device_builds (device_id, version, update_check)
         VALUES (?, ?, ?)
         ON CONFLICT(device_id) DO UPDATE SET
           version = excluded.version,
           update_check = excluded.update_check`,
      deviceId,
      hello.version ?? null,
      hello.updateCheck === false ? 0 : 1,
    );

    if (hello.runtime !== undefined) {
      this.host.sqlx(`DELETE FROM user_device_update_refusals WHERE device_id = ? AND runtime <> ?`, deviceId, hello.runtime);
    }

    this.host.sqlx(`DELETE FROM user_device_protocol_refusals WHERE device_id = ?`, deviceId);
  }

  /** Null when the deploy published no stamp or names no public origin. Read per HELLO: the stamp
   * changes with every deploy. */
  private async servedBuild(): Promise<string | null> {
    return (await this.servedStamp())?.version ?? null;
  }

  private async servedStamp(): Promise<BuildStamp | null> {
    const origin = this.host.env.CLI_PUBLIC_ORIGIN;

    if (!origin) return null;

    return readBuildStamp(this.host.env, origin);
  }

  /**
   * UPDATE frame for a daemon behind the served build, when its owner allows the push.
   * Null for no reported build, unbuilt platform, opted-out owner, refused build, or no checksum.
   */
  async deviceUpdateFrame(deviceId: string, hello: v.InferOutput<typeof DeviceHelloSchema>): Promise<DeviceUpdateFrame | null> {
    const stamp = await this.servedStamp();
    const served = stamp?.version ?? null;

    const [refusal] = this.host.sqlx<{ version: string }>(
      `SELECT version FROM user_device_update_refusals WHERE device_id = ?`, deviceId,
    );

    const state = deviceUpdateState({
      version: hello.version ?? null, updateCheck: hello.updateCheck !== false, refusedVersion: refusal?.version,
    }, served);

    if (state !== 'behind' || served === null || stamp === null) return null;
    const tarball = cliArtifactPath(hello.os, hello.arch);

    if (tarball === null) return null;
    // No signature over this artifact means no push: the daemon would refuse it.
    const sha256 = stamp.checksums?.[tarball];

    if (stamp.signature === undefined || stamp.checksums === undefined || sha256 === undefined || !/^[0-9a-f]{64}$/i.test(sha256)) return null;

    return {
      type: DEVICE_UPDATE, version: served, urls: { tarball, checksum: `${tarball}.sha256` }, sha256: sha256.toLowerCase(),
      checksums: stamp.checksums, signature: stamp.signature,
    };
  }

  /** The raw token is returned once to the CLI; only its hash is stored. 'Your PC' is the default
   * label. `replaces` is the machine's previous token, whose registration this one replaces. */
  async registerDevice(caller: UserCaller, label?: string, replaces?: string): Promise<{ deviceId: string; token: string }> {
    await this.host.requireTier(caller, 'device.manage');
    const replaced = replaces === undefined ? null : await this.deviceHoldingToken(caller, replaces);
    const deviceId = `dev-${nanoid(10)}`;
    const token = `pdt_${randomToken(32)}`;
    const tokenHash = await sha256Hex(token);
    const now = Date.now();
    const trimmedLabel = label?.trim().slice(0, DEVICE_NAME_MAX_LENGTH) ?? '';
    this.host.sqlx(
      `INSERT INTO user_devices (id, token_hash, label, created_at, expires_at) VALUES (?, ?, ?, ?, ?)`,
      deviceId, tokenHash, trimmedLabel === '' ? 'Your PC' : trimmedLabel, now, now + DEVICE_TOKEN_TTL_MS,
    );

    if (replaced !== null) await this.revokeDevice(caller, replaced);
    else await this.devicesMoved();

    return { deviceId, token };
  }

  /** Expired or not, holding the token proves the caller had that machine's `device.json`. */
  private async deviceHoldingToken(caller: UserCaller, token: string): Promise<string | null> {
    if (!MINTED_DEVICE_TOKEN.test(token)) return null;
    const tokenHash = await sha256Hex(token);

    const [held] = this.host.sqlx<{ id: string }>(
      `SELECT id FROM user_devices WHERE (token_hash = ? OR prev_token_hash = ?) AND revoked_at IS NULL LIMIT 1`,
      tokenHash, tokenHash,
    );

    if (held) return held.id;
    await this.revokeOnTokenReuse(caller, tokenHash);

    return null;
  }

  async renameDevice(caller: UserCaller, deviceId: string, name: string): Promise<{ ok: boolean }> {
    await this.host.requireTier(caller, 'device.manage');
    const trimmed = name.trim().slice(0, DEVICE_NAME_MAX_LENGTH);

    const row = trimmed ? this.host.sqlx<{ id: string }>(
      `SELECT id FROM user_devices WHERE id = ? AND revoked_at IS NULL LIMIT 1`, deviceId,
    )[0] : undefined;

    if (!row) return { ok: false };
    this.host.sqlx(`UPDATE user_devices SET label = ? WHERE id = ?`, trimmed, deviceId);
    await this.devicesMoved();

    return { ok: true };
  }

  /** The window is absolute from the last rotation; the superseded secret is a one-shot grace
   *  (see {@link acceptDeviceSocket}); `current` says which hash matched. */
  async verifyDeviceToken(caller: UserCaller, token: string): Promise<{ ok: boolean; deviceId?: string; current?: boolean }> {
    await this.host.requireTier(caller, 'device.manage');

    if (!MINTED_DEVICE_TOKEN.test(token)) return { ok: false };
    const tokenHash = await sha256Hex(token);

    const row = this.host.sqlx<{ id: string; expires_at: number | null; current: number; prev_token_hash: string | null }>(
      `SELECT id, expires_at, (token_hash = ?) AS current, prev_token_hash
         FROM user_devices
        WHERE (token_hash = ? OR prev_token_hash = ?) AND revoked_at IS NULL
        LIMIT 1`,
      tokenHash, tokenHash, tokenHash,
    )[0];

    if (!row) {
      await this.revokeOnTokenReuse(caller, tokenHash);

      return { ok: false };
    }

    if (row.expires_at !== null && row.expires_at <= Date.now()) return { ok: false };

    // Spent on the ticket it buys: a machine whose connect then fails is refused, not revoked.
    if (row.current === 1) this.retireDeviceTokens(row.id, [row.prev_token_hash], Date.now());
    this.host.sqlx(`UPDATE user_devices SET prev_token_hash = NULL WHERE id = ?`, row.id);

    return { ok: true, deviceId: row.id, current: row.current === 1 };
  }

  /** Exchange the daemon's long-lived token for a one-minute, single-use WebSocket ticket scoped to
   *  this UserDO. */
  async issueDeviceConnectTicket(caller: UserCaller, token: string): Promise<{ ok: boolean; ticket?: string; expiresAt?: number }> {
    await this.host.requireTier(caller, 'device.manage');
    const verified = await this.verifyDeviceToken(await ownerCaller(this.host.env), token);

    if (!verified.ok || !verified.deviceId) return { ok: false };
    const now = Date.now();
    this.host.sqlx(`DELETE FROM device_connect_tickets WHERE expires_at <= ? OR used_at IS NOT NULL`, now);
    const ticket = `pct_${randomToken(32)}`;
    const expiresAt = now + DEVICE_CONNECT_TICKET_TTL_MS;
    this.host.sqlx(
      `INSERT INTO device_connect_tickets
         (ticket_hash, device_id, expires_at, token_was_current)
       VALUES (?, ?, ?, ?)`,
      await sha256Hex(ticket),
      verified.deviceId,
      expiresAt,
      verified.current === true ? 1 : 0,
    );

    return { ok: true, ticket, expiresAt };
  }

  async recordDeviceUpdateRefusal(
    caller: UserCaller, token: string, refusal: { version: string; runtime: string; reason: string },
  ): Promise<boolean> {
    await this.host.requireTier(caller, 'device.manage');
    const verified = await this.verifyDeviceToken(await ownerCaller(this.host.env), token);

    if (!verified.ok || !verified.deviceId) return false;
    this.host.sqlx(
      `INSERT INTO user_device_update_refusals (device_id, version, runtime, reason, refused_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(device_id) DO UPDATE SET
           version = excluded.version,
           runtime = excluded.runtime,
           reason = excluded.reason,
           refused_at = excluded.refused_at`,
      verified.deviceId, refusal.version, refusal.runtime, refusal.reason, Date.now(),
    );
    diagnostics.event('device.update_refused', {
      device: verified.deviceId, version: refusal.version, runtime: refusal.runtime, reason: refusal.reason,
    });
    await this.devicesMoved();

    return true;
  }

  async verifyDeviceConnectTicket(caller: UserCaller, ticket: string): Promise<{ ok: boolean; deviceId?: string; tokenWasCurrent?: boolean }> {
    await this.host.requireTier(caller, 'device.manage');

    if (!/^pct_[A-Za-z0-9_-]{32,}$/.test(ticket)) return { ok: false };
    const now = Date.now();
    this.host.sqlx(`DELETE FROM device_connect_tickets WHERE expires_at <= ? OR used_at IS NOT NULL`, now);
    const ticketHash = await sha256Hex(ticket);

    const row = this.host.sqlx<{
      device_id: string; expires_at: number; used_at: number | null; token_was_current: number | null;
    }>(
      `SELECT device_id, expires_at, used_at, token_was_current
         FROM device_connect_tickets
        WHERE ticket_hash = ? LIMIT 1`,
      ticketHash,
    )[0];

    if (!row || row.used_at !== null || row.expires_at <= now) return { ok: false };
    this.host.sqlx(`UPDATE device_connect_tickets SET used_at = ? WHERE ticket_hash = ?`, now, ticketHash);

    const active = this.host.sqlx<{ id: string }>(
      `SELECT id FROM user_devices WHERE id = ? AND revoked_at IS NULL LIMIT 1`, row.device_id,
    )[0];

    if (!active) return { ok: false };

    // A null column (ticket predating it) reads as not proved current, so no grace is granted.
    return { ok: true, deviceId: row.device_id, tokenWasCurrent: row.token_was_current === 1 };
  }

  /** User-chosen names of live machines only; ids are routing, not for a person. */
  private connectedDeviceNames(): string[] {
    const live = this._devices.connectedDeviceIds();

    return this.host.sqlx<{ id: string; label: string }>(
      `SELECT id, label FROM user_devices WHERE revoked_at IS NULL`,
    ).filter((row) => live.includes(row.id)).map((row) => row.label);
  }

  deviceLabel(deviceId: string): string {
    return this.host.sqlx<{ label: string }>(`SELECT label FROM user_devices WHERE id = ?`, deviceId)[0]?.label ?? 'your device';
  }

  isActiveDevice(deviceId: string): boolean {
    return this.host.sqlx<{ id: string }>(
      `SELECT id FROM user_devices WHERE id = ? AND revoked_at IS NULL LIMIT 1`, deviceId,
    )[0] !== undefined;
  }

  /**
   * Unnamed call resolves to the only live machine; several live is an error naming them.
   * With none live, a workspace op is told the registered machines; `undefined` just reports none.
   */
  resolveDeviceForCall(
    requested: string | undefined,
    consentAgent: string | undefined,
  ): Effect.Effect<string, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const deviceId = yield* this.liveDeviceForCall(requested);

      if (deviceId) return deviceId;

      if (consentAgent !== undefined) yield* attemptInItsWords('io', () => this.announceDevicesUnavailable(consentAgent));

      return yield* Effect.fail(deviceFailure(DEVICE_ERRORS.disconnected, NO_DEVICE_CONNECTED));
    });
  }

  /** Revoked rows are excluded: revoked means gone, not offline. */
  private registeredOfflineDevices(): Array<{ id: string; label: string; lastSeenAt: number | null }> {
    const live = new Set(this._devices.connectedDeviceIds());

    return this.host.sqlx<{ id: string; label: string; last_seen_at: number | null }>(
      `SELECT id, label, last_seen_at FROM user_devices WHERE revoked_at IS NULL ORDER BY created_at ASC`,
    ).filter((row) => !live.has(row.id)).map((row) => ({
      id: row.id, label: row.label, lastSeenAt: row.last_seen_at,
    }));
  }

  /** The call still fails; the workspace is recorded so the next connect clears this notice. */
  private async announceDevicesUnavailable(workspaceOrAgent: string): Promise<void> {
    try {
      const stub = this.host.env.OrchestratorAgent.get(this.host.env.OrchestratorAgent.idFromName(workspaceOrAgent));

      await stub.announceDeviceUnavailable(this.registeredOfflineDevices());
      this.host.sqlx(
        `INSERT INTO device_notice_pending (agent_name) VALUES (?) ON CONFLICT (agent_name) DO NOTHING`,
        workspaceOrAgent,
      );
    } catch (error) {
      diagnostics.event('device.unavailable_announce_unreachable', {
        workspace: workspaceOrAgent, error: renderThrownChain({ cause: error }),
      });
    }
  }

  /** Null when none qualifies; an unnamed call with several live is reported as ambiguous. */
  private liveDeviceForCall(requested: string | undefined): Effect.Effect<string | null, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const deviceId = this._devices.connectedDeviceId(requested);

      if (deviceId) return deviceId;

      if (requested === undefined && this._devices.connectedDeviceIds().length > 1) {
        return yield* Effect.fail(deviceFailure(DEVICE_ERRORS.ambiguous, `${SEVERAL_DEVICES_CONNECTED}: ${this.connectedDeviceNames().join(', ')}`));
      }

      return null;
    });
  }

  async deviceRpc(
    caller: UserCaller,
    method: string,
    params: JsonValue[],
    opts?: {
      deviceId?: string; agentName?: string; checkpoint?: DeviceCheckpointHint;
      timeoutMs?: number; requestId?: string; backgroundJobId?: string;
      onOutput?: (output: DeviceExecOutput) => void | Promise<void>;
    },
  ): Promise<string | undefined> {
    const resolved = await this.host.requireTier(caller, 'device.rpc');

    return settle(Effect.gen({ self: this }, function* () {
      const proven = resolved.kind === 'workspace' ? resolved.workspace : null;

      if (proven !== null && deviceMethodHas(method, 'checkpointStore') && params[0] !== proven) {
        return yield* Effect.fail(new KinuError('denied', `workspace ${proven} reads and restores only its own device checkpoints`));
      }

      // Cancellation is never consent-gated: it only ends a command already allowed, and
      // gating it could leave a live process waiting on an unanswered card.
      const stopping = method === DEVICE_CANCEL_METHOD;
      const ownerRead = opts?.agentName === undefined && deviceMethodHas(method, 'consentFree');

      const consentAgent = consentAgentFor(resolved, opts?.agentName, { stopping, ownerRead });

      const deviceId = yield* this.resolveDeviceForCall(opts?.deviceId, consentAgent);

      if (!stopping && !this.isActiveDevice(deviceId)) return yield* Effect.fail(deviceFailure(DEVICE_ERRORS.disconnected, NO_DEVICE_CONNECTED));

      if (consentAgent !== undefined) {
        // Consent is keyed on the proven workspace, never the claimed name, so an agent cannot
        // ride a sibling workspace's grant.
        const consent = yield* attemptInItsWords('io', () => this.checkDeviceConsent({
          agentName: consentAgent, deviceId, method, params,
          workspaceName: resolved.kind === 'workspace' ? resolved.workspace : undefined,
        }));

        if (!consent.allowed) return yield* Effect.fail(new KinuError('denied', consent.reason));
      }

      const frameSandbox = deviceMethodHas(method, 'deviceView') ? yield* this.frameSandboxFor(method, deviceId, proven) : null;

      if (!stopping && !this.isActiveDevice(deviceId)) return yield* Effect.fail(deviceFailure(DEVICE_ERRORS.disconnected, NO_DEVICE_CONNECTED));
      const tunnel = this._devices.tunnel(deviceId);

      if (!tunnel) return yield* Effect.fail(deviceFailure(DEVICE_ERRORS.disconnected, NO_DEVICE_CONNECTED));
      const rpcOptions = deviceCallFrame(deviceId, proven, frameSandbox, opts);

      // Persist before sending: an insert after send races with eviction. Only a proven
      // workspace command carries a durable turn identity.
      const requestId = opts?.requestId;
      const durableExec = method === DEVICE_METHOD.exec && requestId !== undefined && resolved.kind === 'workspace';

      if (durableExec) yield* this.persistDeviceExec(tunnel, { requestId, deviceId, workspace: resolved.workspace }, opts);

      const result = yield* attemptInItsWords('io', () => tunnel.rpc(method, params, rpcOptions));

      // A tool's own cancel is recorded where a sweep would put it; the first answer wins.
      if (stopping) yield* this.recordToolPathCancellation(params, result);

      return result === undefined ? undefined : JSON.stringify(result);
    }));
  }

  private persistDeviceExec(tunnel: DeviceTunnel, call: { requestId: string; deviceId: string; workspace: string }, opts: Parameters<UserDevices['deviceRpc']>[3]): Effect.Effect<void, KinuError> {
    const { requestId, deviceId, workspace } = call;

    return Effect.gen({ self: this }, function* () {
      // Probe with a fresh id, never the command's own: ACKing a retry's id before replay
      // would delete its retained terminal result.
      yield* attemptInItsWords('io', () => tunnel.rpc(DEVICE_EXEC_ACK_METHOD, [nextDeviceRequestId()]));

      // A revocation sweep can land during the probe await; recheck so no command runs
      // with nothing left to cancel or count it.
      if (!this.isActiveDevice(deviceId)) return yield* Effect.fail(deviceFailure(DEVICE_ERRORS.disconnected, NO_DEVICE_CONNECTED));
      // A command inside a detached scope belongs to the background job from insert.
      // A blank owner is refused: neither turn nor job sweep could ever select that row.
      const backgroundJobId = opts?.backgroundJobId ?? null;

      if (backgroundJobId === '') {
        return yield* Effect.fail(new KinuError('bad_input', 'A background job id must name a job.'));
      }

      this._inflight.insert({
        requestId,
        deviceId,
        workspace: workspace,
        turnId: opts?.checkpoint?.turnId ?? null,
        backgroundJobId,
      });
    });
  }

  /** The machine carrying `provider` for a web session: for Codex the first daemon with the relay, for the
   *  ChatGPT plan the first holding its own sign-in with plan usage. */
  async relayDevice(caller: UserCaller, provider: RelayedProvider): Promise<{ readonly id: string; readonly label: string } | null> {
    await this.host.requireTier(caller, 'credentials.model');

    if (provider === 'codex') {
      const deviceId = this._devices.relayDevice();

      return deviceId === null || !this.isActiveDevice(deviceId) ? null : { id: deviceId, label: this.deviceLabel(deviceId) };
    }

    const signedIn = (await this.host.chatgptSignIns()).find(({ status }) => status?.signedIn === true);

    return signedIn === undefined ? null : { id: signedIn.id, label: signedIn.label };
  }

  async relayModelCall(caller: UserCaller, deviceId: string, callId: string, request: Request): Promise<Response> {
    await this.host.requireTier(caller, 'credentials.model');

    return settle(Effect.gen({ self: this }, function* () {
      const target = { method: request.method, url: request.url };
      const allowed = codexEgressAllowed(target) || chatgptEgressAllowed(target);
      const body = allowed && request.body !== null ? yield* attemptInItsWords('io', () => request.text()) : null;

      // No await from here to the send.
      if (!allowed) return yield* Effect.fail(new KinuError('denied', `the provider relay does not carry ${request.method} ${new URL(request.url).pathname}`));

      if (!this.isActiveDevice(deviceId)) return yield* Effect.fail(deviceFailure(DEVICE_ERRORS.disconnected, NO_DEVICE_CONNECTED));

      return yield* attemptInItsWords('unavailable', () => this._devices.relay(deviceId, callId, { method: request.method, url: request.url, headers: [...request.headers], body }));
    }));
  }

  async cancelModelRelay(caller: UserCaller, callId: string): Promise<void> {
    await this.host.requireTier(caller, 'credentials.model');
    await this._devices.cancelRelay(callId);
  }

  /** `agentHome` is empty only under the raw tier. */
  private frameSandboxFor(method: string, deviceId: string, workspace: string | null): Effect.Effect<JsonObject, KinuError> {
    return Effect.gen({ self: this }, function* () {
      const sandbox = this.deviceSandboxFor(deviceId, workspace);

      // Neither end ever downgrades a sandboxed command to raw; files need no kernel.
      if ((method === 'exec' || method === DEVICE_PTY_OPEN_METHOD) && effectiveDeviceMode(sandbox) === 'files_only') {
        return yield* Effect.fail(deviceFailure(DEVICE_ERRORS.sandboxUnavailable, this.sandboxRefusal(deviceId, sandbox, sandboxCause(sandbox))));
      }

      if (sandbox.tier === 'sandboxed' && sandbox.agentHome === null) {
        return yield* Effect.fail(deviceFailure(DEVICE_ERRORS.sandboxUnavailable, this.sandboxRefusal(deviceId, sandbox, workspace === null
          ? 'an agent home belongs to a workspace, and this call has none'
          : 'the daemon did not report where agent homes live')));
      }

      return { tier: sandbox.tier, agentHome: sandbox.agentHome ?? '', roots: [...sandbox.roots] };
    });
  }

  /** Store the answer from a forwarded cancellation so the durable authority holds one outcome per request.
   *  An answer that does not name the requested id is neither stored nor returned; the row stays live. */
  private recordToolPathCancellation(params: JsonValue[], result: JsonValue | undefined): Effect.Effect<void, KinuError> {
    const requestId = v.safeParse(CancelledRequestIdSchema, params[0]);

    if (!requestId.success) return Effect.void;

    return Effect.try({
      try: () => parseDeviceCancelAnswer(requestId.output, result),
      catch: (cause) => cause instanceof KinuError ? cause : new KinuError('io', 'read the device cancellation', { cause }),
    }).pipe(Effect.map((answer) => this._inflight.settleUnclaimed(requestId.output, answer.cancelled)));
  }

  /**
   * Cloud-side acceptance of one exec result: acks the daemon, then removes the durable row.
   * A claimed row belongs to an in-flight cancellation, which owns the terminal outcome and ack.
   */
  async acknowledgeDeviceRequest(caller: UserCaller, requestId: string): Promise<void> {
    const resolved = await this.host.requireTier(caller, 'device.rpc');

    return settle(Effect.gen({ self: this }, function* () {

      if (resolved.kind !== 'workspace' || requestId === '') return;
      const held = this._inflight.acknowledgeable(requestId, resolved.workspace);

      if (!held) return;
      const tunnel = this._devices.tunnel(held.deviceId);

      if (!tunnel) return yield* Effect.fail(deviceFailure(DEVICE_ERRORS.disconnected, NO_DEVICE_CONNECTED));
      yield* attemptInItsWords('io', () => tunnel.rpc(DEVICE_EXEC_ACK_METHOD, [requestId]));
      this._inflight.deleteAcknowledged({
        requestId, workspace: resolved.workspace, deviceId: held.deviceId,
      });
    }));
  }

  /**
   * Stop every live device command of one durable turn after a fresh actor activation.
   * Rows with no turn id are excluded so Stop never widens into a workspace sweep.
   */
  async cancelDeviceRequestsForTurn(
    caller: UserCaller,
    turnId: string,
  ): Promise<DeviceCancellationOutcome[]> {
    // Claim atomically before any device await, so a parallel detach to a background job
    // cannot race this sweep.
    return this.cancelClaimedDeviceRequests(caller, turnId,
      (workspace) => this._inflight.claimTurnRequests(workspace, turnId));
  }

  private async cancelClaimedDeviceRequests(
    caller: UserCaller,
    scopeId: string,
    claim: (workspace: string) => ClaimedDeviceRequest[],
  ): Promise<DeviceCancellationOutcome[]> {
    const resolved = await this.host.requireTier(caller, 'device.rpc');

    if (resolved.kind !== 'workspace' || scopeId === '') return [];

    return this.cancelDeviceRequests(claim(resolved.workspace));
  }

  /** Move one live device request to its background job; per request because a turn can hold
   *  several parallel device calls and only the detaching one changes hands. */
  async transferDeviceRequestToBackgroundJob(
    caller: UserCaller,
    requestId: string,
    jobId: string,
  ): Promise<{ transferred: boolean }> {
    const resolved = await this.host.requireTier(caller, 'device.rpc');

    if (resolved.kind !== 'workspace' || requestId === '' || jobId === '') return { transferred: false };

    return this._inflight.transferToBackgroundJob({
      requestId, workspace: resolved.workspace, jobId,
    });
  }

  async cancelDeviceRequestsForBackgroundJob(
    caller: UserCaller,
    jobId: string,
  ): Promise<DeviceCancellationOutcome[]> {
    return this.cancelClaimedDeviceRequests(caller, jobId,
      (workspace) => this._inflight.claimBackgroundJobRequests(workspace, jobId));
  }

  private async cancelDeviceRequests(rows: ClaimedDeviceRequest[]): Promise<DeviceCancellationOutcome[]> {
    const outcomes: DeviceCancellationOutcome[] = [];

    for (const row of rows) {
      // Re-read before any frame: ownership or an answer (e.g. from a tool's own abort via
      // `deviceRpc`) may have changed while an earlier row was awaiting.
      const held = this._inflight.held(row.requestId, row.claim);

      if (held === null) continue;

      if (held.settled !== null) {
        outcomes.push({ requestId: row.requestId, outcome: held.settled });
        await this.cleanUpSettledDeviceRequest(row);
        continue;
      }

      const tunnel = this._devices.tunnel(row.deviceId);

      if (!tunnel) {
        this._inflight.releaseClaim(row.requestId, row.claim);
        outcomes.push({ requestId: row.requestId, outcome: 'failed', detail: NO_DEVICE_CONNECTED });
        continue;
      }

      try {
        const answer = parseDeviceCancelAnswer(row.requestId, await tunnel.rpc(
          DEVICE_CANCEL_METHOD, [row.requestId],
        )).cancelled;

        // Persist before the ack, which can fail. No row updated means the terminal authority took
        // the claim and reports the request; the returned answer is the one that stands.
        const settled = this._inflight.settleHeld(row.requestId, row.claim, answer);

        if (settled === null) continue;
        outcomes.push({ requestId: row.requestId, outcome: settled });
        await this.cleanUpSettledDeviceRequest(row);
      } catch (err) {
        // Kill failed, so the request is still live. Releasing nothing means the terminal authority
        // took or dropped the row and answers for it.
        if (!this._inflight.releaseClaim(row.requestId, row.claim)) continue;
        outcomes.push({
          requestId: row.requestId,
          outcome: 'failed',
          detail: renderThrownChain({ cause: err }),
        });
      }
    }

    return outcomes;
  }

  /**
   * Release the daemon's supervisor, then drop the row. Cleanup failure is not cancellation
   * failure: the stored answer stands and the claim is returned so a later sweep can retry.
   */
  private async cleanUpSettledDeviceRequest(row: ClaimedDeviceRequest): Promise<void> {
    const tunnel = this._devices.tunnel(row.deviceId);

    try {
      if (!tunnel) throw deviceFailure(DEVICE_ERRORS.disconnected, NO_DEVICE_CONNECTED);
      await tunnel.rpc(DEVICE_EXEC_ACK_METHOD, [row.requestId]);
      this._inflight.deleteHeld(row.requestId, row.claim);
    } catch (err) {
      this._inflight.releaseClaim(row.requestId, row.claim);
      diagnostics.failure('device.cancellation_ack_cleanup_failed', toKinuError({
        doing: 'releasing the cancelled device command supervisor',
        cause: err,
        otherwise: 'unavailable',
      }), { device: row.deviceId, request: row.requestId });
    }
  }

  /** Agent home is composed per call from the root the daemon reported, for one workspace segment. */
  private deviceSandboxFor(deviceId: string, workspace: string | null): DeviceSandboxStatus & { deviceHome: string | null } {
    const row = this.host.sqlx<SandboxColumns & { tier: string | null; agent_root: string | null; consented_root: string | null; device_home: string | null }>(
      `SELECT tier, sandbox_capability, sandbox_reason, sandbox_detail, sandbox_gpu, agent_root, consented_root, device_home
         FROM user_devices WHERE id = ?`, deviceId,
    )[0];

    const agentRoot = row?.agent_root ?? null;
    const named = workspace !== null && isWorkspaceName(workspace) && workspace !== '.' && workspace !== '..';
    const consented = row?.consented_root ?? null;

    return {
      // Consent to `/` is the whole machine: the switch off.
      tier: consented === '/' ? 'raw' : parseDeviceTier(row?.tier),
      ...readSandboxColumns(row),
      agentHome: agentRoot !== null && named ? `${agentRoot}/${workspace}/home` : null,
      roots: consented === null ? [] : [consented],
      deviceHome: row?.device_home ?? null,
    };
  }

  private sandboxRefusal(deviceId: string, sandbox: DeviceSandboxStatus, cause: string): string {
    return `${SANDBOX_UNAVAILABLE}: ${this.deviceLabel(deviceId)} cannot run commands: `
      + `its Kinu daemon could not start a sandbox (${cause}), and Kinu never runs a command `
      + `unsandboxed unless the owner asked for that. ${sandboxReasonFix(sandbox.reason)} `
      + 'The owner can also turn Sandbox off for this device on the Devices page, '
      + 'which runs commands as them with full access to the machine. '
      + 'Reading and writing files on the device still works.';
  }

  /** Owner session only: a workspace holding `device.manage` must not turn off its own sandbox. */
  async setDeviceTier(caller: UserCaller, deviceId: string, tier: DeviceTier): Promise<{ ok: boolean }> {
    const resolved = await this.host.requireTier(caller, 'device.manage');

    if (resolved.kind !== 'owner_session') {
      throw new CapabilityDeniedError('Only the account owner can change a device\'s Sandbox setting.');
    }

    if (!v.is(v.picklist(DEVICE_TIERS), tier)) return { ok: false };

    const row = this.host.sqlx<{ id: string }>(
      `SELECT id FROM user_devices WHERE id = ? AND revoked_at IS NULL LIMIT 1`, deviceId,
    )[0];

    if (!row) return { ok: false };
    this.host.sqlx(`UPDATE user_devices SET tier = ? WHERE id = ?`, tier, deviceId);
    await this.devicesMoved();

    return { ok: true };
  }

  /** No tier here: what a bound workspace may touch is the device's Sandbox switch, owner-set. */
  private getDeviceBinding(agentName: string, deviceId: string): 'allow' | 'deny' | null {
    const row = this.host.sqlx<{ policy: string }>(
      `SELECT policy FROM device_consent WHERE agent_name = ? AND device_id = ?`, agentName, deviceId,
    )[0];

    if (row?.policy !== 'allow' && row?.policy !== 'deny') return null;

    return row.policy;
  }

  private setDeviceBinding(
    agentName: string,
    deviceId: string,
    policy: 'allow' | 'deny',
    lastAction?: { method: string; command: string },
  ): void {
    this.host.sqlx(
      `INSERT INTO device_consent
         (agent_name, device_id, policy, last_method, last_summary, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(agent_name, device_id) DO UPDATE SET
         policy = excluded.policy,
         last_method = excluded.last_method,
         last_summary = excluded.last_summary,
         updated_at = excluded.updated_at`,
      agentName, deviceId, policy,
      lastAction?.method ?? null, lastAction?.command ?? null, Date.now(),
    );
  }

  /**
   * Is this workspace bound to this device? Fails closed, but `reason` distinguishes a refusal from
   * an unanswered prompt, so an unattended agent does not read an expiry as a revoked capability.
   */
  private async checkDeviceConsent(check: DeviceConsentCheck): Promise<{ allowed: true } | { allowed: false; reason: string }> {
    const { agentName, deviceId, method, params, workspaceName } = check;

    const bound = this.getDeviceBinding(agentName, deviceId);

    if (bound === 'allow') return { allowed: true };

    if (bound === 'deny') return { allowed: false, reason: DEVICE_CONSENT_DENIED };
    const action = summarizeDeviceAction(method, params);
    let decision: DeviceConsentDecision;

    try {
      const stub = this.host.env.OrchestratorAgent.get(this.host.env.OrchestratorAgent.idFromName(agentName));

      const base: DeviceConsentRequest = {
        deviceId,
        deviceLabel: this.deviceLabel(deviceId),
        method: action.method,
        command: action.command,
      };

      const request: DeviceConsentRequest = workspaceName
        ? { ...base, workspaceName }
        : base;

      decision = await stub.awaitDeviceConsent(request);
    } catch (error) {
      // Nobody was asked, so this is the unanswered case, not a refusal.
      diagnostics.event('device.consent_unreachable', { error: renderThrownChain({ cause: error }) });

      return { allowed: false, reason: DEVICE_CONSENT_UNANSWERED };
    }

    // Only "always" is remembered; "once", "deny" and "timeout" are per-call.
    if (decision === 'deny') return { allowed: false, reason: DEVICE_CONSENT_DENIED };

    if (decision === 'timeout') return { allowed: false, reason: DEVICE_CONSENT_UNANSWERED };

    if (decision === 'always') {
      this.setDeviceBinding(agentName, deviceId, 'allow', action);
      await this.devicesMoved();
    }

    return { allowed: true };
  }

  async listDeviceConsents(caller: UserCaller): Promise<Array<{
    agentName: string;
    deviceId: string;
    policy: string;
    lastMethod: string | null;
    lastSummary: string | null;
  }>> {
    await this.host.requireTier(caller, 'device.consent');

    return this.host.sqlx<{
      agent_name: string; device_id: string; policy: string;
      last_method: string | null; last_summary: string | null;
    }>(
      `SELECT agent_name, device_id, policy, last_method, last_summary
       FROM device_consent ORDER BY updated_at DESC`,
    ).map((r) => ({
      agentName: r.agent_name,
      deviceId: r.device_id,
      policy: r.policy,
      lastMethod: r.last_method,
      lastSummary: r.last_summary,
    }));
  }

  /** Deletes the row (not 'deny') so the next call asks again; takes effect on that next call.
   *  Not a stop: running commands continue. `revokeDevice` ends live commands. */
  async revokeDeviceConsent(caller: UserCaller, agentName: string, deviceId: string): Promise<{ ok: boolean }> {
    await this.host.requireTier(caller, 'device.consent');

    if (!agentName || !deviceId) return { ok: false };
    this.host.sqlx(`DELETE FROM device_consent WHERE agent_name = ? AND device_id = ?`, agentName, deviceId);
    await this.devicesMoved();

    return { ok: true };
  }

  /** Unconfined only when the owner turned the device's Sandbox switch off; one switch governs
   *  both the daemon and the hub-side path scope so shell and file views cannot drift. */
  async getDeviceFileView(
    caller: UserCaller, agentName: string, device?: string,
  ): Promise<{ scope: DeviceFileScope }> {
    const resolved = await this.host.requireTier(caller, 'device.consent.read_self');
    // Per machine. Unnamed resolves the only live machine; several with none named is "confined".
    const deviceId = this._devices.connectedDeviceId(device);

    if (!deviceId) return { scope: 'root' };
    // A workspace caller's identity is its token, never its argument, so a facet cannot read a
    // sibling's answer.
    const workspace = resolved.kind === 'workspace' ? resolved.workspace : agentName;
    const { tier } = this.deviceSandboxFor(deviceId, workspace);

    if (tier === 'sandboxed') return { scope: 'sandboxed' };

    return { scope: this.getDeviceBinding(workspace, deviceId) === 'allow' ? 'unconfined' : 'root' };
  }

  /** Revoked rows are hidden, except those with an incident, visible until the owner acknowledges
   *  them; `revokedAt` tells the UI not to offer connect/rename controls. */
  async listDevices(caller: UserCaller): Promise<Array<{
    id: string; label: string; os: string | null; hostname: string | null;
    connected: boolean; createdAt: number; lastSeenAt: number | null; expiresAt: number | null;
    replacedAt: number | null;
    revokedAt: number | null; unstoppedAt: number | null; reuseDetectedAt: number | null;
    wholeMachine: boolean;
    /** No home or roots here: those are per workspace, and this is the account's device registry. */
    sandbox: Pick<DeviceSandboxStatus, 'tier' | 'capability' | 'reason' | 'detail' | 'gpu'>;
    version: string | null;
    servedVersion: string | null;
    update: DeviceUpdateState;
    updateRefusal: string | null;
  }>> {
    await this.host.requireTier(caller, 'device.manage');
    const served = await this.servedBuild();

    return this.host.sqlx<SandboxColumns & {
      id: string; label: string; os: string | null; hostname: string | null;
      created_at: number; last_seen_at: number | null; expires_at: number | null;
      replaced_at: number | null;
      revoked_at: number | null; unstopped_at: number | null; reuse_detected_at: number | null;
      tier: string | null; version: string | null; update_check: number | null; consented_root: string | null;
      refused_version: string | null; refusal_reason: string | null; protocol_refused: string | null;
    }>(`SELECT d.id, d.label, d.os, d.hostname, d.created_at, d.last_seen_at, d.expires_at,
               d.replaced_at, d.revoked_at, d.unstopped_at, x.reuse_detected_at,
               d.consented_root,
               d.tier, d.sandbox_capability, d.sandbox_reason, d.sandbox_detail, d.sandbox_gpu,
               b.version, b.update_check, f.version AS refused_version, f.reason AS refusal_reason,
               p.device_id AS protocol_refused
          FROM user_devices d
          LEFT JOIN user_device_builds b ON b.device_id = d.id
          LEFT JOIN user_device_update_refusals f ON f.device_id = d.id
          LEFT JOIN user_device_protocol_refusals p ON p.device_id = d.id
          LEFT JOIN (SELECT device_id, MAX(reuse_detected_at) AS reuse_detected_at
                       FROM user_device_retired_tokens WHERE reuse_detected_at IS NOT NULL
                      GROUP BY device_id) x ON x.device_id = d.id
         WHERE d.revoked_at IS NULL OR d.unstopped_at IS NOT NULL OR x.reuse_detected_at IS NOT NULL
         ORDER BY d.created_at DESC`)
      .map((r) => {
        const update = deviceUpdateState({
          version: r.version, updateCheck: r.update_check !== 0, refusedVersion: r.refused_version, protocolRefused: r.protocol_refused !== null,
        }, served);

        return {
          id: r.id, label: r.label, os: r.os, hostname: r.hostname,
          connected: r.revoked_at === null && this._devices.isConnected(r.id),
          createdAt: r.created_at, lastSeenAt: r.last_seen_at, expiresAt: r.expires_at,
          replacedAt: r.replaced_at,
          revokedAt: r.revoked_at, unstoppedAt: r.unstopped_at, reuseDetectedAt: r.reuse_detected_at,
          wholeMachine: r.consented_root === '/',
          sandbox: { tier: parseDeviceTier(r.tier), ...readSandboxColumns(r) },
          version: r.version,
          servedVersion: served,
          update,
          updateRefusal: update === 'refused' ? r.refusal_reason : null,
        };
      });
  }

  async watchDeviceStatus(caller: UserCaller, watching: boolean): Promise<void> {
    const resolved = await this.host.requireTier(caller, 'device.rpc');

    if (resolved.kind !== 'workspace') return;

    if (watching) this.host.sqlx(`INSERT OR IGNORE INTO device_status_watchers (agent_name) VALUES (?)`, resolved.workspace);
    else this.host.sqlx(`DELETE FROM device_status_watchers WHERE agent_name = ?`, resolved.workspace);
  }

  /** A watcher with no page open, or unreachable, drops. */
  async devicesMoved(): Promise<void> {
    const watchers = this.host.sqlx<{ agent_name: string }>(`SELECT agent_name FROM device_status_watchers`);

    await Promise.all(watchers.map(async ({ agent_name }) => {
      let watching = false;

      try {
        const workspace = this.host.env.OrchestratorAgent.get(this.host.env.OrchestratorAgent.idFromName(agent_name));
        watching = (await workspace.devicesMoved()).watching;
      } catch (cause) {
        diagnostics.event('device.watcher_unreachable', { workspace: agent_name, error: renderThrownChain({ cause }) });
      }

      if (!watching) this.host.sqlx(`DELETE FROM device_status_watchers WHERE agent_name = ?`, agent_name);
    }));
  }

  /**
   * Toolchain is probed on status read, not in the HELLO handler: the reply arrives on that socket,
   * so awaiting it there would deadlock. Kept separate from `listDevices` to avoid a device round-trip.
   */
  /** Null once removed; asks no machine anything. */
  async deviceName(caller: UserCaller, deviceId: string): Promise<string | null> {
    await this.host.requireTier(caller, 'device.rpc');

    return this.host.sqlx<{ label: string }>(`SELECT label FROM user_devices WHERE id = ?`, deviceId)[0]?.label ?? null;
  }

  async deviceRuntimeStatus(caller: UserCaller): Promise<DeviceStatus> {
    const resolved = await this.host.requireTier(caller, 'device.rpc');
    const workspace = resolved.kind === 'workspace' ? resolved.workspace : null;
    // Names and liveness are visible before any grant; seeing grants nothing, every call still goes
    // through the consent chokepoint. Answered per machine: each has its own toolchain, sandbox, grant.
    const now = Date.now();

    const devices = await Promise.all(this.deviceFleet().map(async (device): Promise<DeviceFleetEntry> => {
      if (!device.connected) return device;
      // The sandbox verdict query already holds the consented root and device home; no second SELECT.
      const { deviceHome, ...sandbox } = this.deviceSandboxFor(device.id, workspace);

      const reach: DeviceFleetEntry = {
        ...device,
        toolchain: await this._devices.probeToolchain(device.id, now),
        sandbox,
        consentedRoot: sandbox.roots[0] ?? null,
        deviceHome,
      };

      return workspace === null
        ? reach
        : { ...reach, granted: this.getDeviceBinding(workspace, device.id) === 'allow' };
    }));

    const live = devices.filter((device) => device.connected);

    if (live.length === 0) {
      return { connected: false, registered: devices.length > 0, toolchain: null, devices };
    }

    // Single-machine fields are absent when several machines are live; per-device entries carry them.
    if (live.length > 1) return { connected: true, registered: true, toolchain: null, devices };
    const only = live[0];

    if (!only) return { connected: false, registered: devices.length > 0, toolchain: null, devices };

    const status: DeviceStatus = {
      connected: true,
      registered: true,
      toolchain: only.toolchain ?? null,
      devices,
      consentedRoot: only.consentedRoot ?? null,
      deviceHome: only.deviceHome ?? null,
      // Per caller, not per device: home and roots depend on the workspace.
      sandbox: only.sandbox,
    };

    if (only.granted !== undefined) status.workspaceGranted = only.granted;

    return status;
  }

  /** Pre-grant view of registered devices. Order is newest first and stable across reads:
   *  two renders of the same fleet must be the same bytes. */
  private deviceFleet(): DeviceFleetEntry[] {
    return this.host.sqlx<{ id: string; label: string; os: string | null; hostname: string | null }>(
      `SELECT id, label, os, hostname FROM user_devices
        WHERE revoked_at IS NULL ORDER BY created_at DESC, id ASC`,
    ).map((r) => ({
      id: r.id,
      name: r.label,
      os: r.os,
      hostname: r.hostname,
      connected: this._devices.isConnected(r.id),
    }));
  }

  /** Records every unconfirmed command on the owner-visible device row before removing its active row,
   *  since a revoked daemon cannot reconnect to act on it. A close is not proof a process stopped. */
  async revokeDevice(
    caller: UserCaller,
    deviceId: string,
  ): Promise<{ ok: boolean; unstoppedCommands: number }> {
    await this.host.requireTier(caller, 'device.manage');
    // Coalesce concurrent revokes of one device: two sweeps sharing the row could let a confirmed
    // sweep erase unconfirmed commands the other reported. A DO serializes nothing across an await.
    const inFlight = this._revoking.get(deviceId);

    if (inFlight) return inFlight;
    const task = this.sweepAndRevokeDevice(deviceId);
    this._revoking.set(deviceId, task);

    try {
      const revoked = await task;
      await this.devicesMoved();

      return revoked;
    } finally { this._revoking.delete(deviceId); }
  }

  private readonly _revoking = new Map<string, Promise<{ ok: boolean; unstoppedCommands: number }>>();

  private async sweepAndRevokeDevice(
    deviceId: string,
  ): Promise<{ ok: boolean; unstoppedCommands: number }> {
    const now = Date.now();
    // Close admission before the first cancellation await; a device RPC resuming after its consent
    // await rechecks this durable state before send.
    this.host.sqlx(
      `UPDATE user_devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL`,
      now, deviceId,
    );
    // Revocation takes the claim from any in-flight sweep; a displaced sweep keeps reporting what it
    // observed and its guarded cleanup finds the row already gone.
    const rows = this._inflight.claimEveryRequestOf(deviceId);

    // Written before the first await so an activation dying mid-sweep leaves a visible unconfirmed
    // marker. `now` is this sweep's provisional value; only it is cleared on success.
    if (rows.length > 0) {
      this.host.sqlx(`UPDATE user_devices SET unstopped_at = ? WHERE id = ?`, now, deviceId);
    }

    let unstoppedCommands = 0;
    const tunnel = this._devices.tunnel(deviceId);

    for (const row of rows) {
      // A stored answer means nothing runs under this request, so it is not an unstopped command;
      // its cleanup is still owed.
      const settled = row.settled;

      if (!tunnel) {
        if (settled === null) unstoppedCommands += 1;
        continue;
      }

      try {
        if (settled === null) {
          const answer = parseDeviceCancelAnswer(row.requestId, await tunnel.rpc(
            DEVICE_CANCEL_METHOD, [row.requestId],
          )).cancelled;

          // Durable before the acknowledgement, so a dying activation leaves an answer, not
          // apparent live work.
          this._inflight.settleRevoked(row.requestId, answer);
        }

        try {
          await tunnel.rpc(DEVICE_EXEC_ACK_METHOD, [row.requestId]);
        } catch (err) {
          // Kill confirmation is already truthful; this is local replay cleanup, recorded separately so a
          // failed ACK never reads as a possibly running process.
          diagnostics.failure('device.revocation_ack_cleanup_failed', toKinuError({
            doing: 'releasing the cancelled device command supervisor on revocation',
            cause: err,
            otherwise: 'unavailable',
          }), { device: deviceId, request: row.requestId });
        }
      } catch (err) {
        unstoppedCommands += 1;
        diagnostics.failure('device.revocation_cancel_unconfirmed', toKinuError({
          doing: 'confirming device command termination before revocation',
          cause: err,
          otherwise: 'unavailable',
        }), { device: deviceId, request: row.requestId });
      }
    }

    // Only a sweep that swept rows may set or clear the marker; a later revoke of an already-revoked
    // device must not retract an earlier incident, which only the owner may clear.
    if (unstoppedCommands > 0) {
      this.host.sqlx(`UPDATE user_devices SET unstopped_at = ? WHERE id = ?`, now, deviceId);
    } else if (rows.length > 0) {
      this.host.sqlx(`UPDATE user_devices SET unstopped_at = NULL WHERE id = ?`, deviceId);
    }

    this._inflight.deleteEveryRequestOf(deviceId);
    // A revoked device is unreachable; drop its grants so the owner's audited roster shows only live
    // permissions.
    this.host.sqlx(`DELETE FROM device_consent WHERE device_id = ?`, deviceId);
    this._devices.close(deviceId, 'device revoked');
    this.deleteRevokedDeviceWithoutIncident(deviceId);

    return { ok: true, unstoppedCommands };
  }

  private deleteRevokedDeviceWithoutIncident(deviceId: string): boolean {
    return this.host.sqlx<{ id: string }>(
      `DELETE FROM user_devices
        WHERE id = ? AND revoked_at IS NOT NULL AND unstopped_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM user_device_retired_tokens
                           WHERE device_id = user_devices.id AND reuse_detected_at IS NOT NULL)
        RETURNING id`,
      deviceId,
    ).length === 1;
  }

  /** Clears a revoked device's incidents, removing its row. Refused while request rows remain: the
   *  sweep has not decided. */
  async acknowledgeUnstoppedDevice(caller: UserCaller, deviceId: string): Promise<{ ok: boolean }> {
    await this.host.requireTier(caller, 'device.manage');

    if (this._inflight.hasRequestsFor(deviceId)) return { ok: false };

    const [incident] = this.host.sqlx<{ id: string }>(
      `SELECT id FROM user_devices d
        WHERE id = ? AND revoked_at IS NOT NULL
          AND (unstopped_at IS NOT NULL OR EXISTS (SELECT 1 FROM user_device_retired_tokens r
                                                    WHERE r.device_id = d.id AND r.reuse_detected_at IS NOT NULL))`,
      deviceId,
    );

    if (!incident) return { ok: false };
    this.host.sqlx(`DELETE FROM user_device_retired_tokens WHERE device_id = ?`, deviceId);
    this.host.sqlx(`UPDATE user_devices SET unstopped_at = NULL WHERE id = ?`, deviceId);

    return { ok: this.deleteRevokedDeviceWithoutIncident(deviceId) };
  }
}
