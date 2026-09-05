/**
 * KinuSandbox — Kinu's workspace container, and nothing more than the four
 * things that are Kinu's.
 *
 * The lifecycle that used to live here — the activity lease, the split start
 * sequence, supervised process and port manifests, lifecycle incidents and the
 * snapshot-chain storage — is `@kinu.run/devbox` now. It moved WHOLE rather
 * than being copied: an ephemeral container presented as a persistent machine
 * is not a Kinu idea, and two copies of that machinery would drift the moment
 * one of them was fixed. What is left below is the part no other host can
 * supply, and it is deliberately small:
 *
 *   * the store this workspace's state lives in (`BACKUP_BUCKET`),
 *   * the preview zone its ports are published on,
 *   * the two questions Devbox must ask the OWNING WORKSPACE — is background
 *     work still bound to this container, and please tell the agent that its
 *     container just failed — both answered by the root agent over its stub,
 *   * Kinu's egress and container-event interception, which is a security
 *     property of THIS product and belongs nowhere else.
 *
 * The attach budget is derived, not retyped: `PLATFORM_CATALOG` holds the
 * measured point at which the runtime cancels `blockConcurrencyWhile` and
 * resets the object, so the catalog stays the one source and a correction to
 * it moves this with it.
 */

import {
  DEFAULT_DEVBOX_POLICY, Devbox,
  type DevboxIncident, type DevboxPolicy, type DevboxStore, type IncidentDisposition,
} from "@kinu.run/devbox";
import { PLATFORM_CATALOG } from "@kinu.run/core";
import { diagnostics, toKinuError } from "@kinu.run/core/obs";
import { getAgentByName } from "agents";
import type { OrchestratorAgent } from "./orchestrator";
import { SANDBOX_LIFECYCLE_ENVELOPE_VERSION } from "./sandbox-lifecycle";
import type { SandboxLifecycleFailure } from "./sandbox-lifecycle";
import {
  CONTAINER_EVENT_HOST, EGRESS_HANDLER, EVENT_HANDLER,
  handleContainerEgress, handleContainerEvent, parseEgressParams,
  type KinuEgressParams,
} from "./egress/outbound";

/** Which workspace owns this container. Written when the workspace binds its
 *  egress; without it there is no root agent to answer Devbox's two questions. */
const WORKSPACE_NAME_KEY = "kinu:workspace-name";

/** Our own teardown margin inside the platform's cancel point: the attach has
 *  to finish AND this object has to log and return before the runtime resets
 *  it. */
const ATTACH_MARGIN_MS = 5_000;

/** What Devbox may ask the owning workspace. A narrow projection of the real
 *  class, exactly like the container-event client in egress/outbound.ts;
 *  type-only, so nothing here reaches orchestrator code at runtime. */
type SandboxRootClient = Pick<
  OrchestratorAgent,
  "acceptSandboxLifecycleFailure" | "hasSandboxBackgroundWork"
>;

export class KinuSandbox extends Devbox<Env> {
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
   * shipped bundle and it is a READ, never an assignment, so the class inherits
   * `interceptHttps = false` from `@cloudflare/containers`. Leaving it alone
   * means every HTTPS request — which is every request that matters — bypasses
   * interception while the vault believes it is substituting. Setting it true
   * both exports `SANDBOX_INTERCEPT_HTTPS=1` so the container trusts the
   * ephemeral CA, and makes the base call `interceptOutboundHttps('*', fetcher)`.
   *
   * A field rather than anything set in a start hook: the base runs
   * `refreshOutboundInterception()` immediately before `container.start()`, and
   * any start hook runs after the container is already up.
   */
  interceptHttps = true;

  // ── what Devbox asks of this host ────────────────────────────────────────

  /** Kinu keeps workspace state in its own R2 bucket. Both fields are
   *  load-bearing: the NAME is what the credential-less mount resolves, the
   *  binding is what the chain PUTs and HEADs through. */
  protected override get store(): DevboxStore | undefined {
    const bucket = this.env.BACKUP_BUCKET;
    return bucket === undefined ? undefined : { binding: "BACKUP_BUCKET", bucket };
  }

  /** The zone preview URLs are minted on. Absent turns port publishing off and
   *  leaves exec and files working, which is the long-standing behaviour. */
  protected override get previewHost(): string | undefined {
    return this.env.PREVIEW_HOST_SUFFIX;
  }

  /** The attach budget comes from the measured platform ceiling, minus our own
   *  teardown margin — never a number retyped beside the catalog. */
  protected override get policy(): DevboxPolicy {
    return {
      ...DEFAULT_DEVBOX_POLICY,
      attachBudgetMs:
        PLATFORM_CATALOG['do.block_concurrency.cancel_ms'].limit.value - ATTACH_MARGIN_MS,
    };
  }

  /** Is work still bound to this container? The root agent answers over the
   *  whole subordinate roster and answers conservatively when a facet cannot be
   *  reached, so an unreachable root holds the container open rather than
   *  stopping one that is still serving something. */
  protected override async hasBackgroundWork(): Promise<boolean> {
    const root = await this.#rootAgent();
    if (root === null) return false;
    try {
      return await root.hasSandboxBackgroundWork();
    } catch (error) {
      diagnostics.failure('sandbox.background_work_unreadable', toKinuError({
        doing: 'asking the workspace whether background work is still bound to this container',
        cause: error,
        otherwise: 'unavailable',
      }));
      // Unreadable means possibly-busy. Never stop a container on a guess.
      return true;
    }
  }

  /**
   * A caller is using this container INTERACTIVELY, over a lane the lease
   * cannot see.
   *
   * The PTY is the reason this exists. `@cloudflare/sandbox` exposes a terminal
   * only on the client wrapper, which proxies a WebSocket at the container's
   * own port, and `@cloudflare/containers` renews the SDK's activity clock on
   * every forwarded frame. So the container stays awake by the SDK's reckoning
   * — but Devbox's DURABLE lease moves only when a public operation stamps it,
   * and the quiesce decision reads that stamp. Without this call a user typing
   * in a terminal looks perfectly idle to the heartbeat, which then takes a
   * final checkpoint and SIGTERMs the container out from under them.
   *
   * Only the host can know which of its entry points are a caller, which is why
   * `stampInteraction` is protected rather than private. This is Kinu's: the
   * terminal route calls it before the WebSocket upgrade and again on its
   * keepalive while the socket is attached. Re-calling is cheap — the durable
   * write is already throttled inside `stampInteraction`, and `ensureReady`
   * returns immediately once this container generation has settled.
   *
   * It goes through `ensureReady` rather than stamping alone because a terminal
   * on a box whose workspace never attached is a terminal onto the wrong disk;
   * refusing loudly there is the same answer every other operation gives.
   */
  async noteTerminalActivity(): Promise<void> {
    await this.ensureReady();
    this.stampInteraction();
  }

  /** Tell the agent its container failed. Devbox has already made the incident
   *  durable and will keep re-delivering until this returns `queued`, so the
   *  only job here is the call itself.
   *
   *  `attempt` is Devbox's own delivery count for THIS incident, handed down
   *  rather than recounted: the box's ledger is where deliveries are counted,
   *  and an evicted Worker cannot see how many there have been. It is the one
   *  dimension the recovery row cannot derive, which is why it rides the
   *  envelope. */
  protected override async onIncident(
    incident: DevboxIncident, attempt: number,
  ): Promise<IncidentDisposition> {
    const root = await this.#rootAgent();
    if (root === null) return 'rejected';
    // The root's schema is closed and takes plain JSON; a DevboxIncident is
    // exactly that shape, restated field by field so an added Devbox field
    // cannot silently ride along into a contract that would reject it. The
    // version is stamped from the consumer's own constant, so the two halves of
    // this envelope cannot disagree about which shape it is.
    const report: SandboxLifecycleFailure = {
      version: SANDBOX_LIFECYCLE_ENVELOPE_VERSION,
      incidentId: incident.incidentId,
      stage: incident.stage,
      reason: incident.reason,
      attempts: attempt,
    };
    if (incident.processId !== undefined) report.processId = incident.processId;
    if (incident.port !== undefined) report.port = incident.port;
    const result = await root.acceptSandboxLifecycleFailure(report);
    return result.status;
  }

  // ── Kinu's own egress plane ──────────────────────────────────────────────

  /**
   * Bind this container's two egress handlers, with the secret bindings the
   * workspace has been granted.
   *
   * Called by the workspace Durable Object — which is where the grants live —
   * before the container is first used, and again whenever the owner's vault or
   * the workspace's grants change. Not in a start hook: that runs after the
   * container is up, which is too late to install interception.
   *
   * It also pins WHICH workspace owns this container, because a lifecycle
   * incident has to reach that root agent from a cold, evicted object.
   *
   * The Container base persists this configuration to its own storage and
   * re-applies it before each `container.start()`, so it is once per change.
   */
  async configureEgress(params: KinuEgressParams): Promise<void> {
    await this.ctx.storage.put(WORKSPACE_NAME_KEY, params.workspaceName);
    // Per-host before catch-all: per-host wins at request time, and binding it
    // second would leave a window where a container event took the egress path.
    await this.setOutboundByHost(CONTAINER_EVENT_HOST, EVENT_HANDLER, params);
    await this.setOutboundHandler(EGRESS_HANDLER, params);
  }

  async #rootAgent(): Promise<SandboxRootClient | null> {
    const workspaceName = await this.ctx.storage.get<string>(WORKSPACE_NAME_KEY);
    if (workspaceName === undefined || this.env.OrchestratorAgent === undefined) return null;
    return await getAgentByName<Env, OrchestratorAgent>(
      this.env.OrchestratorAgent, workspaceName,
    );
  }
}

KinuSandbox.outboundHandlers = {
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
  //
  // COMPOSITION: upstream assigns handler maps wholesale when it configures an
  // R2-binding or credential-proxy bucket mount — which Devbox's chain storage
  // does on every attach. The committed patch
  // (patches/@cloudflare%2Fsandbox@0.12.8.patch) makes those sites MERGE, so a
  // bucket mount can never unbind the two handlers below.
  [EGRESS_HANDLER]: (request, env, ctx) => handleContainerEgress(
    request, env as Env, parseEgressParams(ctx),
  ),
  // SAFETY: as above — the same generated `Cloudflare.Env` contract names the
  // object this Worker declares as `Env`.
  [EVENT_HANDLER]: (request, env, ctx) => handleContainerEvent(
    request, env as Env, parseEgressParams(ctx),
  ),
};
