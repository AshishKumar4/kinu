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
  listDeviceConsents, listDevices, listExperience, listMcpServers,
  type McpServerSummary,
} from "@/lib/user-api";
import { useAsyncResource, type AsyncResource } from "@/hooks/use-async-resource";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { PluginCard, type PluginStatus } from "@/components/plugins/PluginCard";
import { AccountPanelModal } from "@/components/account/AccountPanelModal";

const loadCrafts = () => listExperience('craft');

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
function PluginSection<T>({ title, resource, onRetry, what, action, note, empty, children }: {
  title: string;
  resource: AsyncResource<T>;
  onRetry: () => void;
  what: string;
  action?: ReactNode;
  note?: string;
  empty: ReactNode;
  children: (value: T) => ReactNode[];
}) {
  return (
    <section aria-label={title} className="space-y-3">
      <div className="flex items-center justify-between gap-3 px-1">
        <h2 className="p-eyebrow">{title}</h2>
        {action}
      </div>
      {note && <p className="px-1 p-meta p-text-3">{note}</p>}
      {resource.status === "loading" && <div className="flex justify-center py-4"><Loader size="sm" /></div>}
      {resource.status === "error" && <LoadFailure what={what} message={resource.message} onRetry={onRetry} />}
      {resource.status === "ready" && (() => {
        const cards = children(resource.value);

        return cards.length === 0
          ? <p className="px-1 p-row-text p-text-3">{empty}</p>
          : <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{cards}</div>;
      })()}
    </section>
  );
}

export default function PluginsPage() {
  const servers = useAsyncResource(listMcpServers);
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
            <p className="mt-1 text-xs p-text-3">
              What your agents can reach beyond their built-in tools: servers, tools they crafted, skills, and your machines.
            </p>
          </div>
        </header>

        <PluginSection title="MCP servers" resource={servers.resource} onRetry={servers.reload} what="your MCP servers"
          action={<Button variant="ghost" size="sm" onClick={() => setManaging(true)}>Manage</Button>}
          empty="No MCP server yet.">
          {(rows) => rows.map((server) => (
            <PluginCard key={server.id} icon={PlugsConnectedIcon} name={server.name} line={server.serverUrl}
              status={serverStatus(server.status)} />
          ))}
        </PluginSection>

        <PluginSection title="Crafted tools" resource={crafts.resource} onRetry={crafts.reload} what="your crafted tools"
          empty="No workspace has published a tool to your library yet.">
          {(rows) => rows.map((entry) => (
            <PluginCard key={entry.id} icon={WrenchIcon} name={entry.title}
              line={entry.payload.description ?? entry.evidence}
              status={{ label: `from ${entry.sourceWorkspace}`, tone: 'neutral' }} />
          ))}
        </PluginSection>

        <section aria-label="Skills" className="space-y-3">
          <div className="flex items-center justify-between gap-3 px-1">
            <h2 className="p-eyebrow">Skills</h2>
          </div>
          <p className="px-1 p-meta p-text-3">Skills a workspace writes for itself live in that workspace.</p>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {BUILTIN_SKILL_HEADERS.map((skill) => (
              <PluginCard key={skill.name} icon={BookOpenIcon} name={skill.name} line={skill.description}
                status={{ label: 'built in', tone: 'neutral' }} />
            ))}
          </div>
        </section>

        <PluginSection title="Device grants" resource={consents.resource} onRetry={consents.reload} what="the device grants"
          empty={<>No machine is linked yet. <Link to={`${APP_ROUTES.userSettings}#devices`} className="p-accent">Link one →</Link></>}>
          {(rows) => rows.map((grant) => {
            const device = devices.resource.status === "ready"
              ? devices.resource.value.find((candidate) => candidate.id === grant.deviceId)
              : undefined;

            return (
              <PluginCard key={`${grant.deviceId}:${grant.agentName}`} icon={DesktopTowerIcon}
                name={device?.label ?? grant.deviceId} line={`workspace ${grant.agentName}`}
                status={grant.policy === 'allow'
                  ? { label: 'allowed', tone: 'success' }
                  : { label: grant.policy, tone: 'neutral' }} />
            );
          })}
        </PluginSection>
      </div>
      {managing && <AccountPanelModal panel="mcp" returnTo={APP_ROUTES.plugins} onClose={() => setManaging(false)} />}
    </div>
  );
}
