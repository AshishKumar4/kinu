/** One-click MCP preset rows; a row's state is the account's server row tagged with its `preset_id`. */
import { Effect } from 'effect';
import { useCallback, useRef, useState, type ReactNode } from "react";
import { useCloseOnOutsideClick } from "@/hooks/use-close-on-outside-click";
import {
  ArrowSquareOutIcon, CaretDownIcon, PlusIcon, SignInIcon, TrashIcon, XIcon,
} from "@phosphor-icons/react";
import {
  MCP_PRESETS, mcpPresetById, type ConnectEnded, type McpPreset, type McpPresetId, type McpServerSummary,
} from "@kinu.run/core";
import { addMcpServer, removeMcpServer, type McpServerInput } from "@/lib/user-api";
import { beginConnect, signInMcpServer, type ConnectRun } from "@/lib/connect-window";
import { inputCls } from "@/components/ui/form";
import { useConfirmation } from "@/components/ui/ConfirmDialog";
import { SECRET_REGION } from "@/components/ui/SecretValue";
import { BrandMark, type BrandName } from "@/components/ui/BrandMark";
import { PluginRow, PLUGIN_ACTION } from "@/components/plugins/PluginRow";
import { StatusDot } from "@/components/ui/Status";
import { mcpServerStatus } from "@/components/plugins/mcp-status";
import { renderThrownChain, detach } from "@kinu.run/core/obs";

/** The preset's own action, shaped as a status pill so it sits where a connected server's status does. */
const PRESET_PILL = "flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 p-t-status p-text-3";

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

/** A preset card's own words for a server's state; the tone is every view's (`mcpServerStatus`). */
function PresetMenu({ preset, status, onSignIn, onRemove }: {
  preset: McpPreset;
  status: McpServerSummary['status'];
  /** Present while the server waits for its sign-in: runs it again, as Add did. */
  onSignIn: (() => Promise<void>) | null;
  onRemove: () => void;
}) {
  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useCloseOnOutsideClick(open, menu, close);

  const item = "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-sm p-card-hover";

  return (
    <div ref={menu} className="relative shrink-0">
      <button type="button" data-plugin-menu aria-haspopup="menu" aria-expanded={open}
        aria-label={`${preset.title} options`} onClick={() => setOpen((value) => !value)}
        className={`${PRESET_PILL} transition-colors hover:bg-[var(--c-elevated)] hover:p-text`}>
        <StatusDot tone={mcpServerStatus(status).tone} />
        {mcpServerStatus(status).label}
        <CaretDownIcon size={9} />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-10 mt-1 w-40 p-card border p-border p-1.5 p-shadow-menu">
          {onSignIn !== null && (
            <button type="button" role="menuitem" data-plugin-sign-in className={item}
              onClick={() => { setOpen(false); detach(Effect.promise(onSignIn)); }}>
              <SignInIcon size={14} /> Sign in
            </button>
          )}
          <a role="menuitem" href={preset.docsUrl} target="_blank" rel="noopener noreferrer"
            className={item} onClick={() => setOpen(false)}>
            <ArrowSquareOutIcon size={14} /> Docs
          </a>
          <button type="button" role="menuitem" className={`${item} hover:p-danger`}
            onClick={() => { setOpen(false); onRemove(); }}>
            <TrashIcon size={14} /> Remove
          </button>
        </div>
      )}
    </div>
  );
}

function PresetRow({ preset, server, appConfigured, onChanged, onConnected }: {
  preset: McpPreset;
  server: McpServerSummary | undefined;
  /** `undefined` while loading, treated as configured so a row never flickers to its fallback. */
  appConfigured: boolean | undefined;
  onChanged: () => void;
  onConnected?: (ended: ConnectEnded) => void;
}) {
  const [openToken, setOpenToken] = useState(false);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // A sign-in's end: the list read again, and a failure kept on this row, its finish page having closed with the only copy.
  const ended = (end: ConnectEnded) => {
    onChanged();
    onConnected?.(end);

    if (end.error !== null) setErr(`${end.service} did not connect: ${end.error}`);
  };

  const brand = PRESET_MARK[preset.id];
  const added = server !== undefined;

  // 'oauth' always signs in; 'oauth-app' only with the deployment's registration, else token fallback.
  const signIn = preset.auth === 'oauth' || (preset.auth === 'oauth-app' && appConfigured !== false);

  const tokenLabel = preset.auth === 'oauth-app'
    ? preset.tokenFallback?.label ?? 'Access token'
    : preset.tokenLabel ?? 'Access token';

  /** `connect` is the sign-in begun at the click, before the add's await, for a preset that signs in. */
  const add = async (input: McpServerInput, connect?: ConnectRun) => {
    setErr(null);
    setBusy(true);

    try {
      const result = await addMcpServer(input);

      if (result.authUrl && connect !== undefined) {
        const failed = await signInMcpServer(connect, result.id, ended);

        if (failed !== null) setErr(failed);
      } else {
        connect?.cancel();
      }

      setOpenToken(false);
      setToken('');
      onChanged();
    } catch (e) {
      connect?.cancel();
      setErr(renderThrownChain({ cause: e }));
    } finally {
      setBusy(false);
    }
  };

  const connect = async (): Promise<void> => {
    if (signIn) {
      await add({ presetId: preset.id }, beginConnect());
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
    // A preset that signs in and is not connected keeps the way to its sign-in: begun again for a run of its own, in a
    // tab opened now, whether its last one waits, was declined or failed.
    const signInAgain = !signIn || server.status === 'ready' ? null : async () => {
      const failed = await signInMcpServer(beginConnect(), server.id, ended);

      if (failed !== null) setErr(failed);
    };

    trailing = <PresetMenu preset={preset} status={server.status} onSignIn={signInAgain} onRemove={remove} />;
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
    <PluginRow source={preset.id} state={server === undefined ? 'Not added' : mcpServerStatus(server.status).label}
      name={preset.title} description={preset.description}
      tile={<BrandMark brand={brand} size={22} />}
      trailing={trailing}
      below={asking || err !== null ? (
        <div className="mt-2 space-y-1 pl-[52px]">
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
          {err !== null && <p className="p-t-status p-danger" data-plugin-error>{err}</p>}
        </div>
      ) : undefined}
    />
    </>
  );
}

/** Fragment so the caller owns layout. An unconfigured `oauth-app` preset without a token
 *  fallback appears only once added; while loading it renders as configured. */
export function McpPresetCards({ servers, availability, onChanged, onConnected }: {
  servers: readonly McpServerSummary[];
  availability: readonly { id: string; appConfigured: boolean }[] | undefined;
  onChanged: () => void;
  /** Hears how a preset's sign-in ended, beside the reread `onChanged` runs. */
  onConnected?: (ended: ConnectEnded) => void;
}) {
  return (
    <>
      {MCP_PRESETS.map((preset) => {
        const server = servers.find((s) => s.presetId === preset.id);
        const appConfigured = availability?.find((a) => a.id === preset.id)?.appConfigured;

        if (preset.auth === 'oauth-app' && appConfigured === false
          && preset.tokenFallback === undefined && server === undefined) {
          return null;
        }

        return (
          <PresetRow key={preset.id} preset={preset} server={server}
            appConfigured={appConfigured} onChanged={onChanged} onConnected={onConnected} />
        );
      })}
    </>
  );
}
