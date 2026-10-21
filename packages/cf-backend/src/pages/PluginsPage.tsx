import { useState, type ReactNode } from "react";
import { Button, Loader } from "@cloudflare/kumo";
import { PlugsConnectedIcon, PuzzlePieceIcon } from "@phosphor-icons/react";
import type { McpServerSummary } from "@kinu.run/core";
import { mapResource, lastValue, type AsyncResource } from "@/hooks/use-async-resource";
import { useMcpServers } from "@/hooks/use-mcp-servers";
import { mcpServerStatus } from "@/components/plugins/mcp-status";
import { Status } from "@/components/ui/Status";
import { LoadFailure } from "@/components/ui/LoadFailure";
import {
  PluginRow, PluginTile,
} from "@/components/plugins/PluginRow";
import { McpPresetCards, presetBrand } from "@/components/plugins/McpPresetCards";
import { BrandMark } from "@/components/ui/BrandMark";
import { AccountPanelModal } from "@/components/account/AccountPanelModal";
import { PAGE_BODY, PageHeader } from "@/components/ui/PageHeader";

function serverLine(server: McpServerSummary): string {
  if (server.error !== null) return server.error;

  if (server.toolsCount === 0) return 'No tools yet';

  return server.toolsCount === 1 ? '1 tool' : `${String(server.toolsCount)} tools`;
}

function InstalledStrip({ servers }: { servers: readonly McpServerSummary[] }) {
  if (servers.length === 0) return null;

  return (
    <section aria-label="Installed" className="space-y-2">
      <h2 className="p-label px-1">Installed</h2>
      <div data-installed-strip className="flex flex-wrap items-center gap-2 px-1">
        {servers.map((server) => {
          const brand = presetBrand(server.presetId);

          return (
            <span key={server.id} data-installed={server.name}
              className="inline-flex h-8 max-w-[220px] items-center gap-2 rounded-full border p-border bg-[var(--c-elevated)] pl-2 pr-3 p-t-control p-text-2">
              {brand === undefined
                ? <PlugsConnectedIcon size={15} className="shrink-0 p-text-3" aria-hidden />
                : <BrandMark brand={brand} size={15} bare />}
              <span className="truncate">{server.name}</span>
            </span>
          );
        })}
      </div>
    </section>
  );
}

function PluginSection({ title, rows, onRetry, what, note, empty }: {
  title: string;
  rows: AsyncResource<readonly ReactNode[]>;
  onRetry: () => void;
  what: string;
  note?: string;
  empty?: ReactNode;
}) {
  return (
    <section aria-label={title} className="space-y-2">
      <h2 className="p-label px-1">{title}</h2>
      {note && <p className="px-1 p-meta p-text-3">{note}</p>}
      {rows.status === "loading" && <div className="flex justify-center py-4"><Loader size="sm" /></div>}
      {rows.status === "error" && <LoadFailure what={what} message={rows.message} onRetry={onRetry} />}
      {rows.status === "ready" && (
        rows.value.length === 0
          ? empty !== undefined && <p className="px-1 p-row-text p-text-3">{empty}</p>
          : <div className="grid gap-x-6 gap-y-0.5 sm:grid-cols-2">{rows.value}</div>
      )}
    </section>
  );
}

export default function PluginsPage() {
  const mcp = useMcpServers();
  const { servers, presets } = mcp;
  const [managing, setManaging] = useState(false);

  return (
    <div className="h-full overflow-y-auto">
      <div className={`space-y-8 ${PAGE_BODY}`}>
        <PageHeader icon={<PuzzlePieceIcon size={22} />} title="Plugins">
          <Button variant="secondary" size="sm" onClick={() => setManaging(true)}>Manage</Button>
        </PageHeader>

        <InstalledStrip servers={lastValue(servers.resource) ?? []} />

        <PluginSection title="Popular" onRetry={servers.reload} what="your MCP servers"
          rows={mapResource(servers.resource, (rows) => [
            <McpPresetCards key="presets" servers={rows}
              availability={lastValue(presets.resource) ?? undefined}
              onChanged={servers.reload} />,
          ])}
        />

        <PluginSection title="MCP servers" onRetry={servers.reload} what="your MCP servers"
          empty="No MCP servers of your own yet. Use Manage to add one."
          rows={mapResource(servers.resource, (rows) => rows
            .filter((server) => server.presetId === null)
            .map((server) => {
              const status = mcpServerStatus(server.status);

              return (
                <PluginRow key={server.id} name={server.name} description={serverLine(server)}
                  state={status.label} tile={<PluginTile icon={PlugsConnectedIcon} />}
                  trailing={<Status tone={status.tone}>{status.label}</Status>} />
              );
            }))}
        />
      </div>
      {managing && <AccountPanelModal panel="mcp" mcp={mcp} onClose={() => setManaging(false)} />}
    </div>
  );
}
