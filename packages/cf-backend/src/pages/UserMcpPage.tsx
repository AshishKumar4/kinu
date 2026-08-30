/**
 * User MCP servers — connect MCP-compatible services once, pick from them
 * inside any agent's tool surface. Settings live in UserDO, not per-agent.
 *
 * Add flow:
 *   1. POST /api/user/mcp/servers — UserDO inserts row + opens connection
 *   2. If OAuth required, response carries an `authUrl`; we open it in a tab
 *   3. IdP redirects to /api/user/mcp/callback → UserDO completes the dance
 *   4. We land back here with `?mcp_auth=ok&server_id=...`
 *
 * Live status: polled every 5s; if a tab returns from the OAuth flow with
 * `mcp_auth=ok`, we refresh immediately.
 */
import { startTransition, useEffect, useState, useCallback, useRef } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Loader } from "@cloudflare/kumo";
import {
  PlugIcon, PlusIcon, TrashIcon, ArrowLeftIcon, ArrowSquareOutIcon,
  CheckIcon, WarningIcon, ClockClockwiseIcon,
} from "@phosphor-icons/react";
import {
  listMcpServers, addMcpServer, removeMcpServer,
  type McpServerSummary, type McpTransport,
} from "../lib/user-api";
import { inputCls } from "@/components/ui/form";
import { SECRET_REGION } from "@/components/ui/SecretValue";
import * as v from "valibot";
import { renderThrownChain } from '@kinu.run/core/obs';

const POLL_MS = 5000;

function statusBadge(status: McpServerSummary['status']) {
  switch (status) {
    case 'ready':
    case 'connected':
      return { label: status, classes: 'p-badge-success', Icon: CheckIcon };
    case 'authenticating':
      return { label: 'auth needed', classes: 'p-badge-warning', Icon: ClockClockwiseIcon };
    case 'connecting':
    case 'discovering':
      return { label: status, classes: 'p-badge-info', Icon: ClockClockwiseIcon };
    case 'failed':
      return { label: 'failed', classes: 'p-badge-danger', Icon: WarningIcon };
    default:
      return { label: status, classes: 'p-card p-text-3', Icon: ClockClockwiseIcon };
  }
}

export default function UserMcpPage() {
  const [servers, setServers] = useState<McpServerSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [searchParams, setSearchParams] = useSearchParams();
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // The mount effect, poll, OAuth return and mutation callbacks all invoke this
  // synchronous reader. React owns its transition and the visible error remains
  // the one place every refresh failure is recorded.
  const refresh = useCallback((): void => {
    setErr(null);
    startTransition(async () => {
      try {
        const rows = await listMcpServers();
        setServers(rows);
      } catch (cause) {
        setErr(renderThrownChain({ cause }));
      } finally {
        setLoading(false);
      }
    });
  }, []);

  useEffect(() => {
    refresh();
    pollRef.current = setInterval(refresh, POLL_MS);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [refresh]);

  // Returning from OAuth — surface result, then strip query params so reloads
  // don't show stale state.
  const authResult = searchParams.get('mcp_auth');
  const authError = searchParams.get('error');
  useEffect(() => {
    if (!authResult) return;
    refresh();
    const t = setTimeout(() => {
      const next = new URLSearchParams(searchParams);
      next.delete('mcp_auth'); next.delete('error'); next.delete('server_id');
      setSearchParams(next, { replace: true });
    }, 4000);
    return () => clearTimeout(t);
  }, [authResult, refresh, searchParams, setSearchParams]);

  const remove = useCallback(async (id: string, name: string) => {
    if (!confirm(`Remove "${name}"? All workspaces will lose access to its tools.`)) return;
    try { await removeMcpServer(id); refresh(); } catch (e) { alert(renderThrownChain({ cause: e })); }
  }, [refresh]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-4xl mx-auto px-6 py-8 space-y-6">
        <header>
          <Link to="/user/settings" className="text-xs p-text-3 flex items-center gap-1 hover:p-text mb-2">
            <ArrowLeftIcon size={12} /> Back to account settings
          </Link>
          <div className="flex items-center justify-between gap-4">
            <div>
              <h1 className="p-display text-2xl">MCP servers</h1>
              <p className="text-xs p-text-3 mt-1">
                Model Context Protocol servers add hosted
                tools (GitHub, Notion, your own internal MCP, …). Connect once; every agent you
                own picks them up automatically.
              </p>
            </div>
            <button
              onClick={() => setShowAdd((v) => !v)}
              className="px-3 py-1.5 rounded-md p-accent-bg p-accent text-xs font-medium hover:opacity-90 transition-opacity flex items-center gap-1.5 whitespace-nowrap"
            >
              <PlusIcon size={12} /> Add MCP server
            </button>
          </div>
        </header>

        {authResult === 'ok' && (
          <div className="p-card p-3 text-xs flex items-center gap-2 p-success">
            <CheckIcon size={14} /> Authorization complete. Discovering tools…
          </div>
        )}
        {authResult === 'failed' && (
          <div className="p-card p-3 text-xs flex items-center gap-2 p-danger">
            <WarningIcon size={14} /> Authorization failed{authError ? `: ${authError}` : ''}.
          </div>
        )}
        {err && <div className="p-card p-3 text-xs p-danger">{err}</div>}

        {showAdd && (
          <AddServerCard
            onCancel={() => setShowAdd(false)}
            onAdded={() => { setShowAdd(false); refresh(); }}
          />
        )}

        {loading ? (
          <div className="flex items-center justify-center py-12"><Loader size="base" /></div>
        ) : servers.length === 0 ? (
          <section className="p-card p-8 text-center space-y-2">
            <PlugIcon size={28} className="p-text-3 mx-auto" />
            <div className="text-sm font-medium">No MCP servers yet</div>
            <p className="text-xs p-text-3 max-w-md mx-auto">
              Connect a server to expose its tools to every agent you own. Most MCP servers use
              OAuth; you'll be redirected to authorize on the provider's site.
            </p>
          </section>
        ) : (
          <section className="p-card overflow-hidden">
            <table className="w-full text-sm">
              <thead className="text-xs p-text-3 border-b p-border">
                <tr>
                  <th className="text-left px-4 py-2 font-medium">Name</th>
                  <th className="text-left px-4 py-2 font-medium">URL</th>
                  <th className="text-left px-4 py-2 font-medium">Transport</th>
                  <th className="text-left px-4 py-2 font-medium">Status</th>
                  <th className="text-left px-4 py-2 font-medium">Tools</th>
                  <th className="px-4 py-2"></th>
                </tr>
              </thead>
              <tbody>
                {servers.map((s) => {
                  const badge = statusBadge(s.status);
                  return (
                    <tr key={s.id} className="border-b p-border last:border-b-0">
                      <td className="px-4 py-3 font-medium">{s.name}</td>
                      <td className="px-4 py-3 p-text-2 font-mono text-xs truncate max-w-[260px]" title={s.serverUrl}>
                        {s.serverUrl}
                      </td>
                      <td className="px-4 py-3 p-text-2 text-xs">{s.transport}</td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center gap-1 rounded-sm px-2 py-0.5 text-[11px] ${badge.classes}`}>
                          <badge.Icon size={10} /> {badge.label}
                        </span>
                        {s.error && (
                          <div className="text-[11px] p-danger mt-1 max-w-[260px] truncate" title={s.error}>
                            {s.error}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 p-text-2 text-xs tabular-nums">
                        {s.toolsCount}{s.allowedTools ? ` / ${s.allowedTools.length} allowed` : ''}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2 justify-end">
                          {s.authUrl && (
                            <a
                              href={s.authUrl} target="_blank" rel="noopener noreferrer"
                              className="text-xs px-2 py-1 rounded-sm p-card p-card-hover flex items-center gap-1"
                            >
                              <ArrowSquareOutIcon size={11} /> Authorize
                            </a>
                          )}
                          <button
                            onClick={() => remove(s.id, s.name)}
                            className="text-xs p-text-3 hover:p-danger flex items-center gap-1 px-2 py-1"
                            title="Remove server"
                          >
                            <TrashIcon size={11} /> Remove
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        )}
      </div>
    </div>
  );
}

// ── Add Server card ─────────────────────────────────────────────────

export function AddServerCard({ onCancel, onAdded }: { onCancel: () => void; onAdded: () => void }) {
  const [name, setName] = useState('');
  const [serverUrl, setServerUrl] = useState('');
  const [transport, setTransport] = useState<McpTransport>('auto');
  const [headersText, setHeadersText] = useState('');
  const [allowedTools, setAllowedTools] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = useCallback(async () => {
    if (!name.trim() || !serverUrl.trim()) return;
    setErr(null); setSaving(true);
    try {
      let headers: Record<string, string> | undefined;
      if (headersText.trim()) {
        try {
          headers = v.parse(v.record(v.string(), v.string()), JSON.parse(headersText));
        } catch (e) { throw new Error(`Bad headers JSON: ${renderThrownChain({ cause: e })}`, { cause: e }); }
      }
      const tools = allowedTools.trim()
        ? allowedTools.split(',').map((s) => s.trim()).filter(Boolean)
        : undefined;
      const result = await addMcpServer({
        name: name.trim(), serverUrl: serverUrl.trim(), transport, headers, allowedTools: tools,
      });
      if (result.authUrl) {
        window.open(result.authUrl, '_blank', 'noopener,noreferrer');
      }
      onAdded();
    } catch (e) { setErr(renderThrownChain({ cause: e })); }
    finally { setSaving(false); }
  }, [name, serverUrl, transport, headersText, allowedTools, onAdded]);

  return (
    <section className="p-card p-5 space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Add MCP server</h2>
        <button onClick={onCancel} className="text-xs p-text-3 hover:p-text">Cancel</button>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className="text-xs p-text-3">Name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} placeholder="github" />
        </div>
        <div className="space-y-1">
          <label className="text-xs p-text-3">Transport</label>
          <select value={transport} onChange={(e) => setTransport(v.parse(McpTransportSchema, e.target.value))} className={inputCls}>
            <option value="auto">auto (recommended)</option>
            <option value="streamable-http">streamable-http</option>
            <option value="sse">sse</option>
          </select>
        </div>
      </div>
      <div className="space-y-1">
        <label className="text-xs p-text-3">Server URL</label>
        <input value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} className={inputCls}
          placeholder="https://mcp.example.com/v1" />
      </div>
      <div className="space-y-1">
        <label className="text-xs p-text-3">
          Static headers (optional JSON, for private or bearer-protected servers)
        </label>
        {/* A credential region, not a hint: what a person types here is
            `{"Authorization": "Bearer …"}`, and a textarea cannot be a password
            field. The marker is what keeps it out of a feedback screenshot. */}
        <textarea {...SECRET_REGION} value={headersText}
          onChange={(e) => setHeadersText(e.target.value)}
          rows={2} className={inputCls + ' font-mono'}
          placeholder='{"Authorization": "Bearer xyz"}' />
      </div>
      <div className="space-y-1">
        <label className="text-xs p-text-3">Allowed tools (optional, comma-separated; empty = all)</label>
        <input value={allowedTools} onChange={(e) => setAllowedTools(e.target.value)} className={inputCls}
          placeholder="create_issue, list_pulls" />
      </div>
      {err && <p className="text-xs p-danger">{err}</p>}
      <div className="flex items-center justify-end gap-2 pt-1">
        <button
          onClick={save}
          disabled={saving || !name.trim() || !serverUrl.trim()}
          className="px-3 py-1.5 rounded-md p-accent-bg p-accent text-xs font-medium disabled:opacity-50 hover:opacity-90"
        >{saving ? 'Adding…' : 'Add server'}</button>
      </div>
    </section>
  );
}

const McpTransportSchema = v.picklist(['auto', 'sse', 'streamable-http']);

