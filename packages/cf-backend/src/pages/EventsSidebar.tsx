/**
 * Events sidebar — per-agent timeline of incoming events from every ingress.
 *
 * Filterable by variant. Auto-refreshes every 5s. Shows trust badge,
 * priority, brief.
 */
import { useEffect, useState, useCallback } from "react";
import { useParams } from "react-router-dom";
import { Loader } from "@cloudflare/kumo";
import { ArrowsClockwiseIcon, FunnelIcon } from "@phosphor-icons/react";
import { listAgentEvents, type EventRow } from "../lib/user-api";

const VARIANT_FILTERS: ReadonlyArray<string> = [
  'all', 'chat', 'webhook', 'timer', 'process_done', 'peer_agent',
  'file_changed', 'internal', 'mcp_chat', 'mcp_third_party', 'reply_request',
];

export default function EventsSidebar() {
  const { agentId } = useParams();
  const [events, setEvents] = useState<EventRow[]>([]);
  const [variant, setVariant] = useState<string>('all');
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!agentId) return;
    try {
      const { events } = await listAgentEvents(agentId, {
        variant: variant === 'all' ? undefined : variant,
        limit: 200,
      });
      setEvents(events);
      setErr(null);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [agentId, variant]);

  useEffect(() => { refresh(); }, [refresh]);

  // Auto-refresh every 5s
  useEffect(() => {
    const t = setInterval(refresh, 5000);
    return () => clearInterval(t);
  }, [refresh]);

  if (loading) return <div className="h-full flex items-center justify-center"><Loader size="base" /></div>;

  return (
    <div className="h-full flex flex-col">
      <div className="p-3 border-b p-border flex items-center gap-2">
        <FunnelIcon size={12} className="p-text-3" />
        <select value={variant} onChange={(e) => setVariant(e.target.value)}
          className="text-xs p-elevated px-2 py-1 rounded p-text border p-border focus:outline-none">
          {VARIANT_FILTERS.map(v => <option key={v} value={v}>{v}</option>)}
        </select>
        <button onClick={refresh} className="ml-auto p-text-3 hover:p-text p-1" title="Refresh">
          <ArrowsClockwiseIcon size={12} />
        </button>
      </div>
      {err && <div className="px-3 py-2 text-xs text-red-400">{err}</div>}
      <div className="flex-1 overflow-y-auto">
        {events.length === 0 ? (
          <div className="p-6 text-center">
            <p className="text-xs p-text-3">No events yet.</p>
          </div>
        ) : (
          <ul className="divide-y p-border">
            {events.map((e) => <EventListItem key={e.id} event={e} />)}
          </ul>
        )}
      </div>
    </div>
  );
}

function EventListItem({ event }: { event: EventRow }) {
  const time = new Date(event.received_at);
  return (
    <li className="px-3 py-2 hover:p-card-hover">
      <div className="flex items-center gap-1.5 text-[10px] p-text-3 mb-0.5">
        <span className={`px-1 rounded ${trustBadge(event.trust)}`}>{event.trust}</span>
        <span className={`px-1 rounded ${priorityBadge(event.priority)}`}>{event.priority}</span>
        <span>{event.variant}</span>
        <span className="ml-auto">{time.toLocaleTimeString()}</span>
      </div>
      <div className="text-xs p-text-2 truncate font-mono">{event.ingress}</div>
      <details className="mt-1">
        <summary className="text-[10px] p-text-3 cursor-pointer hover:p-text">payload</summary>
        <pre className="text-[10px] mt-1 p-elevated p-2 rounded overflow-x-auto font-mono">{JSON.stringify(event.payload, null, 2).slice(0, 800)}</pre>
      </details>
    </li>
  );
}

function trustBadge(trust: EventRow['trust']): string {
  switch (trust) {
    case 'owner':         return 'bg-blue-500/15 text-blue-300';
    case 'self':          return 'bg-purple-500/15 text-purple-300';
    case 'authenticated': return 'bg-green-500/15 text-green-300';
    case 'external':      return 'bg-yellow-500/15 text-yellow-300';
  }
}

function priorityBadge(p: EventRow['priority']): string {
  switch (p) {
    case 'urgent':     return 'bg-red-500/15 text-red-300';
    case 'normal':     return 'bg-gray-500/15 text-gray-300';
    case 'background': return 'bg-gray-700/15 text-gray-400';
  }
}
