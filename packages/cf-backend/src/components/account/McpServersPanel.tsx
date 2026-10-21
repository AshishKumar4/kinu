/** MCP server panel. A server that signs in connects through `beginConnect`; its end updates this panel in place. */
import { Effect, Cause } from 'effect';
import { useState, useCallback } from "react";
import { Loader } from "@cloudflare/kumo";
import { Button } from "@/components/ui/Button";
import { PlugIcon, PlusIcon, TrashIcon, ArrowSquareOutIcon, CheckIcon, WarningIcon } from "@phosphor-icons/react";
import type { ConnectEnded, McpTransport } from "@kinu.run/core";
import { beginConnect, signInMcpServer } from "@/lib/connect-window";
import { addMcpServer, removeMcpServer } from "@/lib/user-api";
import { McpPresetCards } from "@/components/plugins/McpPresetCards";
import { Status } from "@/components/ui/Status";
import { mcpServerStatus } from "@/components/plugins/mcp-status";
import { useConfirmation } from "@/components/ui/ConfirmDialog";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { Choice, inputCls } from "@/components/ui/form";
import { SECRET_REGION } from "@/components/ui/SecretValue";
import { lastValue } from "@/hooks/use-async-resource";
import { useMcpServers, useMcpWatch, type McpServers } from "@/hooks/use-mcp-servers";
import * as v from "valibot";
import { renderThrownChain, detach } from '@kinu.run/core/obs';

/** The panel over a read of its own, where no page around it shows the same servers. */
export function McpServersSection() {
  return <McpServersPanel mcp={useMcpServers()} />;
}

export function McpServersPanel({ mcp }: { mcp: McpServers }) {
  const { servers: read, presets, refresh: reload } = mcp;
  const { resource } = read;

  // Open, it watches: the shared read chooses the cadence.
  useMcpWatch(mcp);
  const servers = lastValue(resource) ?? [];
  const [showAdd, setShowAdd] = useState(false);
  // How the last sign-in this panel started ended, as its finish page said.
  const [ended, setEnded] = useState<ConnectEnded | null>(null);

  const connected = useCallback((done: ConnectEnded) => {
    setEnded(done);
    reload();
  }, [reload]);

  // Why the last sign-in could not begin, before any tab ran it.
  const setSignInFailed = useCallback((error: string) => { setEnded({ run: null, service: 'The MCP server', error }); }, []);

  const { ask, dialog } = useConfirmation();

  const remove = useCallback((id: string, name: string) => ask({
    title: `Remove "${name}"?`, body: "All workspaces will lose access to its tools.", action: "Remove", failed: "Could not remove it",
    run: async () => { await removeMcpServer(id); reload(); },
  }), [ask, reload]);

  return (
    <div className="space-y-4">
      {dialog}
      <div className="space-y-0.5">
        <McpPresetCards servers={servers} availability={lastValue(presets.resource) ?? undefined} onChanged={reload} onConnected={connected} />
      </div>

      <div className="flex justify-end">
        <Button size="sm" variant="secondary" icon={<PlusIcon size={12} />}
          onClick={() => setShowAdd((shown) => !shown)}>
          Add custom server
        </Button>
      </div>

      {ended !== null && ended.error === null && (
        <div className="p-card p-3 text-xs flex items-center gap-2 p-success" data-connect-ended="connected">
          <CheckIcon size={14} /> Connected to {ended.service}. Discovering tools…
        </div>
      )}
      {ended !== null && ended.error !== null && (
        <div className="p-card p-3 text-xs flex items-center gap-2 p-danger" data-connect-ended="failed">
          <WarningIcon size={14} /> {ended.service} did not connect: {ended.error}
        </div>
      )}
      {resource.status === "error" && <LoadFailure what="your MCP servers" message={resource.message} onRetry={reload} />}

      {showAdd && (
        <AddServerCard
          onCancel={() => setShowAdd(false)}
          onAdded={() => { setShowAdd(false); reload(); }}
          onConnected={connected}
        />
      )}

      {resource.status === "loading" && <div className="flex items-center justify-center py-12"><Loader size="base" /></div>}

      {resource.status !== "loading" && (servers.length === 0 ? (
        <section className="p-card p-8 text-center space-y-2">
          <PlugIcon size={28} className="p-text-3 mx-auto" />
          <div className="text-sm font-medium">No MCP servers yet</div>
        </section>
      ) : (
        <section className="p-card overflow-hidden">
          <div className="p-group text-xs">
            {servers.map((s) => (
              <div key={s.id} className="px-4 py-3" data-mcp-server={s.id}>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5">
                  <span className="p-row-text font-medium p-text">{s.name}</span>
                  <Status tone={mcpServerStatus(s.status).tone}>{mcpServerStatus(s.status).label}</Status>
                  <div className="ml-auto flex items-center gap-2">
                    {s.signIn && (
                      <button
                        type="button" data-mcp-sign-in onClick={() => detach(Effect.promise(async () => {
                          const failed = await signInMcpServer(beginConnect(), s.id, connected);

                          if (failed !== null) setSignInFailed(failed);
                        }))}
                        className="text-xs px-2 py-1 rounded-sm p-card p-card-hover flex items-center gap-1"
                      >
                        <ArrowSquareOutIcon size={11} /> Authorize
                      </button>
                    )}
                    <button
                      onClick={() => remove(s.id, s.name)}
                      className="text-xs p-text-3 hover:p-danger flex items-center gap-1 px-2 py-1"
                      title="Remove server"
                    >
                      <TrashIcon size={11} /> Remove
                    </button>
                  </div>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-2 p-annotation p-text-3">
                  <span className="truncate max-w-full font-mono" title={s.serverUrl}>{s.serverUrl}</span>
                  <span>·</span>
                  <span>{s.transport}</span>
                  <span>·</span>
                  <span>
                    {s.toolsCount} {s.toolsCount === 1 ? 'tool' : 'tools'}
                    {s.allowedTools ? ` / ${s.allowedTools.length} allowed` : ''}
                  </span>
                </div>
                {s.error && (
                  <div className="mt-1 p-t-status p-danger" title={s.error}>
                    {s.error}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

export function AddServerCard({ onCancel, onAdded, onConnected }: {
  onCancel: () => void;
  onAdded: () => void;
  /** Hears how a server that signs in ended its sign-in. */
  onConnected: (ended: ConnectEnded) => void;
}) {
  const [name, setName] = useState('');
  const [serverUrl, setServerUrl] = useState('');
  const [transport, setTransport] = useState<McpTransport>('auto');
  const [headersText, setHeadersText] = useState('');
  const [allowedTools, setAllowedTools] = useState('');
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const save = useCallback(() => detach(Effect.gen(function* () {
    if (!name.trim() || !serverUrl.trim()) return;
    setErr(null); setSaving(true);

    return yield* Effect.ensuring(Effect.catchCause(Effect.gen(function* () {
      let headers: Record<string, string> | undefined;

      if (headersText.trim()) {
        yield* Effect.catchCause(Effect.sync(() => {
          headers = v.parse(v.record(v.string(), v.string()), JSON.parse(headersText));
        }), (failed) => {
          const e = Cause.squash(failed);

          return Effect.die(new Error(`Headers are not valid JSON: ${renderThrownChain({ cause: e })}`, { cause: e }));
        });
      }

      const tools = allowedTools.trim()
        ? allowedTools.split(',').map((s) => s.trim()).filter(Boolean)
        : undefined;

      const result = yield* Effect.promise(async () => addMcpServer({
        name: name.trim(), serverUrl: serverUrl.trim(), transport, headers, allowedTools: tools,
      }));

      // Known only now: a custom server may or may not sign in. Opened after the add, a blocked helper runs it in this tab.
      // A sign-in that could not begin is said where the panel says every sign-in's end: this card closes on the add.
      if (result.authUrl) {
        const failed = yield* Effect.promise(async () => signInMcpServer(beginConnect(), result.id, onConnected));

        if (failed !== null) onConnected({ run: null, service: name.trim(), error: failed });
      }

      onAdded();
    }), (failed) => Effect.sync(() => {
      const e = Cause.squash(failed); setErr(renderThrownChain({ cause: e })); })), Effect.sync(() => { setSaving(false); }));
  })), [name, serverUrl, transport, headersText, allowedTools, onAdded, onConnected]);

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
          <Choice label="Transport" value={transport} onChange={setTransport} options={MCP_TRANSPORTS} />
        </div>
      </div>
      <div className="space-y-1">
        <label className="text-xs p-text-3">Server URL</label>
        <input value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} className={inputCls}
          placeholder="https://mcp.example.com/v1" />
      </div>
      <div className="space-y-1">
        <label className="text-xs p-text-3">
          Static headers for private servers (optional JSON)
        </label>
        {/* Credential region: the marker keeps the typed value out of feedback screenshots. */}
        <textarea {...SECRET_REGION} value={headersText}
          onChange={(e) => setHeadersText(e.target.value)}
          rows={2} className={inputCls + ' font-mono'}
          placeholder='{"Authorization": "Bearer xyz"}' />
      </div>
      <div className="space-y-1">
        <label className="text-xs p-text-3">Allowed tools (optional, comma-separated; leave empty for all)</label>
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

const MCP_TRANSPORTS: ReadonlyArray<{ value: McpTransport; label: string }> = [
  { value: 'auto', label: 'auto (recommended)' },
  { value: 'streamable-http', label: 'streamable-http' },
  { value: 'sse', label: 'sse' },
];
