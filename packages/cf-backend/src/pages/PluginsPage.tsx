import { useState, type ReactNode } from "react";
import { Loader } from "@/components/ui/Loader";
import { Button } from "@/components/ui/Button";
import { PlugsConnectedIcon, PuzzlePieceIcon, TrashIcon } from "@phosphor-icons/react";
import type { McpServerSummary } from "@kinu.run/core";
import { mapResource, lastValue, type AsyncResource } from "@/hooks/use-async-resource";
import { useMcpServers } from "@/hooks/use-mcp-servers";
import { mcpServerStatus } from "@/components/plugins/mcp-status";
import { BrandMark, brandTitle } from "@/components/ui/BrandMark";
import { useConfirmation } from "@/components/ui/ConfirmDialog";
import { removeMcpServer } from "@/lib/user-api";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { Row, RowTile } from "@/components/ui/Row";
import { addablePresets, hostBrand, McpPresetCards, presetOf, PresetRow, ServerStatus, usePresetErrors, type PresetAvailability, type PresetErrors } from "@/components/plugins/McpPresetCards";
import { Menu } from "@/components/ui/Menu";
import { AccountPanelModal } from "@/components/account/AccountPanelModal";
import { GoogleConnectionCard } from "@/components/account/GoogleConnectionCard";
import { Page } from "@/components/ui/PageHeader";

function serverLine(server: McpServerSummary): string {
  if (server.error !== null) return server.error;

  if (server.toolsCount === 0) return 'No tools yet';

  return server.toolsCount === 1 ? '1 tool' : `${String(server.toolsCount)} tools`;
}

/** A server of the account's own: a known service's mark and name by its host, else the plug; Remove in ⋯. */
function CustomServerRow({ server, onChanged }: { server: McpServerSummary; onChanged: () => void }) {
  const { ask, dialog } = useConfirmation();
  const brand = hostBrand(server);
  const name = brand === undefined ? server.name : brandTitle(brand);

  const remove = () => ask({
    title: `Remove "${name}"?`, body: "All workspaces will lose access to its tools.", action: "Remove", failed: "Could not remove it",
    run: async () => { await removeMcpServer(server.id); onChanged(); },
  });

  return (
    <>
      {dialog}
      <Row attributes={{ "data-plugin": name, "data-plugin-state": mcpServerStatus(server.status).label }} title={name} meta={serverLine(server)}
        tile={brand === undefined ? <RowTile icon={PlugsConnectedIcon} /> : <BrandMark brand={brand} size={18} />}
        status={<ServerStatus status={server.status} />}
        action={<Menu name={name} items={[{ label: "Remove", icon: <TrashIcon size={16} />, onSelect: remove, danger: true }]} />} />
    </>
  );
}

/** Everything the account holds, in the order it added it, each once with its status; a catalog server keeps its row,
 *  one added by its URL included. */
function connectedRows(servers: readonly McpServerSummary[], availability: PresetAvailability, onChanged: () => void, errors: PresetErrors): ReactNode[] {
  return servers.map((server) => {
    const preset = presetOf(server);

    if (preset !== undefined) {
      const appConfigured = availability?.find((a) => a.id === preset.id)?.appConfigured;

      return <PresetRow key={server.id} preset={preset} server={server} appConfigured={appConfigured} onChanged={onChanged} errors={errors} />;
    }

    return <CustomServerRow key={server.id} server={server} onChanged={onChanged} />;
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
      <h2 className="t-label">{title}</h2>
      {rows.status === "loading" && <div className="flex justify-center py-4"><Loader size="sm" /></div>}
      {rows.status === "error" && <LoadFailure what={what} message={rows.message} onRetry={onRetry} />}
      {rows.status === "ready" && <div className="-mx-2 grid gap-x-6 gap-y-px sm:grid-cols-2">{rows.value}</div>}
    </section>
  );
}

/** Two lists (design review 2026-10-20): what is connected, with its status, and what the catalog can still add. */
export default function PluginsPage() {
  const mcp = useMcpServers();
  const { servers, presets } = mcp;
  const [managing, setManaging] = useState(false);
  const availability = lastValue(presets.resource) ?? undefined;
  const errors = usePresetErrors();

  return (
    <>
      <Page icon={<PuzzlePieceIcon size={22} />} title="Plugins" actions={<Button variant="secondary" onClick={() => setManaging(true)}>Manage</Button>}>
        {/* One connection for all of Google, where this deployment offers it: not an MCP server. */}
        <GoogleConnectionCard google={mcp.google} />
        <PluginSection title="Connected" onRetry={servers.reload} what="your MCP servers"
          rows={mapResource(servers.resource, (rows) => connectedRows(rows, availability, servers.reload, errors))} />

        <PluginSection title="Add" onRetry={servers.reload} what="the catalog"
          rows={mapResource(servers.resource, (rows) => (addablePresets(rows, availability).length === 0 ? [] : [
            <McpPresetCards key="presets" servers={rows} availability={availability} onChanged={servers.reload} errors={errors} unadded />,
          ]))} />
      </Page>
      {managing && <AccountPanelModal panel="mcp" mcp={mcp} onClose={() => setManaging(false)} />}
    </>
  );
}
