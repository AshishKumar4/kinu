/**
 * Environment: the machines this workspace runs on, as one surface on the column's ground. A row of chips chooses the
 * machine; its head says what it is, its state and its actions; under it, its terminal or, for the computer, its
 * screen, from one hairline to the column's foot. Capability doctrine stays model-facing
 * (core/src/prompting/volatile-context.ts); file browsing lives in Files.
 */
import { Suspense, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { useParams } from "react-router-dom";
import {
  ArrowsInIcon, ArrowsOutIcon, DesktopIcon, DesktopTowerIcon, FolderOpenIcon, GitForkIcon, LockSimpleIcon, PlugIcon, PlusIcon,
  SplitHorizontalIcon, SquaresFourIcon, XIcon, type Icon,
} from "@phosphor-icons/react";
import { EXECUTOR_MOUNTS, desktopClientUrl, type MountInfo } from "@kinu.run/core";
import type { ExecutorCommandResult } from "@kinu.run/core";
import {
  executorLabel,
  pickDefaultExecutor,
  type ExecutorInfo,
} from "@kinu.run/core";
import { DESKTOP_SIZE } from "@kinu.run/devbox/desktop";
import type { ExecutorOutput } from "@/hooks/use-chat-owner";
import { lazyRoute } from "@/lazy-route";
import type { TerminalPaneProps } from "@/components/TerminalPane";
import { Loader } from "@cloudflare/kumo";
import { lastValue } from "@/hooks/use-async-resource";
import { useMounts } from "@/hooks/use-mounts";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { ComputerSize, useComputerSize, type ComputerSizeState } from "@/components/SandboxSize";
import { Effect } from "effect";
import type { TerminalSession } from "@kinu.run/devbox";
import { useWorkspaceArea, type WorkspaceArea } from "@/components/layout";
import { DesktopScreen } from "./DesktopScreen";
import { useAccountMachines, type AccountMachine } from "./EnvironmentMachines";
import { FilledButton } from "@/components/ui/FilledButton";
import { detach, renderThrownChain, type KinuError } from "@kinu.run/core/obs";
import {
  AgentMark, NewSessionRow, ONE_SHELL, SessionDetails, SessionTabs, openSession, sessionTone, since, useComputerSessions, type ComputerSessions,
  type SessionTone,
} from "./EnvironmentSessions";
import type { WorkspaceRpc } from "@/lib/workspace-rpc";

/** The terminal (xterm, 333 KB of the workspace's first chunk on 2026-10-08) loads with a command lane's first view. */
const TerminalPane = lazyRoute<TerminalPaneProps>(async () => {
  const { TerminalPane: pane } = await import("@/components/TerminalPane");

  return { default: pane };
});

export interface EnvironmentSurfaceProps {
  rpc: WorkspaceRpc;
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

/**
 * One machine the column lists. A PC is listed per machine on the owner's account, connected or not and granted to
 * this workspace or not: production f9c17ac7b listed the PC executor alone, and a PC connected but not yet granted
 * read as no PC at all, an offer to connect one (the owner, 2026-10-14).
 */
interface Machine {
  readonly key: string;
  readonly mount: MountInfo;
  /** The account's machine, for a PC; null for the workspace, the computer and the rest. */
  readonly device: AccountMachine | null;
}

/**
 * The workspace's mounts, with the PC executor's one row made one row per machine on the account. A PC is live when the
 * account says it is connected and held here: the executor's own reading follows a grant only after the hub's next
 * status push, and the terminal and every command check the grant themselves.
 */
function machinesOf(mounts: readonly MountInfo[], account: readonly AccountMachine[] | null): Machine[] {
  const pc = mounts.find((mount) => mount.name === "device");

  return [
    ...mounts.filter((mount) => mount.name !== "device").map((mount) => ({ key: mount.name, mount, device: null })),
    ...(account ?? []).map((device) => ({
      key: `device:${device.id}`,
      device,
      mount: {
        name: "device", prefix: "device.*", live: device.connected && device.granted,
        policy: pc?.policy ?? { readOnly: false, consistency: "live-shared" }, reason: pc?.reason ?? null,
      },
    })),
  ];
}

function machineLabel(machine: Machine, exec: ExecutorInfo | undefined): string {
  return machine.device?.label ?? exec?.label ?? executorLabel(machine.mount.name);
}

/** A PC's state is the account's first: offline, or connected without this workspace's grant. */
function machineStatus(machine: Machine, exec: ExecutorInfo | undefined): StatusReading {
  if (machine.device !== null && !machine.device.connected) return { word: "Offline", tone: "off" };

  if (machine.device !== null && !machine.device.granted) return { word: "No access", tone: "attention" };

  return statusOf(machine.mount, exec);
}

/** One status language for every machine: a dot's tone and a word. */
type Tone = "working" | "ready" | "attention" | "off" | "danger";

interface StatusReading { readonly word: string; readonly tone: Tone }

/** A machine's state: ready to run commands, or why not. "Running" is a command's word, not a machine's. */
function statusOf(mount: MountInfo, exec: ExecutorInfo | undefined): StatusReading {
  // Reach before liveness, but only for a live row: `granted` is answered only while
  // the machine is connected, so a not-live mount stays offline.
  if (mount.live && mount.name === "device" && exec?.granted === false) return { word: "Needs approval", tone: "attention" };

  if (!mount.live) return { word: mount.name === "computer" ? "Not available" : "Offline", tone: "off" };

  if (exec?.status === "error") return { word: "Error", tone: "danger" };

  return { word: "Ready", tone: "ready" };
}

/**
 * The computer's state: restarting under a resize, waiting on a session's prompt, asleep while stopped (it wakes when
 * used), else as any machine. A session open on it says it woke since its size was read.
 */
function computerStatus(mount: MountInfo, exec: ExecutorInfo | undefined, size: ComputerSizeState, seen: { waiting: boolean; awake: boolean }): StatusReading {
  if (size.pending === "resize") return { word: "Restarting", tone: "working" };

  if (seen.waiting) return { word: "Needs input", tone: "attention" };

  if (mount.live && size.state !== null && size.state.running === null && !seen.awake) return { word: "Asleep", tone: "off" };

  return statusOf(mount, exec);
}

function Dot({ tone }: { tone: Tone }) {
  return <span aria-hidden className="p-env-dot" data-tone={tone} />;
}

export function EnvironmentSurface(props: EnvironmentSurfaceProps) {
  const { rpc, executors, executorOutputs, lastActiveExecutor, onExecute, onOpenFiles, onConnectDevice } = props;
  const [selected, setSelected] = useState<string | null>(null);
  // Each machine's open tab: a session's id, the desktop, or its one shell.
  const [tabs, setTabs] = useState<Readonly<Record<string, string>>>({});
  const [split, setSplit] = useState<string | null>(null);
  // The terminal socket is addressed by workspace name.
  const workspaceName = useParams().agentId ?? "";
  const frame = useRef<HTMLDivElement>(null);
  const wide = useWideColumn(frame);

  const { resource, reload } = useMounts(rpc, executors);
  // Empty and unread must stay distinct.
  const loaded = lastValue(resource);
  const mounts = loaded ?? [];

  const execByName = useMemo(() => new Map(executors.map((e) => [e.name, e])), [executors]);
  const account = useAccountMachines(workspaceName);
  const environments = useMemo(() => machinesOf(mounts, account.machines), [mounts, account.machines]);

  // Default selection: the environment the agent last worked in.
  const defaultMachine = useMemo(() => {
    const preferred = pickDefaultExecutor(executors, lastActiveExecutor);
    const match = environments.find((m) => m.mount.name === preferred && m.mount.live);

    return match ?? environments.find((m) => m.mount.live) ?? environments[0] ?? null;
  }, [executors, lastActiveExecutor, environments]);

  const selectedMachine = environments.find((m) => m.key === selected) ?? defaultMachine;
  const computerLive = environments.some((m) => m.key === "computer" && m.mount.live);
  // The computer's sessions are read while they are on screen: its tabs, or the wide column's list.
  const sessions = useComputerSessions(rpc, computerLive && (wide || selectedMachine?.key === "computer"));
  const waiting = new Set(sessions.sessions?.some((session) => session.needsInput) === true ? ["computer"] : []);

  const choose = (machine: string, tab?: string) => {
    setSelected(machine);

    if (tab !== undefined) setTabs((was) => ({ ...was, [machine]: tab }));

    if (machine !== selectedMachine?.key) setSplit(null);
  };

  const shown: Shown = {
    tab: (machine) => tabs[machine] ?? (machine === "computer" ? sessions.sessions?.[0]?.id ?? FIRST_SESSION_ID : ONE_SHELL),
    choose,
    split,
    setSplit,
  };

  const chosen = selectedMachine === null ? <div className="min-h-0 flex-1" /> : (
    <SelectedEnvironment
      key={selectedMachine.key}
      rpc={rpc}
      machine={selectedMachine}
      grant={account.grant}
      exec={execByName.get(selectedMachine.mount.name)}
      workspace={workspaceName}
      executorOutputs={executorOutputs}
      onExecute={onExecute}
      onOpenFiles={onOpenFiles}
      sessions={sessions}
      shown={shown}
      wide={wide}
    />
  );

  return (
    <div ref={frame} className="flex h-full flex-col">
      {wide ? (
        <div className="grid min-h-0 flex-1 grid-cols-[236px_minmax(0,1fr)]">
          <SessionRail environments={environments} execByName={execByName} sessions={sessions} selected={selectedMachine?.key ?? null}
            shown={shown} onConnectDevice={onConnectDevice} />
          <div className="flex min-h-0 min-w-0 flex-col">{chosen}</div>
        </div>
      ) : (
        <>
          <MachineChips environments={environments} execByName={execByName} selected={selectedMachine?.key ?? null} onSelect={(machine) => choose(machine)} waiting={waiting}
            onConnectDevice={onConnectDevice} empty={mounts.length === 0 && loaded !== null} loading={mounts.length === 0 && resource.status === "loading"} />
          {chosen}
        </>
      )}
      {resource.status === "error" && (
        <LoadFailure what="the environments" message={resource.message} onRetry={reload} className="mx-4 mb-3 p-card px-3 py-2" />
      )}
      {account.failure !== null && <p className="mx-4 mb-3 p-meta p-danger">Could not read your machines: {account.failure}</p>}
    </div>
  );
}

/** The column turns wide enough for every machine's sessions down one side, as cmux keeps its workspaces. */
const WIDE_COLUMN_PX = 880;

function useWideColumn(frame: RefObject<HTMLDivElement | null>): boolean {
  const [wide, setWide] = useState(false);

  useEffect(() => {
    const element = frame.current;

    if (element === null) return undefined;
    const observer = new ResizeObserver(() => setWide(element.clientWidth >= WIDE_COLUMN_PX));

    observer.observe(element);

    return () => observer.disconnect();
  }, [frame]);

  return wide;
}

/** The first session the box keeps (`FIRST_SESSION` in the box's sessions). */
const FIRST_SESSION_ID = "shell";

/** Which tab each machine shows, and the wide column's second pane. */
interface Shown {
  readonly tab: (machine: string) => string;
  readonly choose: (machine: string, tab?: string) => void;
  /** The session the second pane shows, in the wide column; null for one pane. */
  readonly split: string | null;
  readonly setSplit: (session: string | null) => void;
}

function MachineChips({ environments, execByName, selected, onSelect, onConnectDevice, empty, loading, waiting }: {
  /** Machines a session of which waits at a prompt (D95). */
  waiting: ReadonlySet<string>;
  environments: readonly Machine[];
  execByName: ReadonlyMap<string, ExecutorInfo>;
  selected: string | null;
  onSelect: (machine: string) => void;
  onConnectDevice: () => void;
  empty: boolean;
  loading: boolean;
}) {
  return (
    <div role="group" aria-label="Environments" className="flex shrink-0 flex-wrap gap-1.5 px-4 pt-4">
      {environments.map((m) => {
        const exec = execByName.get(m.mount.name);
        const { Icon: KindIcon } = environmentOf(m.mount.name);
        const active = selected === m.key;

        return (
          <div key={m.key} data-env-card={m.mount.name} className="min-w-0">
            <button type="button" data-env-select onClick={() => onSelect(m.key)} aria-pressed={active} className="p-env-chip">
              <KindIcon size={14} weight={active ? "fill" : "regular"} className="shrink-0" aria-hidden />
              <span className="truncate">{machineLabel(m, exec)}</span>
              <Dot tone={waiting.has(m.key) ? "attention" : machineStatus(m, exec).tone} />
            </button>
          </div>
        );
      })}
      <button type="button" data-env-connect onClick={onConnectDevice} aria-label="Connect a PC" title="Connect a PC"
        className="p-env-chip border-dashed p-text-3">
        <PlusIcon size={13} className="shrink-0" aria-hidden /><span className="hidden @[30rem]:inline">Connect a PC</span>
      </button>
      {empty && <span className="p-meta p-text-3">No environments available.</span>}
      {loading && <Loader size="sm" />}
    </div>
  );
}

/** The wide column's list: every machine, its sessions under it, the computer's screen and a new session. */
function SessionRail({ environments, execByName, sessions, selected, shown, onConnectDevice }: {
  environments: readonly Machine[];
  execByName: ReadonlyMap<string, ExecutorInfo>;
  sessions: ComputerSessions;
  selected: string | null;
  shown: Shown;
  onConnectDevice: () => void;
}) {
  const now = Date.now();

  return (
    <nav aria-label="Sessions" className="flex min-h-0 flex-col gap-5 overflow-y-auto border-r p-border px-2 pt-4 pb-4">
      {environments.map((m) => {
        const exec = execByName.get(m.mount.name);
        const name = machineLabel(m, exec);
        const computer = m.key === "computer";
        const rows = computer ? sessions.sessions ?? [] : null;
        const current = (tab: string) => selected === m.key && (shown.tab(m.key) === tab || shown.split === tab);

        return (
          <section key={m.key} data-env-card={m.mount.name} aria-label={name} className="space-y-0.5">
            <button type="button" data-env-select aria-pressed={selected === m.key} onClick={() => shown.choose(m.key)}
              className="flex w-full items-center gap-2 px-2.5 pb-1 text-left">
              <span className="p-eyebrow min-w-0 flex-1 truncate">{name}</span>
              <Dot tone={machineStatus(m, exec).tone} />
            </button>
            {rows === null && m.mount.live && (
              <RailRow tone="ready" name={ONE_SHELL} detail={null} ports={[]} current={current(ONE_SHELL)} onChoose={() => shown.choose(m.key, ONE_SHELL)} />
            )}
            {rows?.map((session) => (
              <RailRow key={session.id} tone={sessionTone(session).tone} agent={session.job !== undefined} name={session.name} detail={railDetail(session, now)} ports={session.ports}
                current={current(session.id)} onChoose={() => shown.choose(m.key, session.id)} />
            ))}
            {computer && m.mount.live && <RailRow icon name="Desktop" detail={null} ports={[]} current={current("desktop")} onChoose={() => shown.choose(m.key, "desktop")} />}
            {computer && m.mount.live && <NewSessionRow onOpen={() => openSession(sessions, (id) => shown.choose("computer", id))} />}
          </section>
        );
      })}
      <button type="button" data-env-connect onClick={onConnectDevice} aria-label="Connect a PC"
        className="mx-1 flex items-center gap-2 rounded-lg border border-dashed p-border px-2.5 py-2 p-meta p-text-3 hover:p-text">
        <PlusIcon size={12} aria-hidden />Connect a PC
      </button>
    </nav>
  );
}

function railDetail(session: TerminalSession, now: number): string {
  if (session.needsInput) return "Waiting for input";

  if (session.running !== null) return session.running;

  return session.last !== null && session.last.command !== "" ? `${session.last.command} · ${since(session.last.at, now)}` : session.cwd;
}

function RailRow({ tone, icon = false, agent = false, name, detail, ports, current, onChoose }: {
  tone?: SessionTone;
  icon?: boolean;
  /** An agent's job runs in it (D95). */
  agent?: boolean;
  name: string;
  detail: string | null;
  ports: readonly number[];
  current: boolean;
  onChoose: () => void;
}) {
  return (
    <button type="button" aria-current={current ? "true" : undefined} data-attention={tone === "attention" ? "" : undefined} onClick={onChoose} className="p-session-row">
      {icon ? <DesktopIcon size={12} aria-hidden /> : <Dot tone={tone ?? "ready"} />}
      <span className="inline-flex min-w-0 items-center gap-1.5">{agent && <AgentMark />}<span className="truncate p-row-text font-medium">{name}</span></span>
      <span className="p-annotation p-text-3">{ports.map((port) => `:${String(port)}`).join(" ")}</span>
      {detail !== null && <><span /><span className="col-span-2 truncate p-meta p-text-3">{detail}</span></>}
    </button>
  );
}

function SelectedEnvironment({ rpc, machine, grant, exec, workspace, executorOutputs, onExecute, onOpenFiles, sessions, shown, wide }: {
  rpc: WorkspaceRpc;
  machine: Machine;
  grant: (device: string) => Effect.Effect<void, KinuError>;
  exec: ExecutorInfo | undefined;
  workspace: string;
  executorOutputs: Map<string, ExecutorOutput[]>;
  onExecute: (id: string, cmd: string) => Promise<ExecutorCommandResult>;
  onOpenFiles: (root: string) => void;
  sessions: ComputerSessions;
  shown: Shown;
  wide: boolean;
}) {
  const { mount, device } = machine;
  const computer = mount.name === "computer";
  // The computer's size, read here: its control sits in the head, its restart covers the view.
  const size = useComputerSize(rpc, computer && mount.live);
  const name = machineLabel(machine, exec);
  const restarting = computer && size.pending === "resize";
  const listed = sessions.sessions ?? [];
  const seen = { waiting: listed.some((session) => session.needsInput), awake: listed.some((session) => session.open) };
  const status = computer ? computerStatus(mount, exec, size, seen) : machineStatus(machine, exec);

  return (
    <section aria-label={name} className="flex min-h-0 flex-1 flex-col">
      <Head mount={mount} name={name} status={status} specs={computer ? size.specs : null} onOpenFiles={onOpenFiles}
        size={computer ? <ComputerSize state={size} /> : null} />
      {computer && size.notice}
      {computer && sessions.failure !== null && <p className="px-4 pb-1 p-meta p-danger">{sessions.failure}</p>}
      {device !== null && !device.connected && (
        <Absence icon={DesktopTowerIcon} title={`${name} is offline`}>
          Its Kinu daemon is not running. Run <code className="p-annotation">kinu connect</code> on it to bring it back.
        </Absence>
      )}
      {device !== null && device.connected && !device.granted && <GiveAccess name={name} onGive={() => grant(device.id)} />}
      {(device === null || (device.connected && device.granted)) && (
        <EnvironmentView mount={mount} machineKey={machine.key} device={device?.id ?? null} exec={exec} name={name} workspace={workspace}
          restartingTo={restarting ? size.restartingTo ?? "" : null} executorOutputs={executorOutputs} onExecute={onExecute}
          sessions={computer ? sessions : null} shown={shown} wide={wide} />
      )}
    </section>
  );
}

/** The chosen machine's head: its name and state, what it is, and its actions. */
function Head({ mount, name, status, specs, size, onOpenFiles }: {
  mount: MountInfo;
  name: string;
  status: StatusReading;
  specs: string | null;
  size: ReactNode;
  onOpenFiles: (root: string) => void;
}) {
  const filesRoot = filesRootFor(mount.name);
  const { about } = environmentOf(mount.name);

  return (
    <header className="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-2.5 px-4 pt-4 pb-1">
      <div className="min-w-[12rem] flex-1">
        <div className="flex min-w-0 items-center gap-2.5">
          <h3 className="p-env-name truncate">{name}</h3>
          <span data-env-status className="p-env-state shrink-0" data-tone={status.tone}><Dot tone={status.tone} />{status.word}</span>
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
          {size}
          {filesRoot !== null && (
            <button type="button" data-env-files onClick={() => onOpenFiles(filesRoot)} title={`Browse ${name}'s files at ${filesRoot}`} className="p-env-action">
              <FolderOpenIcon size={13} aria-hidden />Files
            </button>
          )}
        </div>
      )}
    </header>
  );
}

/** Under the head: the machine's absence, its restart, or its tabs and its terminal or screen. */
function EnvironmentView({ mount, machineKey, device, exec, name, workspace, restartingTo, executorOutputs, onExecute, sessions, shown, wide }: {
  mount: MountInfo;
  /** The machine's key in the column: its tabs are kept under it. */
  machineKey: string;
  /** The PC's id, so its terminal opens on it when several are connected; null for any other machine. */
  device: string | null;
  exec: ExecutorInfo | undefined;
  name: string;
  workspace: string;
  /** While a resize restarts the computer, the size it starts at. */
  restartingTo: string | null;
  executorOutputs: Map<string, ExecutorOutput[]>;
  onExecute: (id: string, cmd: string) => Promise<ExecutorCommandResult>;
  /** The computer's sessions; null for a machine with one shell. */
  sessions: ComputerSessions | null;
  shown: Shown;
  wide: boolean;
}) {
  if (!mount.live) return <UnavailableMount mount={mount} exec={exec} />;

  if (exec === undefined) return <Absence icon={PlugIcon} title="No command lane">This environment runs no commands.</Absence>;

  const tab = shown.tab(machineKey);
  // Only the computer has a screen.
  const desktop = exec.name === "computer" ? desktopClientUrl(location, workspace) : null;

  const tabs = wide ? null : (
    <SessionTabs label={`${name} sessions`} sessions={sessions?.sessions ?? null} current={tab} desktop={desktop !== null}
      onChoose={(id) => shown.choose(machineKey, id)} onDesktop={() => shown.choose(machineKey, "desktop")}
      onOpen={sessions === null ? null : () => openSession(sessions, (id) => shown.choose(machineKey, id))}
      onRename={(id, next) => sessions?.rename(id, next) ?? Effect.void}
      onClose={(id) => sessions?.close(id) ?? Effect.void} />
  );

  // A resize restarts the computer, which ends its shells and its desktop's session: the panes open again after it.
  if (restartingTo !== null) return <>{tabs}<div className="p-terminal-ground flex min-h-0 flex-1 flex-col"><Restarting to={restartingTo === "" ? null : restartingTo} /></div></>;

  const showing = tab === "desktop" && desktop !== null
    ? [tab]
    : [tab, ...(wide && shown.split !== null && shown.split !== tab ? [shown.split] : [])];

  const pane = (id: string, place: PanePlace) => (id === "desktop" && desktop !== null
    ? <DesktopView name={name} src={desktop} ruled={wide} />
    : <SessionPane workspace={workspace} exec={exec} device={device} session={id} sessions={sessions}
      executorOutputs={executorOutputs} onExecute={onExecute} named={place !== "kept" && showing.length > 1} ruled={wide}
      trailing={wide && sessions !== null ? <SplitToggle sessions={sessions} shown={shown} showing={id} /> : null} />);

  return <>{tabs}<MachinePanes showing={showing} sessions={sessions} pane={pane} /></>;
}

/** Where a pane sits: the one shown or the split's first, the split's second, or kept open out of sight. */
type PanePlace = "first" | "second" | "kept";

/** The places of the panes shown, in the order shown. */
const SHOWN_PLACES: readonly PanePlace[] = ["first", "second"];

const PANE_PLACES: Record<PanePlace, string> = {
  first: "order-first flex min-w-0 flex-1",
  second: "order-last flex min-w-0 flex-1 border-l p-border",
  // Laid out at the shown pane's size, so showing it again neither reconnects nor resizes it.
  kept: "invisible absolute inset-0 flex",
};

/**
 * A machine's panes: each one opened stays mounted, its terminal's socket or its desktop's client with it, and a
 * switch only shows another. Production f9c17ac7b (the owner, 2026-10-14) unmounted the pane a switch left, so every
 * switch between a terminal and the desktop opened its socket again behind a loading state. A closed session's pane
 * goes with it; a restart, which ends them all, starts the list again.
 */
function MachinePanes({ showing, sessions, pane }: {
  showing: readonly string[];
  sessions: ComputerSessions | null;
  pane: (id: string, place: PanePlace) => ReactNode;
}) {
  const [opened, setOpened] = useState<readonly string[]>(showing);
  const unopened = showing.filter((id) => !opened.includes(id));

  // Recorded while rendering, as React keeps what an earlier render saw: the pane mounts on this render, not the next.
  if (unopened.length > 0) setOpened([...opened, ...unopened]);
  const listed = sessions?.sessions ?? null;
  // A pane out of sight goes with its session; the one shown follows its tab, as a tab chosen before the list reads.
  const stillOpen = (id: string) => listed === null || id === "desktop" || listed.some((session) => session.id === id);
  const open = [...opened, ...unopened].filter((id) => showing.includes(id) || stillOpen(id));

  return (
    <div className="relative flex min-h-0 flex-1">
      {open.map((id) => {
        const place = SHOWN_PLACES[showing.indexOf(id)] ?? "kept";

        return <div key={id} className={PANE_PLACES[place]}>{pane(id, place)}</div>;
      })}
    </div>
  );
}

/** A session's terminal, its details in its bar. */
function SessionPane({ workspace, exec, device, session, sessions, executorOutputs, onExecute, named, ruled, trailing }: {
  workspace: string;
  exec: ExecutorInfo;
  device: string | null;
  session: string;
  sessions: ComputerSessions | null;
  executorOutputs: Map<string, ExecutorOutput[]>;
  onExecute: (id: string, cmd: string) => Promise<ExecutorCommandResult>;
  /** Two panes side by side name theirs. */
  named: boolean;
  /** The wide column draws no tabs, so the pane draws its own rule above. */
  ruled: boolean;
  trailing: ReactNode;
}) {
  const read = sessions?.sessions?.find((candidate) => candidate.id === session) ?? null;

  return (
    <div className={`@container flex min-h-0 min-w-0 flex-1 flex-col ${ruled ? "border-t p-border" : ""}`}>
      <Suspense fallback={<div className="flex h-full items-center justify-center"><Loader size="sm" /></div>}>
        <TerminalPane workspace={workspace} executor={exec.name} outputs={executorOutputs.get(exec.name) ?? []}
          onExecute={(cmd) => onExecute(exec.name, cmd)} session={sessions === null ? undefined : session} device={device ?? undefined} barOnGround
          leading={<SessionDetails session={read} name={named ? read?.name ?? session : undefined} />} trailing={trailing} />
      </Suspense>
    </div>
  );
}

/** The wide column's split: a second pane with the next session, or one pane again. */
function SplitToggle({ sessions, shown, showing }: { sessions: ComputerSessions; shown: Shown; showing: string }) {
  const others = (sessions.sessions ?? []).filter((session) => session.id !== showing);

  if (shown.split === showing) {
    return <button type="button" aria-label="One pane" title="One pane" className="p-bar-icon" onClick={() => shown.setSplit(null)}><XIcon size={13} /></button>;
  }

  if (shown.split !== null || others[0] === undefined) return null;
  const next = others[0].id;

  return (
    <button type="button" aria-label="Split" title={`Split: ${others[0].name} beside it`} className="p-bar-icon" onClick={() => shown.setSplit(next)}>
      <SplitHorizontalIcon size={14} />
    </button>
  );
}

/**
 * The computer's screen under its strip: in the column, or expanded over the workspace area with the rail folded. One
 * frame either way, so expanding moves no client and reconnects nothing. Production f9c17ac7b opened a second client
 * in a new tab instead, on a page that drew it as a thin strip (the owner, 2026-10-14).
 */
function DesktopView({ name, src, ruled }: { name: string; src: string; ruled: boolean }) {
  const title = `${name}'s desktop`;
  const area = useWorkspaceArea();
  const [expanded, setExpanded] = useState(false);
  const cover = useCover(area, expanded);
  const { width, height } = DESKTOP_SIZE;

  return (
    <div data-desktop-view={cover === null ? undefined : "expanded"} style={cover ?? undefined}
      className={`p-terminal-ground flex min-h-0 flex-1 flex-col ${cover === null ? "" : "fixed z-40"} ${ruled && cover === null ? "border-t p-border" : ""}`}>
      <div className={`flex shrink-0 items-center gap-3 pr-3 pl-4 p-meta p-text-3 ${cover === null ? "h-9" : "h-11 border-b p-border"}`}>
        {cover !== null && <span className="inline-flex min-w-0 items-center gap-1.5 font-medium p-text-2"><DesktopIcon size={13} aria-hidden /><span className="truncate">{title}</span></span>}
        <span className="shrink-0">{String(width)} × {String(height)}</span>
        {area !== null && cover === null && (
          <button type="button" data-desktop-expand onClick={() => setExpanded(true)} aria-label={`Expand ${title}`} title="Expand over the workspace"
            className="ml-auto inline-flex items-center gap-1.5 hover:p-text">
            <ArrowsOutIcon size={13} aria-hidden />Expand
          </button>
        )}
        {cover !== null && (
          <button type="button" data-desktop-return onClick={() => setExpanded(false)} aria-label="Back to the Environment panel"
            className="p-env-action ml-auto">
            <ArrowsInIcon size={13} aria-hidden />Back to panel
          </button>
        )}
      </div>
      {/* The screen at its own shape, as large as its place allows, so the client draws it edge to edge; expanded, on
          the screen's own black, as a player letterboxes. */}
      <div className={`flex min-h-0 flex-1 justify-center ${cover === null ? "items-start" : "items-center bg-black"}`} style={{ containerType: "size" }}>
        <div style={{ aspectRatio: `${String(width)} / ${String(height)}`, width: `min(100cqw, 100cqh * ${String(width)} / ${String(height)})` }}>
          <DesktopScreen src={src} title={title} />
        </div>
      </div>
    </div>
  );
}

/** The workspace area's box while the desktop covers it, followed as the rail folds and the window resizes; the rail
 *  folds while it does. Null in the column. */
function useCover(area: WorkspaceArea | null, expanded: boolean): CSSProperties | null {
  const [box, setBox] = useState<DOMRect | null>(null);
  const main = area?.main ?? null;
  const fill = area?.fill;

  useEffect(() => {
    if (!expanded || main === null || fill === undefined) return undefined;
    const observer = new ResizeObserver(() => setBox(main.getBoundingClientRect()));

    observer.observe(main);
    fill(true);

    return () => {
      observer.disconnect();
      fill(false);
      setBox(null);
    };
  }, [expanded, main, fill]);

  return box === null ? null : { left: box.left, top: box.top, width: box.width, height: box.height };
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

/**
 * A machine on the owner's account that this workspace does not hold: one click gives it, the grant the agent's
 * approval box records when the owner answers "always", decided here by the owner instead of asked by an agent.
 */
function GiveAccess({ name, onGive }: { name: string; onGive: () => Effect.Effect<void, KinuError> }) {
  const [giving, setGiving] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const give = Effect.suspend(() => {
    setGiving(true);
    setFailure(null);

    return onGive();
  }).pipe(
    Effect.catch((cause) => Effect.sync(() => setFailure(renderThrownChain({ cause })))),
    Effect.ensuring(Effect.sync(() => setGiving(false))),
  );

  return (
    <div data-env-give-access className="flex min-h-0 flex-1 items-center justify-center border-t p-border px-8">
      <div className="max-w-sm space-y-3 text-center">
        <LockSimpleIcon size={22} className="mx-auto p-text-3" aria-hidden />
        <div className="space-y-1.5">
          <p className="p-row-text font-semibold p-text">This workspace can&apos;t use {name} yet</p>
          <p className="p-meta p-text-2">
            {name} is connected to your account. Give this workspace access and its agent can run commands and open a
            terminal there, inside the machine&apos;s sandbox. You can take it back on the Devices page.
          </p>
        </div>
        <FilledButton onClick={() => detach(give)} disabled={giving}>{giving ? "Giving access…" : "Give this workspace access"}</FilledButton>
        {failure !== null && <p className="p-meta p-danger">{failure}</p>}
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
