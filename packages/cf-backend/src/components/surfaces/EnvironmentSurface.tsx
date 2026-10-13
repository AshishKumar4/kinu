/**
 * Environment: the machines this workspace runs on, as one surface on the column's ground. A row of chips chooses the
 * machine; its head says what it is, its state and its actions; under it, its terminal or, for the computer, its
 * screen, from one hairline to the column's foot. Capability doctrine stays model-facing
 * (core/src/prompting/volatile-context.ts); file browsing lives in Files.
 */
import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useParams } from "react-router-dom";
import {
  ArrowSquareOutIcon, DesktopIcon, DesktopTowerIcon, FolderOpenIcon, GitForkIcon, LockSimpleIcon, PlugIcon, PlusIcon,
  SquaresFourIcon, type Icon,
} from "@phosphor-icons/react";
import { EXECUTOR_MOUNTS, desktopClientUrl, type MountInfo } from "@kinu.run/core";
import type { ExecutorCommandResult, Rpc } from "@kinu.run/core";
import {
  executorLabel, isExecutorActive,
  pickDefaultExecutor,
  type ExecutorInfo,
} from "@kinu.run/core";
import { DESKTOP_SIZE } from "@kinu.run/devbox/desktop";
import type { ExecutorOutput } from "@/hooks/use-chat-owner";
import { lazyRoute } from "@/lazy-route";
import type { TerminalPaneProps } from "@/components/TerminalPane";
import { Loader } from "@cloudflare/kumo";
import { lastValue, useAsyncResource } from "@/hooks/use-async-resource";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { ComputerSize, useComputerSize } from "@/components/SandboxSize";
import { Segmented } from "@/components/ui/Segmented";
import { DesktopScreen } from "./DesktopScreen";

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

/** Each environment's mark, the one the Files drive and the device pages use for the same thing, and what it is. */
const ENVIRONMENTS = {
  workspace: { Icon: SquaresFourIcon, about: "The workspace's own files and shell" },
  device: { Icon: DesktopTowerIcon, about: "Your machine, linked with kinu connect" },
  computer: { Icon: DesktopIcon, about: "Linux in the cloud" },
  parent: { Icon: GitForkIcon, about: "The workspace this one was forked from" },
} satisfies Record<string, { readonly Icon: Icon; readonly about: string }>;

function environmentOf(name: string): { readonly Icon: Icon; readonly about: string } {
  return Object.entries(ENVIRONMENTS).find(([key]) => key === name)?.[1] ?? { Icon: PlugIcon, about: executorLabel(name) };
}

/** A PC that is not connected is an offer to connect one, not an environment. */
const isOfferedPc = (mount: MountInfo): boolean => mount.name === "device" && !mount.live;

/** One status language for every machine: a dot's tone and a word. */
type Tone = "working" | "ready" | "attention" | "off" | "danger";

interface StatusReading { readonly word: string; readonly tone: Tone }

function statusOf(mount: MountInfo, exec: ExecutorInfo | undefined): StatusReading {
  // Reach before liveness, but only for a live row: `granted` is answered only while
  // the machine is connected, so a not-live mount stays offline.
  if (mount.live && mount.name === "device" && exec?.granted === false) return { word: "Needs approval", tone: "attention" };

  if (!mount.live) return { word: mount.name === "computer" ? "Not available" : "Offline", tone: "off" };

  if (exec?.status === "error") return { word: "Error", tone: "danger" };

  if (exec && isExecutorActive(exec)) return { word: "Running", tone: "working" };

  return { word: "Ready", tone: "ready" };
}

function Dot({ tone }: { tone: Tone }) {
  return <span aria-hidden className="p-env-dot" data-tone={tone} />;
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
    <div className="flex h-full flex-col">
      <div role="group" aria-label="Environments" className="flex shrink-0 flex-wrap gap-1.5 px-4 pt-4">
        {environments.map((m) => {
          const exec = execByName.get(m.name);
          const { Icon: KindIcon } = environmentOf(m.name);
          const active = selectedMount?.name === m.name;

          return (
            <div key={m.name} data-env-card={m.name} className="min-w-0">
              <button type="button" data-env-select onClick={() => setSelected(m.name)} aria-pressed={active} className="p-env-chip">
                <KindIcon size={14} weight={active ? "fill" : "regular"} className="shrink-0" aria-hidden />
                <span className="truncate">{exec?.label ?? executorLabel(m.name)}</span>
                <Dot tone={statusOf(m, exec).tone} />
              </button>
            </div>
          );
        })}
        {pcOffered && (
          <button type="button" data-env-connect onClick={onConnectDevice} aria-label="Connect a PC" title="Connect a PC"
            className="p-env-chip border-dashed p-text-3">
            <PlusIcon size={13} className="shrink-0" aria-hidden /><span className="hidden @[30rem]:inline">Connect a PC</span>
          </button>
        )}
        {mounts.length === 0 && loaded !== null && <span className="p-meta p-text-3">No environments available.</span>}
        {mounts.length === 0 && resource.status === "loading" && <Loader size="sm" />}
      </div>
      {resource.status === "error" && (
        <LoadFailure what="the environments" message={resource.message} onRetry={reload} className="mx-4 mt-3 p-card px-3 py-2" />
      )}

      {selectedMount === null ? <div className="min-h-0 flex-1" /> : (
        <SelectedEnvironment
          key={selectedMount.name}
          rpc={rpc}
          mount={selectedMount}
          exec={selectedExec}
          workspace={workspaceName}
          executorOutputs={executorOutputs}
          onExecute={onExecute}
          onOpenFiles={onOpenFiles}
        />
      )}
    </div>
  );
}

type PaneView = "terminal" | "desktop";

const PANE_VIEWS = [{ id: "terminal", label: "Terminal" }, { id: "desktop", label: "Desktop" }] as const;

function SelectedEnvironment({ rpc, mount, exec, workspace, executorOutputs, onExecute, onOpenFiles }: {
  rpc: Rpc;
  mount: MountInfo;
  exec: ExecutorInfo | undefined;
  workspace: string;
  executorOutputs: Map<string, ExecutorOutput[]>;
  onExecute: (id: string, cmd: string) => Promise<ExecutorCommandResult>;
  onOpenFiles: (root: string) => void;
}) {
  const [view, setView] = useState<PaneView>("terminal");
  const computer = mount.name === "computer";
  // The computer's size, read once here: its control sits in the head, its restart covers the view.
  const size = useComputerSize(rpc, computer && mount.live);
  const name = exec?.label ?? executorLabel(mount.name);
  const status = statusOf(mount, exec);
  const filesRoot = filesRootFor(mount.name);
  const { about } = environmentOf(mount.name);
  const usable = mount.live && exec?.granted !== false;
  // Only the computer has a screen.
  const desktop = usable && exec?.name === "computer" ? desktopClientUrl(location, workspace) : null;
  const shown = desktop === null ? "terminal" : view;
  const desktopTitle = `${name}'s desktop`;
  const specs = computer ? size.specs : null;
  const restarting = computer && size.pending === "resize";

  const leading: ReactNode = desktop === null
    ? <span className="p-row-text font-medium p-text">Terminal</span>
    : <Segmented label={`${name}: terminal or desktop`} segments={PANE_VIEWS} value={shown} onChange={setView} />;

  return (
    <section aria-label={name} className="flex min-h-0 flex-1 flex-col">
      <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2.5 px-4 pt-4 pb-1">
        <div className="min-w-[12rem] flex-1">
          <div className="flex min-w-0 items-center gap-2.5">
            <h3 className="p-env-name truncate">{name}</h3>
            <span data-env-status className="p-env-state shrink-0" data-tone={restarting ? "working" : status.tone}>
              <Dot tone={restarting ? "working" : status.tone} />{restarting ? "Restarting" : status.word}
            </span>
            {mount.policy.readOnly && <span title="Read-only" className="flex shrink-0 p-text-3"><LockSimpleIcon size={12} aria-label="Read-only" /></span>}
          </div>
          {mount.live && (
            <p className="p-env-specs mt-0.5 truncate">
              {about}{specs !== null && ` · ${specs}`}{filesRoot !== null && <> · <span data-env-mount className="p-annotation">{filesRoot}</span></>}
            </p>
          )}
        </div>
        {mount.live && (
          <div className="flex shrink-0 items-center gap-1.5">
            {computer && <ComputerSize state={size} />}
            {filesRoot !== null && (
              <button type="button" data-env-files onClick={() => onOpenFiles(filesRoot)} title={`Browse ${name}'s files at ${filesRoot}`} className="p-env-action">
                <FolderOpenIcon size={13} aria-hidden />Files
              </button>
            )}
          </div>
        )}
      </header>
      {computer && size.notice}

      {exec?.granted === false && <NeedsApprovalMount exec={exec} />}
      {exec?.granted !== false && !mount.live && <UnavailableMount mount={mount} exec={exec} />}
      {usable && restarting && (
        <ViewBar leading={leading}>
          <Restarting to={size.restartingTo} />
        </ViewBar>
      )}
      {usable && !restarting && shown === "desktop" && desktop !== null && (
        <ViewBar leading={leading} trailing={
          <a href={`/workspace/${encodeURIComponent(workspace)}/desktop`} target="_blank" rel="noreferrer" data-desktop-open
            aria-label={`Open ${desktopTitle} in a new tab`} className="inline-flex items-center gap-1.5 p-meta p-text-3 hover:p-text">
            <ArrowSquareOutIcon size={13} aria-hidden />New tab
          </a>
        }>
          {/* The screen at its own shape across the column, so the client draws it edge to edge. */}
          <div className="w-full" style={{ aspectRatio: `${String(DESKTOP_SIZE.width)} / ${String(DESKTOP_SIZE.height)}` }}>
            <DesktopScreen src={desktop} title={desktopTitle} />
          </div>
        </ViewBar>
      )}
      {usable && !restarting && shown === "terminal" && (
        <div className="@container min-h-0 flex-1">
          {exec ? (
            <Suspense fallback={<div className="flex h-full items-center justify-center"><Loader size="sm" /></div>}>
              <TerminalPane
                workspace={workspace}
                executor={exec.name}
                outputs={executorOutputs.get(exec.name) ?? []}
                onExecute={(cmd) => onExecute(exec.name, cmd)}
                leading={leading}
              />
            </Suspense>
          ) : (
            <Absence icon={PlugIcon} title="No command lane">This environment runs no commands.</Absence>
          )}
        </div>
      )}
    </section>
  );
}

/** The view's bar, the hairline, and the view on the terminal's ground to the column's foot. */
function ViewBar({ leading, trailing, children }: { leading: ReactNode; trailing?: ReactNode; children: ReactNode }) {
  return (
    <>
      <div className="flex h-11 shrink-0 items-center gap-3 pr-2 pl-4">
        {leading}
        {trailing !== undefined && <span className="ml-auto flex items-center gap-3">{trailing}</span>}
      </div>
      <div className="p-terminal-ground flex min-h-0 flex-1 flex-col border-t p-border">{children}</div>
    </>
  );
}

/** A resize restarts the container: files and supervised services come back, a shell does not (D50; staging 2026-10-13). */
function Restarting({ to }: { to: string | null }) {
  return (
    <div role="status" className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center">
      <span className="p-dot-pulse"><DesktopIcon size={24} className="p-accent" aria-hidden /></span>
      <div className="space-y-1">
        <p className="p-row-text font-semibold p-text">{to === null ? "Restarting" : `Restarting at ${to}`}</p>
        <p className="p-meta p-text-3">Your files stay and services start again; open terminals start fresh.</p>
      </div>
    </div>
  );
}

/** The chosen environment's absence, said in its place: the reason, and where to read more. */
function Absence({ icon: Mark, title, children }: { icon: Icon; title: string; children: ReactNode }) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center border-t p-border px-8">
      <div className="max-w-sm space-y-2 text-center">
        <Mark size={22} className="mx-auto p-text-3" aria-hidden />
        <p className="p-row-text font-semibold p-text">{title}</p>
        <p className="p-meta p-text-2">{children}</p>
      </div>
    </div>
  );
}

const EXECUTION_DOCS = "https://github.com/AshishKumar4/kinu/blob/main/docs/EXECUTION-LAYER-SPEC.md";

function UnavailableMount({ mount, exec }: { mount: MountInfo; exec: ExecutorInfo | undefined }) {
  const text = mount.name === "computer"
    ? "This deployment has no computer. Use the Workspace shell instead."
    : mount.reason ?? exec?.reason ?? "This environment is not enabled here.";

  return (
    <Absence icon={PlugIcon} title={`${executorLabel(mount.name)} is not available here`}>
      {text}{" "}<a href={EXECUTION_DOCS} target="_blank" rel="noreferrer" className="p-accent hover:underline">Learn more</a>
    </Absence>
  );
}

/** Online machine without workspace access; only the owner can approve it. */
function NeedsApprovalMount({ exec }: { exec: ExecutorInfo }) {
  const name = exec.label ?? executorLabel(exec.name);

  return (
    <Absence icon={LockSimpleIcon} title={`${name} needs approval`}>
      It is connected. When this workspace runs its first command on it, you choose whether to grant access.
    </Absence>
  );
}
