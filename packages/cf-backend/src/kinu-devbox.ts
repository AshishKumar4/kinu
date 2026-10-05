/**
  * Kinu's workspace container. The lifecycle lives in `@kinu.run/devbox` in exactly one copy; this
  * adds only the store, the preview zone, the owning workspace's answers, and Kinu's egress plane.
  */

import {
  Devbox, GOLDEN_NAME, type BoxPeers, type DevboxState,
  type DevboxIncident, type DevboxStore, type OutboundPolicy,
  type IncidentDisposition, type RestoreClockPhase,
} from "@kinu.run/devbox";
import { getAgentByName } from "agents";
import { settleLogged } from "@kinu.run/core/obs";
import { sandboxIdForWorkspace } from '@kinu.run/core';
import type { OrchestratorAgent } from "./orchestrator";
import { lifecycleIncident, restoreNotices } from "./sandbox-lifecycle";
import {
  CONTAINER_EVENT_HOST,
  type KinuEgressParams,
} from "./egress/outbound";
import type { KinuEgress, KinuEvents } from './server';

/** Owning workspace; without it no root agent hears the box's notices. */
const WORKSPACE_NAME_KEY = "kinu:workspace-name";

const EGRESS_CONFIG_KEY = 'kinu:egress-config';

interface KinuState extends DevboxState {
  readonly exports: DevboxState['exports'] & {
    readonly KinuEgress: (options: { readonly props: KinuEgressParams }) => Pick<Service<KinuEgress>, keyof Fetcher>;
    readonly KinuEvents: (options: { readonly props: KinuEgressParams }) => Pick<Service<KinuEvents>, keyof Fetcher>;
  };
}

/** Type-only, so nothing here reaches orchestrator code at runtime. */
type SandboxRootClient = Pick<
  OrchestratorAgent,
  "acceptSandboxLifecycleIncident" | "sandboxStopped" | "sandboxRestore"
>;

export class KinuDevbox extends Devbox<Env> {
  readonly #nativeExports: KinuState['exports'];
  constructor(ctx: KinuState, env: Env) {
    super(ctx, env);
    this.#nativeExports = ctx.exports;
  }
  /**
   * No raw sockets: the platform never routes ports other than 80/443 through an outbound handler,
   * so this is what makes interception cover all egress (git-over-SSH, raw DB sockets refused).
   */
  enableInternet = false;


  protected override get store(): DevboxStore | undefined {
    const bucket = this.env.BACKUP_BUCKET;

    return bucket === undefined ? undefined : { binding: 'BACKUP_BUCKET', bucket };
  }

  protected override get namespaceBinding(): string { return 'KinuDevbox'; }

  protected override get registryToken(): string | undefined { return this.env.DEVBOX_REGISTRY_TOKEN; }

  protected override get peers(): BoxPeers {
    const boxes = this.env.KinuDevbox;

    return { golden: () => boxes.getByName(GOLDEN_NAME), box: (id) => boxes.get(boxes.idFromString(id)) };
  }

  protected override get previewName(): string {
    const workspaceName = this.ctx.storage.kv.get<string>(WORKSPACE_NAME_KEY);

    return sandboxIdForWorkspace(workspaceName ?? this.ctx.id.toString());
  }

  /** Absent turns port publishing off; exec and files keep working. */
  protected override get previewHost(): string | undefined {
    return this.env.PREVIEW_HOST_SUFFIX;
  }

  readonly #restoreNotice = restoreNotices(
    async () => { await (await this.#rootAgent())?.sandboxRestore(await this.restoreStatus()); },
  );

  protected override onRestorePhase(phase: RestoreClockPhase): void {
    this.#restoreNotice(phase);
  }

  override async onStop(): Promise<void> {
    await super.onStop();

    await settleLogged("sandbox.stop_notice_failed", { doing: "telling the workspace its sandbox stopped", otherwise: "unavailable" }, async () => {
      await (await this.#rootAgent())?.sandboxStopped();
    });
  }

  /** Devbox re-delivers until `queued`. `attempt` is Devbox's delivery count, which an evicted
   *  Worker cannot recount. */
  protected override async onIncident(
    incident: DevboxIncident, attempt: number,
  ): Promise<IncidentDisposition> {
    const root = await this.#rootAgent();

    if (root === null) return 'rejected';
    const result = await root.acceptSandboxLifecycleIncident(lifecycleIncident(incident, attempt));

    return result.status;
  }

  async configureEgress(params: KinuEgressParams): Promise<void> {
    await this.ctx.storage.put({ [WORKSPACE_NAME_KEY]: params.workspaceName, [EGRESS_CONFIG_KEY]: params });

    if (this.ctx.container?.running) await this.configureContainer();
  }

  protected override async outboundPolicy(): Promise<OutboundPolicy> {
    const params = await this.ctx.storage.get<KinuEgressParams>(EGRESS_CONFIG_KEY);

    if (params === undefined) return { routes: {} };

    return {
      routes: { [CONTAINER_EVENT_HOST]: this.#nativeExports.KinuEvents({ props: params }) },
      fallback: this.#nativeExports.KinuEgress({ props: params }),
    };
  }

  async #rootAgent(): Promise<SandboxRootClient | null> {
    const workspaceName = await this.ctx.storage.get<string>(WORKSPACE_NAME_KEY);

    if (workspaceName === undefined || this.env.OrchestratorAgent === undefined) return null;

    return await getAgentByName<Env, OrchestratorAgent>(
      this.env.OrchestratorAgent, workspaceName,
    );
  }
}

