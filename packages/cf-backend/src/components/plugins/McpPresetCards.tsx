/** One-click MCP preset rows; a row's state is the account's server row tagged with its `preset_id`. */
import { Effect } from 'effect';
import { useCallback, useMemo, useState, type ReactNode } from "react";
import {
  ArrowClockwiseIcon, ArrowSquareOutIcon, PlusIcon, SignInIcon, TrashIcon, XIcon,
} from "@phosphor-icons/react";
import {
  GOOGLE_CONNECTION, MCP_PRESETS, mcpPresetById, type ConnectEnded, type McpPreset, type McpPresetId, type McpServerSummary,
} from "@kinu.run/core";
import { addMcpServer, reconnectSaying, removeMcpServer, type McpServerInput } from "@/lib/user-api";
import { beginConnect, signInMcpServer, type ConnectRun } from "@/lib/connect-window";
import { useConfirmation } from "@/components/ui/ConfirmDialog";
import { SECRET_REGION } from "@/components/ui/SecretValue";
import { BrandMark, type BrandName } from "@/components/ui/BrandMark";
import { Row, RowAction } from "@/components/ui/Row";
import { Status } from "@/components/ui/Status";
import { Menu, type MenuItem } from "@/components/ui/Menu";
import { mcpServerStatus, NOT_ADDED, type PluginStatus } from "@/components/plugins/mcp-status";
import { renderThrownChain, detach } from "@kinu.run/core/obs";
import { TextInput } from "@/components/ui/Field";
import { Button } from "@/components/ui/Button";

const PRESET_MARK: Record<McpPresetId, BrandName> = {
  github: "github",
  cloudflare: "cloudflare",
};

/** A connection a blueprint names: a preset's id, which the catalog resolves (`preset_id` is any string on the wire), or
 *  the Google connection. */
export function presetBrand(connection: string | null): BrandName | undefined {
  if (connection === GOOGLE_CONNECTION) return "google";
  const preset = connection === null ? undefined : mcpPresetById(connection);

  return preset === undefined ? undefined : PRESET_MARK[preset.id];
}

/** What a blueprint's connection is called: its preset's title, or Google; a name nothing resolves, as it is. */
export function connectionTitle(connection: string): string {
  return connection === GOOGLE_CONNECTION ? "Google" : (mcpPresetById(connection)?.title ?? connection);
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

/** A held connection's status: the plain `Status` its tone and words name, as every view reads them. */
export function PluginStatusText({ shown }: { shown: PluginStatus }) {
  return <Status tone={shown.tone}>{shown.label}</Status>;
}

/** An added server's menu: a sign-in while it asks for one, Reconnect once it failed without, its docs, and removal. */
function ConnectedMenu({ server, title, docsUrl, signInAgain, reconnect, remove }: {
  server: McpServerSummary;
  title: string;
  docsUrl: string;
  signInAgain: () => void;
  reconnect: () => void;
  remove: () => void;
}) {
  const signInItem: readonly MenuItem[] = server.signIn ? [{ label: "Sign in", icon: <SignInIcon size={16} />, onSelect: signInAgain, marker: "data-plugin-sign-in" }] : [];

  // A failed connection that needs no sign-in is dialled again on the person's ask.
  const reconnectItem: readonly MenuItem[] = server.status === "failed" && !server.signIn
    ? [{ label: "Reconnect", icon: <ArrowClockwiseIcon size={16} />, onSelect: reconnect, marker: "data-plugin-reconnect" }] : [];

  return (
    <Menu name={title} items={[
      ...signInItem,
      ...reconnectItem,
      { label: "Docs", icon: <ArrowSquareOutIcon size={16} />, onSelect: () => { window.open(docsUrl, "_blank", "noopener,noreferrer"); } },
      { label: "Remove", icon: <TrashIcon size={16} />, onSelect: remove, danger: true },
    ]} />
  );
}

/** Each row's last failure, by its connection (a preset's id, or `GOOGLE_CONNECTION`), held above the rows: on Plugins a
 *  row moves between Add and Connected as it is added or removed, a new row in another list, and the failure its sign-in
 *  or removal ends with must still show on it. */
export interface RowErrors {
  readonly of: (connection: string) => string | null;
  readonly set: (connection: string, error: string | null) => void;
}

export function useRowErrors(): RowErrors {
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(new Map());

  return useMemo(() => ({
    of: (id) => errors.get(id) ?? null,
    set: (id, error) => setErrors((all) => {
      const next = new Map(all);

      if (error === null) next.delete(id);
      else next.set(id, error);

      return next;
    }),
  }), [errors]);
}

export function PresetRow({ preset, server, appConfigured, onChanged, onConnected, errors }: {
  preset: McpPreset;
  server: McpServerSummary | undefined;
  /** `undefined` while loading, treated as configured so a row never flickers to its fallback. */
  appConfigured: boolean | undefined;
  onChanged: () => void;
  /** Hears how a sign-in ended, beside the reread `onChanged` runs. */
  onConnected?: (ended: ConnectEnded) => void;
  /** Where the rows keep their failures, when a row moves between lists; else the row keeps its own. */
  errors?: RowErrors;
}) {
  const [openToken, setOpenToken] = useState(false);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [own, setOwn] = useState<string | null>(null);
  const err = errors === undefined ? own : errors.of(preset.id);
  const setErr = (error: string | null) => { if (errors === undefined) setOwn(error); else errors.set(preset.id, error); };

  // A sign-in's end: the list read again, and its outcome kept on this row, its finish page having closed with the only
  // copy of a failure. A later success clears an earlier failure.
  const ended = (end: ConnectEnded) => {
    onChanged();
    onConnected?.(end);
    setErr(end.error === null ? null : `${end.service} did not connect: ${end.error}`);
  };

  const brand = PRESET_MARK[preset.id];
  const added = server !== undefined;

  // Whether adding it signs in, from its kind and the deployment's app: for a row not yet added. 'oauth' always signs
  // in; 'oauth-app' only with the deployment's registration, else token fallback. An added one's own state says whether
  // it offers a sign-in (`server.signIn`).
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

  // An added server offers its sign-in where the account says it does (`server.signIn`): begun again for a run of its
  // own, in a tab opened now. An earlier failure stays until a sign-in connects (`ended`), not while one is pending.
  const signInAgain = useCallback(() => detach(Effect.promise(async () => {
    if (server === undefined) return;

    const failed = await signInMcpServer(beginConnect(), server.id, ended);

    if (failed !== null) setErr(failed);
  })), [server, ended]);

  const { ask, dialog } = useConfirmation();

  const reconnect = useCallback(() => detach(Effect.promise(async () => {
    if (server === undefined) return;
    setErr(await reconnectSaying(server.id, preset.title));
    onChanged();
  })), [server, preset.title, onChanged]);

  const remove = () => {
    if (!server) return;
    ask({
      title: `Remove "${server.name}"?`, body: "All workspaces will lose access to its tools.", action: "Remove", failed: "Could not remove it",
      run: async () => { await removeMcpServer(server.id); onChanged(); },
    });
  };

  const asking = openToken && !added;
  const shown = server === undefined ? undefined : mcpServerStatus(server.status);

  let trailing: ReactNode;

  if (server !== undefined) {
    trailing = <ConnectedMenu server={server} title={preset.title} docsUrl={preset.docsUrl} signInAgain={signInAgain} reconnect={reconnect} remove={remove} />;
  } else if (asking) {
    trailing = (
      <RowAction data-plugin-cancel onClick={() => setOpenToken(false)} aria-label={`Cancel ${preset.title}`} title="Cancel">
        <XIcon size={14} />
      </RowAction>
    );
  } else {
    trailing = (
      <RowAction data-plugin-add onClick={(...args: Parameters<typeof connect>) => detach(Effect.promise(async () => connect(...args)))} disabled={busy}
        aria-label={`Add ${preset.title}`} title={`Add ${preset.title}`}>
        <PlusIcon size={16} />
      </RowAction>
    );
  }

  return (
    <>
    {dialog}
    <Row attributes={{ "data-plugin": preset.title, "data-plugin-source": preset.id, "data-plugin-state": shown?.label ?? NOT_ADDED }}
      title={preset.title} meta={preset.description}
      tile={<BrandMark brand={brand} size={18} />}
      status={shown === undefined ? undefined : <PluginStatusText shown={shown} />}
      action={trailing}
      below={asking || err !== null || server?.error ? (
        <div className="space-y-1">
          {asking && (
            <div className="flex items-center gap-2">
              {/* Credential region: the marker keeps the value out of feedback screenshots. */}
              <TextInput className="min-w-0 flex-1" {...SECRET_REGION} type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} aria-label={tokenLabel} placeholder={tokenLabel} />
              <Button variant="secondary" size="sm" onClick={() => detach(Effect.promise(async () => { await add({
                  presetId: preset.id,
                  headers: { Authorization: `Bearer ${token}` },
                }); }))} disabled={busy || !token.trim()}>
                {busy ? 'Connecting…' : 'Connect'}
              </Button>
            </div>
          )}
          {err !== null && <p className="t-status p-danger" data-plugin-error>{err}</p>}
          {err === null && server?.error && <p className="t-status p-danger" data-plugin-error>{server.error}</p>}
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
export function McpPresetCards({ servers, availability, onChanged, onConnected, errors, unadded = false }: {
  servers: readonly McpServerSummary[];
  availability: PresetAvailability;
  onChanged: () => void;
  /** Hears how a preset's sign-in ended, beside the reread `onChanged` runs. */
  onConnected?: (ended: ConnectEnded) => void;
  errors?: RowErrors;
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
            appConfigured={appConfigured} onChanged={onChanged} onConnected={onConnected} errors={errors} />
        );
      })}
    </>
  );
}
