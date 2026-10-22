/** MCP server panel. A server that signs in connects through `beginConnect`; its end updates this panel in place. */
import { Effect, Cause } from 'effect';
import { useState, useCallback } from "react";
import { Loader } from "@/components/ui/Loader";
import { Button } from "@/components/ui/Button";
import { PlugIcon, PlusIcon, TrashIcon, ArrowSquareOutIcon } from "@phosphor-icons/react";
import type { ConnectEnded, McpTransport } from "@kinu.run/core";
import { beginConnect, signInMcpServer } from "@/lib/connect-window";
import { addMcpServer, removeMcpServer } from "@/lib/user-api";
import { McpPresetCards } from "@/components/plugins/McpPresetCards";
import { Status } from "@/components/ui/Status";
import { mcpServerStatus } from "@/components/plugins/mcp-status";
import { useConfirmation } from "@/components/ui/ConfirmDialog";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { Choice, Field } from "@/components/ui/form";
import { Card } from "@/components/ui/Card";
import { Empty } from "@/components/ui/Empty";
import { Group } from "@/components/ui/Group";
import { Notice } from "@/components/ui/Notice";
import { TextArea, TextInput } from "@/components/ui/Field";
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
      <div className="space-y-px">
        <McpPresetCards servers={servers} availability={lastValue(presets.resource) ?? undefined} onChanged={reload} onConnected={connected} />
      </div>

      <div className="flex justify-end">
        <Button size="sm" variant="secondary" icon={<PlusIcon size={12} />}
          onClick={() => setShowAdd((shown) => !shown)}>
          Add custom server
        </Button>
      </div>

      {ended !== null && ended.error === null && (
        <Notice tone="success" data-connect-ended="connected">Connected to {ended.service}. Discovering tools…</Notice>
      )}
      {ended !== null && ended.error !== null && (
        <Notice tone="danger" data-connect-ended="failed">{ended.service} did not connect: {ended.error}</Notice>
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
        <Card><Empty icon={PlugIcon} title="No MCP servers yet" /></Card>
      ) : (
        <Group>
            {servers.map((s) => (
              <div key={s.id} className="px-4 py-3" data-mcp-server={s.id}>
                <div className="flex flex-wrap items-center gap-x-2 gap-y-2">
                  <span className="t-item p-text">{s.name}</span>
                  <Status tone={mcpServerStatus(s.status).tone}>{mcpServerStatus(s.status).label}</Status>
                  <div className="ml-auto flex items-center gap-2">
                    {s.signIn && (
                      <Button size="sm" icon={<ArrowSquareOutIcon size={14} />} data-mcp-sign-in onClick={() => detach(Effect.promise(async () => {
                        const failed = await signInMcpServer(beginConnect(), s.id, connected);

                        if (failed !== null) setSignInFailed(failed);
                      }))}>Authorize</Button>
                    )}
                    <Button variant="danger" size="sm" icon={<TrashIcon size={14} />} onClick={() => remove(s.id, s.name)} title="Remove server">Remove</Button>
                  </div>
                </div>
                <div className="t-meta t-mono mt-1 flex flex-wrap items-center gap-x-2 p-text-3">
                  <span className="truncate max-w-full" title={s.serverUrl}>{s.serverUrl}</span>
                  <span>·</span>
                  <span>{s.transport}</span>
                  <span>·</span>
                  <span>
                    {s.toolsCount} {s.toolsCount === 1 ? 'tool' : 'tools'}
                    {s.allowedTools ? ` / ${s.allowedTools.length} allowed` : ''}
                  </span>
                </div>
                {s.error && (
                  <div className="t-status mt-1 p-danger" title={s.error}>
                    {s.error}
                  </div>
                )}
              </div>
            ))}
        </Group>
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
    <Card title="Add MCP server" actions={<Button variant="ghost" size="sm" onClick={onCancel}>Cancel</Button>}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Name"><TextInput value={name} onChange={(e) => setName(e.target.value)} placeholder="github" /></Field>
        <Field label="Transport"><Choice label="Transport" value={transport} onChange={setTransport} options={MCP_TRANSPORTS} /></Field>
      </div>
      <Field label="Server URL">
        <TextInput value={serverUrl} onChange={(e) => setServerUrl(e.target.value)} placeholder="https://mcp.example.com/v1" />
      </Field>
      <Field label="Static headers for private servers" hint="Optional, as JSON.">
        {/* Credential region: the marker keeps the typed value out of feedback screenshots. */}
        <TextArea mono {...SECRET_REGION} value={headersText} onChange={(e) => setHeadersText(e.target.value)} rows={2}
          placeholder='{"Authorization": "Bearer xyz"}' />
      </Field>
      <Field label="Allowed tools" hint="Optional, comma-separated; leave it empty for all.">
        <TextInput value={allowedTools} onChange={(e) => setAllowedTools(e.target.value)} placeholder="create_issue, list_pulls" />
      </Field>
      {err && <p className="t-meta p-danger">{err}</p>}
      <div className="flex items-center justify-end gap-2">
        <Button variant="primary" size="sm" busy={saving} disabled={!name.trim() || !serverUrl.trim()} onClick={save}>Add server</Button>
      </div>
    </Card>
  );
}

const MCP_TRANSPORTS: ReadonlyArray<{ value: McpTransport; label: string }> = [
  { value: 'auto', label: 'auto (recommended)' },
  { value: 'streamable-http', label: 'streamable-http' },
  { value: 'sse', label: 'sse' },
];
