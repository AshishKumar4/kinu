/**
 * Plugins — what this account's agents can reach beyond their built-in tools,
 * in one grid grammar: MCP servers, the tools workspaces crafted and published
 * to the owner's library, the skills every workspace ships with, and the
 * machines the owner linked. Each is a read of its own, failing on its own,
 * so an unreachable MCP plane never blanks the skills beside it.
 *
 * Skills a workspace writes for itself live in that workspace's object and
 * are listed there; only the built-in doctrine is account-wide. Crafted tools
 * reach the account only once a workspace publishes them to the experience
 * library — a tool still private to its workspace is not listed here.
 */
import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Button, Loader } from "@cloudflare/kumo";
import {
  BookOpenIcon, DesktopTowerIcon, PlugsConnectedIcon, PuzzlePieceIcon, WrenchIcon,
} from "@phosphor-icons/react";
import { APP_ROUTES, BUILTIN_SKILL_HEADERS } from "@kinu.run/core";
import {
  listDeviceConsents, listDevices, listExperience, listMcpServers, listMcpPresets,
  type McpServerSummary,
} from "@/lib/user-api";
import { useAsyncResource, mapResource, lastValue, type AsyncResource } from "@/hooks/use-async-resource";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { PluginCard, type PluginStatus } from "@/components/plugins/PluginCard";
import { McpPresetCards } from "@/components/plugins/McpPresetCards";
import { AccountPanelModal } from "@/components/account/AccountPanelModal";

const loadCrafts = () => listExperience('craft');

/** While a preset sign-in is open in another tab the user returns to this
 *  page mid-flow, so the server list re-reads itself until every connection
 *  has settled — the same 5s the MCP panel polls on, and only while one is
 *  actually pending. */
const revalidateServers = (rows: McpServerSummary[] | null): number | null =>
  rows?.some((s) => s.status === 'authenticating' || s.status === 'connecting'
    || s.status === 'discovering') ? 5000 : null;

/** A server's reachability as a card status: the same words the MCP panel's
 *  badge uses, in the card's own tone vocabulary. */
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
    default:
      return { label: status, tone: 'neutral' };
  }
}

/** One section of the grid: its eyebrow, an optional action or note beside
 *  it, and its cards — or the read's own loader, failure, or empty line. */
function PluginSection({ title, cards, onRetry, what, action, note, empty }: {
  title: string;
  cards: AsyncResource<readonly ReactNode[]>;
  onRetry: () => void;
  what: string;
  action?: ReactNode;
  note?: string;
  empty: ReactNode;
}) {
  return (
    <section aria-label={title} className="space-y-3">
      <div className="flex items-center justify-between gap-3 px-1">
        <h2 className="p-eyebrow">{title}</h2>
        {action}
      </div>
      {note && <p className="px-1 p-meta p-text-3">{note}</p>}
      {cards.status === "loading" && <div className="flex justify-center py-4"><Loader size="sm" /></div>}
      {cards.status === "error" && <LoadFailure what={what} message={cards.message} onRetry={onRetry} />}
      {cards.status === "ready" && (
        cards.value.length === 0
          ? <p className="px-1 p-row-text p-text-3">{empty}</p>
          : <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{cards.value}</div>
      )}
    </section>
  );
}

export default function PluginsPage() {
  const servers = useAsyncResource(listMcpServers, revalidateServers);
  const presets = useAsyncResource(listMcpPresets);
  const crafts = useAsyncResource(loadCrafts);
  const consents = useAsyncResource(listDeviceConsents);
  const devices = useAsyncResource(listDevices);
  const [managing, setManaging] = useState(false);

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-8 px-6 py-8">
        <header className="flex items-start gap-3">
          <PuzzlePieceIcon size={22} className="mt-1 shrink-0 p-text-3" />
          <div>
            <h1 className="p-display text-2xl">Plugins</h1>
          </div>
        </header>

        <PluginSection title="MCP servers" onRetry={servers.reload} what="your MCP servers"
          action={<Button variant="ghost" size="sm" onClick={() => setManaging(true)}>Manage</Button>}
          empty="No MCP server yet."
          cards={mapResource(servers.resource, (rows) => [
            <McpPresetCards key="presets" servers={rows}
              availability={lastValue(presets.resource) ?? undefined}
              onChanged={servers.reload} />,
            ...rows.map((server) => (
              <PluginCard key={server.id} icon={PlugsConnectedIcon} kind="server" name={server.name} line={server.serverUrl}
                status={serverStatus(server.status)} />
            )),
          ])}
        />

        <PluginSection title="Crafted tools" onRetry={crafts.reload} what="your crafted tools"
          empty="No workspace has published a tool to your library yet."
          cards={mapResource(crafts.resource, (rows) => rows.map((entry) => (
            <PluginCard key={entry.id} icon={WrenchIcon} kind="tool" name={entry.title}
              line={entry.payload.description ?? entry.evidence}
              status={{ label: `from ${entry.sourceWorkspace}`, tone: 'neutral' }} />
          )))}
        />

        <section aria-label="Skills" className="space-y-3">
          <div className="flex items-center justify-between gap-3 px-1">
            <h2 className="p-eyebrow">Skills</h2>
          </div>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {BUILTIN_SKILL_HEADERS.map((skill) => (
              <PluginCard key={skill.name} icon={BookOpenIcon} kind="skill" name={skill.name} line={skill.description}
                status={{ label: 'built in', tone: 'neutral' }} />
            ))}
          </div>
        </section>

        <PluginSection title="Device grants" onRetry={consents.reload} what="the device grants"
          empty={<>No machine is linked yet. <Link to={`${APP_ROUTES.userSettings}#devices`} className="p-accent">Link one →</Link></>}
          cards={mapResource(consents.resource, (rows) => rows.map((grant) => {
            const device = devices.resource.status === "ready"
              ? devices.resource.value.find((candidate) => candidate.id === grant.deviceId)
              : undefined;

            return (
              <PluginCard key={`${grant.deviceId}:${grant.agentName}`} icon={DesktopTowerIcon} kind="device"
                name={device?.label ?? grant.deviceId} line={`workspace ${grant.agentName}`}
                status={grant.policy === 'allow'
                  ? { label: 'allowed', tone: 'success' }
                  : { label: grant.policy, tone: 'neutral' }} />
            );
          }))}
        />
      </div>
      {managing && <AccountPanelModal panel="mcp" returnTo={APP_ROUTES.plugins} onClose={() => setManaging(false)} />}
    </div>
  );
}
