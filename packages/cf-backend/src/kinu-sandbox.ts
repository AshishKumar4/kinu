/**
  * Kinu's workspace container. The lifecycle lives in `@kinu.run/devbox` in exactly one copy; this
  * adds only the store, the preview zone, the owning workspace's answers, and Kinu's egress plane.
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

/** Owning workspace; without it no root agent can answer Devbox's two questions. */
const WORKSPACE_NAME_KEY = "kinu:workspace-name";

/** Type-only, so nothing here reaches orchestrator code at runtime. */
type SandboxRootClient = Pick<
  OrchestratorAgent,
  "acceptSandboxLifecycleFailure" | "hasSandboxBackgroundWork"
>;

export class KinuSandbox extends Devbox<Env> {
  /**
   * No raw sockets: the platform never routes ports other than 80/443 through an outbound handler,
   * so this is what makes interception cover all egress (git-over-SSH, raw DB sockets refused).
   */
  enableInternet = false;

  /**
   * Measured: the SDK inherits `interceptHttps = false` despite its docs, so HTTPS bypasses the vault.
   * A field, not a start hook: the base refreshes interception before `container.start()`.
   */
  interceptHttps = true;

  /** The NAME is what the credential-less mount resolves; the binding is what the chain PUTs/HEADs. */
  protected override get store(): DevboxStore | undefined {
    const bucket = this.env.BACKUP_BUCKET;

    return bucket === undefined ? undefined : { binding: "BACKUP_BUCKET", bucket };
  }

  /** Absent turns port publishing off; exec and files keep working. */
  protected override get previewHost(): string | undefined {
    return this.env.PREVIEW_HOST_SUFFIX;
  }

  /** An unreachable root reads as idle; the heartbeat treats a throwing check as busy. */
  protected override async hasBackgroundWork(): Promise<boolean> {
    const root = await this.#rootAgent();

    if (root === null) return false;

    return await root.hasSandboxBackgroundWork();
  }

  /** Devbox re-delivers until `queued`. `attempt` is Devbox's delivery count, which an evicted
   *  Worker cannot recount. */
  protected override async onIncident(
    incident: DevboxIncident, attempt: number,
  ): Promise<IncidentDisposition> {
    const root = await this.#rootAgent();

    if (root === null) return 'rejected';

    // Restated field by field: the root's schema is closed, so an added Devbox field must not ride along.
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

  /**
   * Called by the workspace DO before first use and on grant/vault change; a start hook is too late
   * to install interception. Pins the owning workspace so incidents reach it from a cold object.
   */
  async configureEgress(params: KinuEgressParams): Promise<void> {
    await this.ctx.storage.put(WORKSPACE_NAME_KEY, params.workspaceName);
    // Per-host before catch-all, else a container event could take the egress path in between.
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
  // `ctx.params` is parsed, and undefined refuses: an unconfigured container cannot egress.
  // patches/@cloudflare%2Fsandbox@0.12.8.patch makes bucket mounts merge handler maps, not replace them.
  [EGRESS_HANDLER]: (request, env: Env, ctx) => handleContainerEgress(
    request, env, parseEgressParams(ctx),
  ),
  [EVENT_HANDLER]: (request, env: Env, ctx) => handleContainerEvent(
    request, containerEventResolver(env), parseEgressParams(ctx),
  ),
};
