/**
 * KinuSandbox — Kinu's workspace container, and nothing more than the four
 * things that are Kinu's.
 *
 * The lifecycle — the activity lease, the split start sequence, supervised
 * process and port manifests, lifecycle incidents and the snapshot-chain
 * storage — is `@kinu.run/devbox`, WHOLE and in exactly one copy: an ephemeral
 * container presented as a persistent machine is not a Kinu idea, and two
 * copies of that machinery would drift the moment one of them was fixed. What
 * is left below is the part no other host can supply, and it is deliberately
 * small:
 *
 *   * the store this workspace's state lives in (`BACKUP_BUCKET`),
 *   * the preview zone its ports are published on,
 *   * the two questions Devbox must ask the OWNING WORKSPACE — is background
 *     work still bound to this container, and please tell the agent that its
 *     container just failed — both answered by the root agent over its stub,
 *   * Kinu's egress and container-event interception, which is a security
 *     property of THIS product and belongs nowhere else.
 */

import {
  Devbox,
  type DevboxIncident, type DevboxStore,
  type IncidentDisposition,
} from "@kinu.run/devbox";
import { getAgentByName } from "agents";
import type { OrchestratorAgent } from "./orchestrator";
import { SANDBOX_LIFECYCLE_ENVELOPE_VERSION } from "./sandbox-lifecycle";
import type { SandboxLifecycleFailure } from "./sandbox-lifecycle";
import {
  CONTAINER_EVENT_HOST, EGRESS_HANDLER, EVENT_HANDLER,
  containerEventResolver, handleContainerEgress, handleContainerEvent, parseEgressParams,
  type KinuEgressParams,
} from "./egress/outbound";

/** Which workspace owns this container. Written when the workspace binds its
 *  egress; without it there is no root agent to answer Devbox's two questions. */
const WORKSPACE_NAME_KEY = "kinu:workspace-name";

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

  /** Is work still bound to this container? The root agent answers over the
   *  whole subordinate roster. An unreachable root reads as idle here: the
   *  heartbeat treats a throwing check as possibly busy and holds the box. */
  protected override async hasBackgroundWork(): Promise<boolean> {
    const root = await this.#rootAgent();

    if (root === null) return false;

    return await root.hasSandboxBackgroundWork();
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
  // The runtime object IS this Worker's env, so the parameter is declared as
  // `Env`. The SDK types it by the generated `Cloudflare.Env` contract, which
  // this project leaves empty and populates as `Env` in env.d.ts instead; the
  // handler type is bivariant in it, so the wrangler binding block is what
  // names these members and nothing here narrows anything else.
  //
  // COMPOSITION: upstream assigns handler maps wholesale when it configures an
  // R2-binding or credential-proxy bucket mount — which Devbox's chain storage
  // does on every attach. The committed patch
  // (patches/@cloudflare%2Fsandbox@0.12.8.patch) makes those sites MERGE, so a
  // bucket mount can never unbind the two handlers below.
  [EGRESS_HANDLER]: (request, env: Env, ctx) => handleContainerEgress(
    request, env, parseEgressParams(ctx),
  ),
  [EVENT_HANDLER]: (request, env: Env, ctx) => handleContainerEvent(
    request, containerEventResolver(env), parseEgressParams(ctx),
  ),
};
