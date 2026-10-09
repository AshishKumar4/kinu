/**
 * Environment: one card per environment with the selected terminal below. Capability
 * doctrine stays model-facing (core/src/prompting/volatile-context.ts); file browsing lives in Files.
 */
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import {
  ArrowSquareOutIcon, CircleIcon, DesktopIcon, DesktopTowerIcon, FolderOpenIcon, GitForkIcon, LockSimpleIcon, PlugIcon, SquaresFourIcon,
  type Icon,
} from "@phosphor-icons/react";
import { EXECUTOR_MOUNTS, desktopClientUrl, type MountInfo } from "@kinu.run/core";
import type { ExecutorCommandResult, Rpc } from "@kinu.run/core";
import {
  executorLabel, isExecutorActive,
  pickDefaultExecutor,
  type ExecutorInfo,
} from "@kinu.run/core";
import type { ExecutorOutput } from "@/hooks/use-kinu";
import { lazyRoute } from "@/lazy-route";
import type { TerminalPaneProps } from "@/components/TerminalPane";
import { Loader } from "@cloudflare/kumo";
import { lastValue, useAsyncResource } from "@/hooks/use-async-resource";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { SandboxSizeRow } from "@/components/SandboxSize";
import { Segmented } from "@/components/ui/Segmented";

/** The terminal (xterm, 333 KB of the workspace's first chunk on 2026-10-08) loads with a command lane's first view. */
const TerminalPane = lazyRoute<TerminalPaneProps>(async () => {
  const { TerminalPane: pane } = await import("@/components/TerminalPane");

  return { default: pane };
});

export interface EnvironmentSurfaceProps {
  rpc: Rpc;
  executors: ExecutorInfo[];
  executorOutputs: Map<string, ExecutorOutput[]>;
  lastActiveExecutor?: string | null;
  onExecute: (id: string, cmd: string) => Promise<ExecutorCommandResult>;
  onOpenFiles: (root: string) => void;
  /** Owned by the work surface, so the Files drive's offline row opens the same panel. */
  onConnectDevice: () => void;
}

/** Null for an environment the drive does not mount (a fork's parent). */
function filesRootFor(name: string): string | null {
  if (name === "workspace") return "/";
  const prefixes: Record<string, string | undefined> = EXECUTOR_MOUNTS;

  return prefixes[name] ?? null;
}

/** Each environment's mark, the one the Files drive and the device pages use for the same thing. */
const ENVIRONMENT_ICONS = {
  workspace: SquaresFourIcon,
  device: DesktopTowerIcon,
  sandbox: DesktopIcon,
  parent: GitForkIcon,
} satisfies Record<string, Icon>;

function environmentIcon(name: string): Icon {
  return Object.entries(ENVIRONMENT_ICONS).find(([key]) => key === name)?.[1] ?? PlugIcon;
}

/** A PC that is not connected is an offer to connect one, not an environment. */
const isOfferedPc = (mount: MountInfo): boolean => mount.name === "device" && !mount.live;

type StatusReading = { word: string; dotClass: string };

function statusOf(mount: MountInfo, exec: ExecutorInfo | undefined): StatusReading {
  // Reach before liveness, but only for a live row: `granted` is answered only while
  // the machine is connected, so a not-live mount stays offline.
  if (mount.live && mount.name === "device" && exec?.granted === false) {
    return { word: "needs approval", dotClass: "p-info" };
  }

  if (!mount.live) return { word: "offline", dotClass: "p-text-3" };

  if (exec?.status === "error") return { word: "error", dotClass: "p-danger" };

  if (exec && isExecutorActive(exec)) return { word: "active", dotClass: "p-success" };

  if (exec?.status === "idle" || exec?.configured) return { word: "idle", dotClass: "p-info" };

  return { word: "live", dotClass: "p-success" };
}

export function EnvironmentSurface(props: EnvironmentSurfaceProps) {
  const { rpc, executors, executorOutputs, lastActiveExecutor, onExecute, onOpenFiles, onConnectDevice } = props;
  const [selected, setSelected] = useState<string | null>(null);
  // The terminal socket is addressed by workspace name.
  const workspaceName = useParams().agentId ?? "";

  const load = useCallback(() => rpc<MountInfo[]>("listMounts"), [rpc]);
  const { resource, reload } = useAsyncResource(load);
  // Empty and unread must stay distinct.
  const loaded = lastValue(resource);
  const mounts = loaded ?? [];

  // When executor availability flips, the rows' live flags are stale; refetch.
  const availabilitySignature = executors.map((e) => `${e.name}:${e.available}:${e.status ?? ""}`).join("|");
  const lastSignature = useRef(availabilitySignature);
  useEffect(() => {
    if (lastSignature.current === availabilitySignature) return;
    lastSignature.current = availabilitySignature;
    reload();
  }, [availabilitySignature, reload]);

  const execByName = useMemo(() => new Map(executors.map((e) => [e.name, e])), [executors]);
  const environments = useMemo(() => mounts.filter((m) => !isOfferedPc(m)), [mounts]);
  const pcOffered = mounts.some(isOfferedPc);

  // Default selection: the environment the agent last worked in.
  const defaultMount = useMemo(() => {
    const preferred = pickDefaultExecutor(executors, lastActiveExecutor);
    const match = environments.find((m) => m.name === preferred);

    return match ?? environments.find((m) => m.live) ?? environments[0] ?? null;
  }, [executors, lastActiveExecutor, environments]);

  const selectedMount = environments.find((m) => m.name === selected) ?? defaultMount;
  const selectedExec = selectedMount ? execByName.get(selectedMount.name) : undefined;

  return (
    <div className="flex flex-col h-full -m-5">
      <div className="px-4 pt-3 pb-3 space-y-3 shrink-0 border-b p-border">
        {resource.status === "error" && (
          <LoadFailure what="the environments" message={resource.message} onRetry={reload} className="p-card px-3 py-2" />
        )}

        <section aria-label="Environments">
          <div className="flex items-center gap-2 mb-2">
            <span className="p-label">Environments</span>
          </div>
          {/* A track of minmax(0, 1fr) at every width: an implicit one sized to the widest card's content, its size choice
              the widest, and pushed every card past the panel (staging, 2026-10-08). */}
          <div className="grid grid-cols-1 items-start gap-2 @[38rem]:grid-cols-2 @[64rem]:grid-cols-3">
            {environments.map((m) => (
              <EnvironmentCard
                key={m.name}
                rpc={rpc}
                mount={m}
                exec={execByName.get(m.name)}
                active={selectedMount?.name === m.name}
                onSelect={() => setSelected(m.name)}
                onOpenFiles={onOpenFiles}
              />
            ))}
            {mounts.length === 0 && loaded !== null && <span className="text-xs p-text-3">No environments available.</span>}
            {mounts.length === 0 && resource.status === "loading" && <span className="text-xs p-text-3">loading…</span>}
          </div>
          {pcOffered && <ConnectPcOffer onConnectDevice={onConnectDevice} />}
        </section>
      </div>

      <SelectedEnvironmentPane
        mount={selectedMount}
        exec={selectedExec}
        workspace={workspaceName}
        executorOutputs={executorOutputs}
        onExecute={onExecute}
      />
    </div>
  );
}

type PaneView = "terminal" | "desktop";

const PANE_VIEWS = [{ id: "terminal", label: "Terminal" }, { id: "desktop", label: "Desktop" }] as const;

function SelectedEnvironmentPane({ mount, exec, workspace, executorOutputs, onExecute }: {
  mount: MountInfo | null;
  exec: ExecutorInfo | undefined;
  workspace: string;
  executorOutputs: Map<string, ExecutorOutput[]>;
  onExecute: (id: string, cmd: string) => Promise<ExecutorCommandResult>;
}) {
  const [view, setView] = useState<PaneView>("terminal");

  if (mount === null) return <div className="flex-1 min-h-0" />;

  if (exec?.granted === false) {
    return (
      <div className="flex-1 min-h-0">
        <NeedsApprovalMount exec={exec} />
      </div>
    );
  }

  if (!mount.live) {
    return (
      <div className="flex-1 min-h-0">
        <UnavailableMount mount={mount} exec={exec} />
      </div>
    );
  }

  const name = exec?.label ?? executorLabel(mount.name);
  const KindIcon = environmentIcon(mount.name);
  // Only the computer has a screen.
  const desktop = exec?.name === "sandbox" ? desktopClientUrl(location, workspace) : null;
  const shown = desktop === null ? "terminal" : view;

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-1.5 px-3 pt-2.5 pb-3">
      <div className="flex items-center gap-2 min-w-0 shrink-0 min-h-8">
        <KindIcon size={14} className="shrink-0 p-text-3" aria-hidden />
        <span className="p-row-text font-medium p-text truncate">{name}</span>
        {desktop !== null && (
          <div className="ml-auto flex shrink-0 items-center gap-1.5">
            {shown === "desktop" && (
              <a href={desktop} target="_blank" rel="noreferrer" data-desktop-open aria-label={`Open ${name}'s desktop in a new tab`}
                title="Open in a new tab"
                className="inline-flex size-7 items-center justify-center rounded-md p-text-3 hover:p-text hover:p-fill">
                <ArrowSquareOutIcon size={14} />
              </a>
            )}
            <Segmented label={`${name}: terminal or desktop`} segments={PANE_VIEWS} value={shown} onChange={setView} />
          </div>
        )}
      </div>
      <div className="flex-1 min-h-0">
        {shown === "desktop" && desktop !== null && (
          // Framed as the terminal is: the remote screen scales into a bordered well, never bleeding to the panel's edge.
          <div data-desktop-frame className="h-full rounded-lg border p-border overflow-hidden bg-black">
            <iframe data-desktop title={`${name}'s desktop`} src={desktop} className="block w-full h-full border-0" />
          </div>
        )}
        {shown === "terminal" && (exec ? (
          <Suspense fallback={<div className="h-full flex items-center justify-center"><Loader size="sm" /></div>}>
            <TerminalPane
              workspace={workspace}
              executor={exec.name}
              outputs={executorOutputs.get(exec.name) ?? []}
              onExecute={(cmd) => onExecute(exec.name, cmd)}
            />
          </Suspense>
        ) : (
          <div className="h-full flex items-center justify-center text-xs p-text-3">
            This environment has no command lane.
          </div>
        ))}
      </div>
    </div>
  );
}

function EnvironmentCard({ rpc, mount, exec, active, onSelect, onOpenFiles }: {
  rpc: Rpc;
  mount: MountInfo;
  exec: ExecutorInfo | undefined;
  active: boolean;
  onSelect: () => void;
  onOpenFiles: (root: string) => void;
}) {
  const executor = mount.name;
  const status = statusOf(mount, exec);
  const filesRoot = filesRootFor(executor);
  // Named by the device's label where bound, else the executor kind.
  const title = exec?.label ?? executorLabel(executor);
  const kindTag = exec?.label ? executorLabel(executor) : null;
  const KindIcon = environmentIcon(executor);

  return (
    <div
      data-env-card={mount.name}
      className={`relative p-card min-w-0 rounded-lg px-3 py-2.5 space-y-1 transition-colors border ${
        active ? "border-[rgba(224,164,88,.4)] bg-[rgba(224,164,88,.05)]" : "p-border hover:border-[var(--c-border-strong)]"
      } ${mount.live ? "" : "border-dashed"}`}
    >
      <div className="flex items-center gap-2 min-w-0">
        <KindIcon size={15} className={`shrink-0 ${active ? "p-accent" : "p-text-3"}`} aria-hidden />
        {/* The whole card selects: the name's button stretches over it, and the card's own controls sit above it. */}
        <button
          type="button"
          data-env-select
          onClick={onSelect}
          aria-pressed={active}
          className={`min-w-0 truncate text-left p-row-text font-medium after:absolute after:inset-0 after:rounded-lg focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-[var(--c-accent)] ${
            mount.live ? "p-text" : "p-text-3"
          }`}
        >{title}</button>
        {kindTag !== null && (
          <span className="p-meta p-text-4 shrink-0">{kindTag}</span>
        )}
        {mount.policy.readOnly && (
          <span title="read-only" className="shrink-0 flex"><LockSimpleIcon size={11} className="p-text-3" /></span>
        )}
        <span data-env-status className="ml-auto flex shrink-0 items-center gap-1 p-t-status p-text-3">
          <CircleIcon size={7} weight="fill" className={status.dotClass} aria-hidden />{status.word}
        </span>
      </div>
      <div className="flex items-center gap-2 min-w-0 min-h-6">
        <span data-env-mount className="p-annotation p-text-3 truncate">{filesRoot ?? "no files here"}</span>
        {mount.live && filesRoot !== null && (
          <button
            type="button"
            data-env-files
            onClick={() => onOpenFiles(filesRoot)}
            className="relative ml-auto flex shrink-0 items-center gap-1 px-2 py-0.5 rounded-md p-t-control p-text-2 hover:p-text hover:p-fill"
            title={`Browse ${title}'s files at ${filesRoot}`}
          ><FolderOpenIcon size={12} />Files</button>
        )}
      </div>
      {executor === "sandbox" && <div className="relative pt-1"><SandboxSizeRow rpc={rpc} /></div>}
    </div>
  );
}

function UnavailableMount({ mount, exec }: { mount: MountInfo; exec: ExecutorInfo | undefined }) {
  const docs = mount.name === "sandbox"
      ? { text: "This deployment has no computer. Use the Workspace shell instead.", href: "https://github.com/AshishKumar4/kinu/blob/main/docs/EXECUTION-LAYER-SPEC.md" }
      : { text: mount.reason ?? exec?.reason ?? "This environment is not enabled here.", href: "https://github.com/AshishKumar4/kinu/blob/main/docs/EXECUTION-LAYER-SPEC.md" };

  return (
    <div className="h-full flex items-center justify-center p-6">
      <div className="max-w-md text-center space-y-3">
        <PlugIcon size={28} className="p-text-3 mx-auto" />
        <div className="text-sm font-medium p-text">{executorLabel(mount.name)} is not available here</div>
        <p className="text-xs p-text-2 leading-relaxed">
          {docs.text}{" "}
          <a href={docs.href} target="_blank" rel="noreferrer" className="p-accent hover:underline">Learn more</a>
        </p>
      </div>
    </div>
  );
}

/** Online machine without workspace access; only the owner can approve it. */
function NeedsApprovalMount({ exec }: { exec: ExecutorInfo }) {
  const name = exec.label ?? executorLabel(exec.name);

  return (
    <div className="h-full flex items-center justify-center p-6" data-env-needs-approval>
      <div className="max-w-md text-center space-y-3">
        <LockSimpleIcon size={26} className="p-text-3 mx-auto" />
        <div className="text-sm font-medium p-text">{name} needs approval</div>
        <p className="text-xs p-text-2 leading-relaxed">
          {name} is connected. When this workspace runs its first command on it,
          you choose whether to grant access.
        </p>
      </div>
    </div>
  );
}

/** A PC that is not connected: one quiet line under the environments that offers to connect it. */
function ConnectPcOffer({ onConnectDevice }: { onConnectDevice: () => void }) {
  return (
    <p className="mt-2 flex items-center gap-1.5 p-meta p-text-3">
      <DesktopTowerIcon size={13} className="shrink-0" aria-hidden />
      <span>
        <button type="button" data-env-connect onClick={onConnectDevice} className="p-accent font-medium hover:underline">Connect your PC</button>
        {" "}to run commands and open its files here.
      </span>
    </p>
  );
}
