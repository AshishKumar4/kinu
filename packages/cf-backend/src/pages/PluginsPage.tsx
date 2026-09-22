/**
 * Plugins — what this account's agents can reach beyond their built-in tools,
 * in one row grammar: the popular MCP servers one click connects, the servers
 * this account added itself, and the skills every workspace ships with. Each
 * is a read of its own, failing on its own, so an unreachable MCP plane never
 * blanks the skills beside it.
 *
 * A preset-tagged server is drawn once, by its Popular row, and the strip at
 * the top is where a person sees everything the account holds at a glance.
 *
 * Skills a workspace writes for itself live in that workspace's object and
 * are listed there; only the built-in doctrine is account-wide.
 */
import { useState, type ReactNode } from "react";
import { Button, Loader } from "@cloudflare/kumo";
import {
  BookOpenIcon, PlugsConnectedIcon, PuzzlePieceIcon,
} from "@phosphor-icons/react";
import { APP_ROUTES, BUILTIN_SKILL_HEADERS } from "@kinu.run/core";
import {
  listMcpServers, listMcpPresets,
  type McpServerSummary,
} from "@/lib/user-api";
import { useAsyncResource, mapResource, lastValue, type AsyncResource } from "@/hooks/use-async-resource";
import { LoadFailure } from "@/components/ui/LoadFailure";
import {
  PluginRow, PluginStatePill, PluginTile, type PluginStatus,
} from "@/components/plugins/PluginRow";
import { McpPresetCards, presetBrand } from "@/components/plugins/McpPresetCards";
import { BrandMark } from "@/components/ui/BrandMark";
import { AccountPanelModal } from "@/components/account/AccountPanelModal";

/** While a preset sign-in is open in another tab the user returns to this
 *  page mid-flow, so the server list re-reads itself until every connection
 *  has settled — the same 5s the MCP panel polls on, and only while one is
 *  actually pending. */
const revalidateServers = (rows: McpServerSummary[] | null): number | null =>
  rows?.some((s) => s.status === 'authenticating' || s.status === 'connecting'
    || s.status === 'discovering') ? 5000 : null;

/** A server's reachability as a row status: the same words the MCP panel's
 *  badge uses, in the row's own tone vocabulary. */
function serverStatus(status: McpServerSummary['status']): PluginStatus {
  switch (status) {
    case 'ready':
    case 'connected':
      return { label: 'connected', tone: 'success' };
    case 'authenticating':
      return { label: 'auth needed', tone: 'warning' };
    case 'connecting':
    case 'discovering':
      return { label: status, tone: 'warning' };
    case 'failed':
      return { label: 'failed', tone: 'danger' };
    case 'unknown':
      return { label: status, tone: 'neutral' };
  }
}

/** What a server row says under its name: what the account gets from it, or
 *  why it gets nothing. The endpoint belongs to the surface that edits it. */
function serverLine(server: McpServerSummary): string {
  if (server.error !== null) return server.error;

  if (server.toolsCount === 0) return 'No tools yet';

  return server.toolsCount === 1 ? '1 tool' : `${String(server.toolsCount)} tools`;
}

/** Everything the account holds, as one strip of marks: the preset's own
 *  brand where a preset tagged the server, the plug otherwise. */
function InstalledStrip({ servers }: { servers: readonly McpServerSummary[] }) {
  if (servers.length === 0) return null;

  return (
    <section aria-label="Installed" className="space-y-2">
      <h2 className="p-eyebrow px-1">Installed</h2>
      <div data-installed-strip className="flex flex-wrap items-center gap-2 px-1">
        {servers.map((server) => {
          const brand = presetBrand(server.presetId);

          return (
            <span key={server.id} data-installed={server.name} title={server.name}
              aria-label={server.name}
              className="flex size-9 items-center justify-center rounded-full border p-border bg-[var(--c-elevated)]">
              {brand === undefined
                ? <PlugsConnectedIcon size={16} className="p-text-3" />
                : <BrandMark brand={brand} size={16} bare />}
            </span>
          );
        })}
      </div>
    </section>
  );
}

/** One section of the list: its eyebrow, an optional action or note beside
 *  it, and its rows in two columns — or the read's own loader, failure, or
 *  empty line. */
function PluginSection({ title, rows, onRetry, what, action, note, empty }: {
  title: string;
  rows: AsyncResource<readonly ReactNode[]>;
  onRetry: () => void;
  what: string;
  action?: ReactNode;
  note?: string;
  empty?: ReactNode;
}) {
  return (
    <section aria-label={title} className="space-y-2">
      <div className="flex items-center justify-between gap-3 px-1">
        <h2 className="p-eyebrow">{title}</h2>
        {action}
      </div>
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
  const servers = useAsyncResource(listMcpServers, revalidateServers);
  const presets = useAsyncResource(listMcpPresets);
  const [managing, setManaging] = useState(false);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-8 px-6 py-8">
        <header className="flex items-start gap-3">
          <PuzzlePieceIcon size={22} className="mt-1 shrink-0 p-text-3" />
          <div>
            <h1 className="p-display text-2xl">Plugins</h1>
            <p className="p-meta p-text-3">Services and skills your agents can use in every workspace.</p>
          </div>
        </header>

        <InstalledStrip servers={lastValue(servers.resource) ?? []} />

        <PluginSection title="Popular" onRetry={servers.reload} what="your MCP servers"
          rows={mapResource(servers.resource, (rows) => [
            <McpPresetCards key="presets" servers={rows}
              availability={lastValue(presets.resource) ?? undefined}
              onChanged={servers.reload} />,
          ])}
        />

        <PluginSection title="MCP servers" onRetry={servers.reload} what="your MCP servers"
          action={<Button variant="ghost" size="sm" onClick={() => setManaging(true)}>Manage</Button>}
          empty="No server of your own yet."
          rows={mapResource(servers.resource, (rows) => rows
            .filter((server) => server.presetId === null)
            .map((server) => {
              const status = serverStatus(server.status);

              return (
                <PluginRow key={server.id} name={server.name} description={serverLine(server)}
                  state={status.label} tile={<PluginTile icon={PlugsConnectedIcon} kind="server" />}
                  trailing={<PluginStatePill status={status} />} />
              );
            }))}
        />

        <section aria-label="Skills" className="space-y-2">
          <div className="flex items-center justify-between gap-3 px-1">
            <h2 className="p-eyebrow">Skills</h2>
          </div>
          <div className="grid gap-x-6 gap-y-0.5 sm:grid-cols-2">
            {BUILTIN_SKILL_HEADERS.map((skill) => (
              <PluginRow key={skill.name} name={skill.name} description={skill.description}
                tile={<PluginTile icon={BookOpenIcon} kind="skill" />}
                trailing={<PluginStatePill status={{ label: 'built in', tone: 'neutral' }} />} />
            ))}
          </div>
        </section>

      </div>
      {managing && <AccountPanelModal panel="mcp" returnTo={APP_ROUTES.plugins} onClose={() => setManaging(false)} />}
    </div>
  );
}
