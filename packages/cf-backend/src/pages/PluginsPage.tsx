import { useState, type ReactNode } from "react";
import { Loader } from "@cloudflare/kumo";
import { Button } from "@/components/ui/Button";
import { PlugsConnectedIcon, PuzzlePieceIcon } from "@phosphor-icons/react";
import { APP_ROUTES, mcpPresetById } from "@kinu.run/core";
import type { McpServerSummary } from "@kinu.run/core";
import { mapResource, lastValue, type AsyncResource } from "@/hooks/use-async-resource";
import { useMcpServers } from "@/hooks/use-mcp-servers";
import { mcpServerStatus } from "@/components/plugins/mcp-status";
import { Status } from "@/components/ui/Status";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { PluginRow, PluginTile } from "@/components/plugins/PluginRow";
import { addablePresets, McpPresetCards, PresetRow, type PresetAvailability } from "@/components/plugins/McpPresetCards";
import { AccountPanelModal } from "@/components/account/AccountPanelModal";
import { Page } from "@/components/ui/PageHeader";

function serverLine(server: McpServerSummary): string {
  if (server.error !== null) return server.error;

  if (server.toolsCount === 0) return 'No tools yet';

  return server.toolsCount === 1 ? '1 tool' : `${String(server.toolsCount)} tools`;
}

/** Everything the account holds, in the order it added it, each once with its status; a catalog server keeps its row. */
function connectedRows(servers: readonly McpServerSummary[], availability: PresetAvailability, onChanged: () => void): ReactNode[] {
  return servers.map((server) => {
    const preset = server.presetId === null ? undefined : mcpPresetById(server.presetId);

    if (preset !== undefined) {
      const appConfigured = availability?.find((a) => a.id === preset.id)?.appConfigured;

      return <PresetRow key={server.id} preset={preset} server={server} appConfigured={appConfigured} onChanged={onChanged} />;
    }

    const status = mcpServerStatus(server.status);

    return (
      <PluginRow key={server.id} name={server.name} description={serverLine(server)}
        state={status.label} tile={<PluginTile icon={PlugsConnectedIcon} />}
        trailing={<Status tone={status.tone}>{status.label}</Status>} />
    );
  });
}

/** A group of rows under its label; a group with nothing in it is not drawn. */
function PluginSection({ title, rows, onRetry, what }: {
  title: string;
  rows: AsyncResource<readonly ReactNode[]>;
  onRetry: () => void;
  what: string;
}) {
  if (rows.status === "ready" && rows.value.length === 0) return null;

  return (
    <section aria-label={title} className="space-y-2">
      <h2 className="p-label">{title}</h2>
      {rows.status === "loading" && <div className="flex justify-center py-4"><Loader size="sm" /></div>}
      {rows.status === "error" && <LoadFailure what={what} message={rows.message} onRetry={onRetry} />}
      {rows.status === "ready" && <div className="-mx-2 grid gap-x-6 gap-y-0.5 sm:grid-cols-2">{rows.value}</div>}
    </section>
  );
}

/** Two lists (design review 2026-10-20): what is connected, with its status, and what the catalog can still add. */
export default function PluginsPage() {
  const mcp = useMcpServers();
  const { servers, presets } = mcp;
  const [managing, setManaging] = useState(false);
  const availability = lastValue(presets.resource) ?? undefined;

  return (
    <>
      <Page icon={<PuzzlePieceIcon size={22} />} title="Plugins" actions={<Button variant="secondary" size="sm" onClick={() => setManaging(true)}>Manage</Button>}>
        <PluginSection title="Connected" onRetry={servers.reload} what="your MCP servers"
          rows={mapResource(servers.resource, (rows) => connectedRows(rows, availability, servers.reload))} />

        <PluginSection title="Add" onRetry={servers.reload} what="the catalog"
          rows={mapResource(servers.resource, (rows) => (addablePresets(rows, availability).length === 0 ? [] : [
            <McpPresetCards key="presets" servers={rows} availability={availability} onChanged={servers.reload} unadded />,
          ]))} />
      </Page>
      {managing && <AccountPanelModal panel="mcp" mcp={mcp} returnTo={APP_ROUTES.plugins} onClose={() => setManaging(false)} />}
    </>
  );
}
