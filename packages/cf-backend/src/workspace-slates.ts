/**
 * A workspace's slates as its object serves them: the slate host, loaded at its first use; the build records a file
 * change moves whether or not a host is loaded; and the surface catalog a slate's graph shows. The workspace object
 * keeps the methods its callers reach (RPC, `@callable`) and answers each from the host.
 */
import * as v from 'valibot';
import { McpToolSurfaceSchema, type SlateSurfaceCatalog } from '@kinu.run/core';
import type { McpToolSurface } from './user/mcp-servers';
import { ROOT_SLATE_CALLER, SlateBuilds } from '@kinu.run/core/slates';
import type { SlateHost, SlateHostDeps } from './slates/host';

/** What the host is made with, but for what this class keeps itself: its build records and its catalog. */
export interface WorkspaceSlatesHost extends Omit<SlateHostDeps, 'builds' | 'catalog'> {
  /** The owner's MCP tools as the account describes them, which a catalog names servers and tools from. */
  readonly ownerMcpSurface: () => Promise<McpToolSurface>;
}

export class WorkspaceSlates {
  private host: SlateHost | undefined;

  private loading: Promise<SlateHost> | undefined;

  private buildRecords: SlateBuilds | undefined;

  constructor(private readonly deps: WorkspaceSlatesHost) {}

  /** The slates' build records: a turn's every step reads them and a file change moves them, host loaded or not. */
  get builds(): SlateBuilds {
    this.buildRecords ??= new SlateBuilds(this.deps.ctx.storage.sql);

    return this.buildRecords;
  }

  /** The host, if this activation loaded it. */
  get loaded(): SlateHost | undefined {
    return this.host;
  }

  /**
   * The slate host, loaded at its first use: it and the agent-core runtime its stores run on were most of the startup
   * every isolate of the Worker paid, a workspace's own or not (L27).
   */
  load(): Promise<SlateHost> {
    this.loading ??= import('./slates/host').then(({ SlateHost: Host }) => {
      this.host = new Host({ ...this.deps, builds: this.builds, catalog: () => this.catalog() });

      return this.host;
    });

    return this.loading;
  }

  /** The slates a change to `paths` moves: the loaded host's, or the build records' where none is loaded. */
  filesChanged(paths: readonly string[]): readonly string[] {
    return this.host?.controller.filesChanged(paths) ?? this.builds.filesChanged(paths);
  }

  /** Names only, never surfaces: the graph shows what a slate has reached; each call is still decided as it comes. */
  async catalog(): Promise<SlateSurfaceCatalog> {
    // Crossed an RPC from the owner's object: held to the surface's schema as every reader of it holds it.
    const mcp = v.parse(McpToolSurfaceSchema, await this.deps.ownerMcpSurface());
    const mcpServers = new Map<string, { title: string; tools: { name: string; readOnly: boolean }[] }>();

    for (const descriptor of mcp.descriptors) {
      const group = mcpServers.get(descriptor.serverName) ?? { title: descriptor.serverName, tools: [] };

      group.tools.push({ name: descriptor.name, readOnly: descriptor.readOnly === true });
      mcpServers.set(descriptor.serverName, group);
    }

    return {
      mcp: [...mcpServers.entries()].map(([server, group]) => ({ server, title: group.title, tools: group.tools })),
      slates: Object.keys(await (await this.load()).controller.projects(ROOT_SLATE_CALLER)),
    };
  }
}
