/**
  * Kinu's workspace container. The lifecycle lives in `@kinu.run/devbox` in exactly one copy; this
  * adds only the store, the preview zone, the owning workspace's answers, and Kinu's egress plane.
  */

import {
  Devbox, type DevboxState,
  type DevboxIncident, type OutboundPolicy,
  type IncidentDisposition, type RestoreClockPhase,
} from "@kinu.run/devbox";
import { getAgentByName } from "agents";
import { settleLogged } from "@kinu.run/core/obs";
import { markDocument, previewHostSuffix, workspaceHostLabel } from '@kinu.run/core';
import type { OrchestratorAgent } from "./orchestrator";
import { lifecycleIncident, restoreNotices } from "./sandbox-lifecycle";
import {
  CONTAINER_EVENT_HOST,
  type KinuEgressParams,
} from "./egress/outbound";
import type { KinuEgress, KinuEvents } from './server';

/** The owning workspace's egress configuration, and its name: without it no root agent hears the box's notices. */
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
  "acceptSandboxLifecycleIncident" | "sandboxStopped" | "sandboxRestore" | "workspaceTitle"
>;

export class KinuDevbox extends Devbox<Env> {
  readonly #nativeExports: KinuState['exports'];
  constructor(ctx: KinuState, env: Env) {
    super(ctx, env);
    this.#nativeExports = ctx.exports;
  }
  /**
   * Raw TCP and UDP go straight out (D82): git over SSH, database and mail sockets, DNS, and HTTP or TLS on any port
   * but 80 and 443. HTTP and HTTPS on 80 and 443 still enter `outboundPolicy`'s routes first, so the vault sees those
   * requests and their placeholders.
   */
  enableInternet = true;


  /** A mount records its binding as its bucket, so the name stays what the deployed containers recorded (D47). */
  protected override get store(): string { return 'BACKUP_BUCKET'; }

  /**
   * The workspace's own name, as a host label (D91, D93): read from the workspace at each start and each configure, so a
   * rename shows at its next one and nothing here keeps a copy. The slug's label where the name is unread.
   */
  protected override async shownName(): Promise<string | undefined> {
    const workspaceName = (await this.ctx.storage.get<KinuEgressParams>(EGRESS_CONFIG_KEY))?.workspaceName;

    if (workspaceName === undefined) return undefined;
    let title: string | null = null;

    await settleLogged('computer.name_unread', { doing: "reading the workspace's name for its computer", otherwise: 'unavailable' }, async () => {
      title = await (await this.#rootAgent())?.workspaceTitle() ?? null;
    }, { workspace: workspaceName });

    return workspaceHostLabel(title, workspaceName);
  }

  /** The logo's own mark, so the desktop follows it when the mark changes. */
  protected override get desktopMark(): string { return markDocument(); }

  /** The zone the edge serves, read as the edge reads it; absent turns port publishing off, and exec and files keep
   *  working. */
  protected override get previewHost(): string | undefined {
    return previewHostSuffix(this.env) ?? undefined;
  }

  readonly #restoreNotice = restoreNotices(
    async () => { await (await this.#rootAgent())?.sandboxRestore(await this.restoreStatus()); },
  );

  protected override onRestorePhase(phase: RestoreClockPhase): void {
    this.#restoreNotice(phase);
  }

  override async onStop(): Promise<void> {
    await super.onStop();

    await settleLogged("computer.stop_notice_failed", { doing: "telling the workspace its computer stopped", otherwise: "unavailable" }, async () => {
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
    await this.ctx.storage.put(EGRESS_CONFIG_KEY, params);

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
    const workspaceName = (await this.ctx.storage.get<KinuEgressParams>(EGRESS_CONFIG_KEY))?.workspaceName;

    if (workspaceName === undefined || this.env.OrchestratorAgent === undefined) return null;

    return await getAgentByName<Env, OrchestratorAgent>(
      this.env.OrchestratorAgent, workspaceName,
    );
  }
}

