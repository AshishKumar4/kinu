/** One-click MCP preset rows; a row's state is the account's server row tagged with its `preset_id`. */
import { Effect } from 'effect';
import { useState, type ReactNode } from "react";
import {
  ArrowSquareOutIcon, PlusIcon, TrashIcon, XIcon,
} from "@phosphor-icons/react";
import {
  MCP_PRESETS, mcpPresetById, type McpPreset, type McpPresetId, type McpServerSummary,
} from "@kinu.run/core";
import { addMcpServer, removeMcpServer, type McpServerInput } from "@/lib/user-api";
import { inputCls } from "@/components/ui/form";
import { useConfirmation } from "@/components/ui/ConfirmDialog";
import { SECRET_REGION } from "@/components/ui/SecretValue";
import { BrandMark, type BrandName } from "@/components/ui/BrandMark";
import { PluginRow, PLUGIN_ACTION } from "@/components/plugins/PluginRow";
import { Status } from "@/components/ui/Status";
import { RowMenu } from "@/components/ui/RowMenu";
import { mcpServerStatus } from "@/components/plugins/mcp-status";
import { renderThrownChain, detach } from "@kinu.run/core/obs";

const PRESET_MARK: Record<McpPresetId, BrandName> = {
  github: "github",
  cloudflare: "cloudflare",
  google: "google",
};

/** `preset_id` is an arbitrary string on the wire; the catalog resolves it. */
export function presetBrand(presetId: string | null): BrandName | undefined {
  const preset = presetId === null ? undefined : mcpPresetById(presetId);

  return preset === undefined ? undefined : PRESET_MARK[preset.id];
}

/** The host a server answers on; null for a URL that does not parse. */
function hostOf(url: string): string | null {
  return URL.canParse(url) ? new URL(url).hostname : null;
}

/** The catalog's preset a server is: its tag, else the preset whose server it answers on (GitHub's MCP added by URL). */
export function presetOf(server: McpServerSummary): McpPreset | undefined {
  if (server.presetId !== null) return mcpPresetById(server.presetId);
  const host = hostOf(server.serverUrl);

  return host === null ? undefined : MCP_PRESETS.find((preset) => hostOf(preset.serverUrl) === host);
}

/** Services the catalog has no preset for, by the domain their MCP server answers on. */
const HOST_BRANDS: readonly (readonly [string, BrandName])[] = [["linear.app", "linear"], ["notion.com", "notion"]];

/** A custom server's brand, when its host is a known service's or under it. */
export function hostBrand(server: McpServerSummary): BrandName | undefined {
  const host = hostOf(server.serverUrl);

  return host === null ? undefined : HOST_BRANDS.find(([domain]) => host === domain || host.endsWith(`.${domain}`))?.[1];
}

/** A connected row's status cell: the plain `Status` its tone and words name, as every view reads them. */
export function ServerStatus({ status }: { status: McpServerSummary['status'] }) {
  const shown = mcpServerStatus(status);

  return <Status tone={shown.tone}>{shown.label}</Status>;
}

export function PresetRow({ preset, server, appConfigured, onChanged }: {
  preset: McpPreset;
  server: McpServerSummary | undefined;
  /** `undefined` while loading, treated as configured so a row never flickers to its fallback. */
  appConfigured: boolean | undefined;
  onChanged: () => void;
}) {
  const [openToken, setOpenToken] = useState(false);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const brand = PRESET_MARK[preset.id];
  const added = server !== undefined;

  // 'oauth' always signs in; 'oauth-app' only with the deployment's registration, else token fallback.
  const signIn = preset.auth === 'oauth' || (preset.auth === 'oauth-app' && appConfigured !== false);

  const tokenLabel = preset.auth === 'oauth-app'
    ? preset.tokenFallback?.label ?? 'Access token'
    : preset.tokenLabel ?? 'Access token';

  const add = async (input: McpServerInput) => {
    setErr(null);
    setBusy(true);

    try {
      const result = await addMcpServer(input);

      if (result.authUrl) {
        window.open(result.authUrl, '_blank', 'noopener,noreferrer');
      }

      setOpenToken(false);
      setToken('');
      onChanged();
    } catch (e) {
      setErr(renderThrownChain({ cause: e }));
    } finally {
      setBusy(false);
    }
  };

  const connect = async (): Promise<void> => {
    if (signIn) {
      await add({ presetId: preset.id });
    } else {
      setOpenToken(true);
    }
  };

  const { ask, dialog } = useConfirmation();

  const remove = () => {
    if (!server) return;
    ask({
      title: `Remove "${server.name}"?`, body: "All workspaces will lose access to its tools.", action: "Remove", failed: "Could not remove it",
      run: async () => { await removeMcpServer(server.id); onChanged(); },
    });
  };

  const asking = openToken && !added;

  let trailing: ReactNode;

  if (server !== undefined) {
    trailing = (
      <RowMenu label={`More for ${preset.title}`} items={[
        { label: "Docs", icon: ArrowSquareOutIcon, run: () => { window.open(preset.docsUrl, "_blank", "noopener,noreferrer"); } },
        { label: "Remove", icon: TrashIcon, run: remove, danger: true },
      ]} />
    );
  } else if (asking) {
    trailing = (
      <button type="button" data-plugin-cancel onClick={() => setOpenToken(false)}
        aria-label={`Cancel ${preset.title}`} title="Cancel" className={PLUGIN_ACTION}>
        <XIcon size={14} />
      </button>
    );
  } else {
    trailing = (
      <button type="button" data-plugin-add onClick={(...args: Parameters<typeof connect>) => detach(Effect.promise(async () => connect(...args)))} disabled={busy}
        aria-label={`Add ${preset.title}`} title={`Add ${preset.title}`}
        className={PLUGIN_ACTION}>
        <PlusIcon size={16} />
      </button>
    );
  }

  return (
    <>
    {dialog}
    <PluginRow attributes={{ "data-plugin": preset.title, "data-plugin-source": preset.id, "data-plugin-state": server === undefined ? 'Not added' : mcpServerStatus(server.status).label }}
      title={preset.title} meta={preset.description}
      tile={<BrandMark brand={brand} size={18} />}
      status={server === undefined ? undefined : <ServerStatus status={server.status} />}
      action={trailing}
      below={asking || err !== null ? (
        <div className="space-y-1">
          {asking && (
            <div className="flex items-center gap-2">
              {/* Credential region: the marker keeps the value out of feedback screenshots. */}
              <input {...SECRET_REGION} type="password" autoComplete="off"
                value={token} onChange={(e) => setToken(e.target.value)}
                aria-label={tokenLabel} placeholder={tokenLabel}
                className={inputCls + ' min-w-0 flex-1'} />
              <button
                onClick={() => detach(Effect.promise(async () => { await add({
                  presetId: preset.id,
                  headers: { Authorization: `Bearer ${token}` },
                }); }))}
                disabled={busy || !token.trim()}
                className="text-xs px-2 py-1.5 rounded-md p-accent-bg p-accent font-medium disabled:opacity-50">
                {busy ? 'Connecting…' : 'Connect'}
              </button>
            </div>
          )}
          {err !== null && <p className="p-t-status p-danger">{err}</p>}
        </div>
      ) : undefined}
    />
    </>
  );
}

/** Whether the deployment registered a preset's own app: `undefined` while loading. */
export type PresetAvailability = readonly { id: string; appConfigured: boolean }[] | undefined;

/** The catalog's presets the account can still add: not added yet, and offered (its app, or a token fallback). */
export function addablePresets(servers: readonly McpServerSummary[], availability: PresetAvailability): readonly McpPreset[] {
  return MCP_PRESETS.filter((preset) => {
    if (servers.some((s) => presetOf(s)?.id === preset.id)) return false;

    const appConfigured = availability?.find((a) => a.id === preset.id)?.appConfigured;

    return !(preset.auth === 'oauth-app' && appConfigured === false && preset.tokenFallback === undefined);
  });
}

/** Fragment so the caller owns layout. An unconfigured `oauth-app` preset without a token
 *  fallback appears only once added; while loading it renders as configured. `unadded` draws
 *  only the presets the account can still add (`addablePresets`). */
export function McpPresetCards({ servers, availability, onChanged, unadded = false }: {
  servers: readonly McpServerSummary[];
  availability: PresetAvailability;
  onChanged: () => void;
  unadded?: boolean;
}) {
  const addable = addablePresets(servers, availability);

  return (
    <>
      {MCP_PRESETS.map((preset) => {
        const server = servers.find((s) => presetOf(s)?.id === preset.id);
        const appConfigured = availability?.find((a) => a.id === preset.id)?.appConfigured;

        if (!addable.includes(preset) && (server === undefined || unadded)) return null;

        return (
          <PresetRow key={preset.id} preset={preset} server={server}
            appConfigured={appConfigured} onChanged={onChanged} />
        );
      })}
    </>
  );
}
