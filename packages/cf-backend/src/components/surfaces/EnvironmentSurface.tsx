/**
 * Environment: the machines this workspace runs on, as one surface on the column's ground. A row of chips chooses the
 * machine; its head says what it is, its state and its actions; under it, its terminal or, for the computer, its
 * screen, from one hairline to the column's foot. Capability doctrine stays model-facing
 * (core/src/prompting/volatile-context.ts); file browsing lives in Files.
 */
import { Suspense, useContext, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { Button } from "@/components/ui/Button";
import { useParams } from "react-router-dom";
import {
  ArrowsInIcon, ArrowsOutIcon, DesktopIcon, DesktopTowerIcon, FolderOpenIcon, GitForkIcon, LockSimpleIcon, PlugIcon, PlusIcon,
  SplitHorizontalIcon, SquaresFourIcon, XIcon, type Icon,
} from "@phosphor-icons/react";
import { EXECUTOR_MOUNTS, desktopClientUrl, type EnvironmentInfo } from "@kinu.run/core";
import type { ExecutorCommandResult } from "@kinu.run/core";
import {
  executorLabel,
  pickDefaultExecutor,
  type ExecutorInfo,
} from "@kinu.run/core";
import { DESKTOP_SIZE } from "@kinu.run/devbox/desktop";
import type { TerminalSession } from "@kinu.run/devbox";
import type { ExecutorOutput } from "@/hooks/use-chat-owner";
import { lazyRoute } from "@/lazy-route";
import type { TerminalPaneProps } from "@/components/TerminalPane";
import { TerminalReplay } from "@/components/terminal-replay";
import { Loader } from "@/components/ui/Loader";
import { lastValue } from "@/hooks/use-async-resource";
import { useMounts } from "@/hooks/use-mounts";
import { LoadFailure } from "@/components/ui/LoadFailure";
import { ComputerSize, useComputerSize, type ComputerSizeControl } from "@/components/ComputerSize";
import { Effect } from "effect";
import { useWorkspaceArea, type WorkspaceArea } from "@/components/layout";
import { DesktopScreen } from "./DesktopScreen";
import { useAccountMachines, type AccountMachine } from "./EnvironmentMachines";
import { detach, renderThrownChain, type KinuError } from "@kinu.run/core/obs";
import {
  ONE_SHELL, SessionDetails, SessionTabs, openSession, useMachineSessions, type MachineSessions,
} from "./EnvironmentSessions";
import type { WorkspaceRpc } from "@/lib/workspace-rpc";
import { IconControl } from "@/components/ui/IconControl";
import { ChipToggle } from "@/components/ui/Chip";
import { Surface } from "@/components/ui/Surface";

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
  /** Open on the chosen machine's desktop, once it is listed (the desktop's old address, D99). */
  desktopLanding?: boolean;
  onDesktopLanded?: () => void;
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
  readonly mount: EnvironmentInfo;
  /** The account's machine, for a PC; null for the workspace, the computer and the rest. */
  readonly device: AccountMachine | null;
}

/**
 * The workspace's mounts, with the PC executor's one row made one row per machine on the account. A PC is live when the
 * account says it is connected and held here: the executor's own reading follows a grant only after the hub's next
 * status push, and the terminal and every command check the grant themselves.
 */
function machinesOf(mounts: readonly EnvironmentInfo[], account: readonly AccountMachine[] | null): Machine[] {
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

/** What a machine's Desktop tab shows: its screen at its size, or the step before it; null for no tab. */
type MachineDesktop =
  | { readonly kind: "screen"; readonly src: string; readonly width: number; readonly height: number }
  | { readonly kind: "step"; readonly state: "setup" | "permission"; readonly detail: string | null }
  | null;

/** The computer's screen; a PC's as its daemon reports it (1014-t); none for the workspace. */
/** The machine's screen as its pane shows it: none where its terminal is replayed (`TerminalReplay`), with no machine. */
function shownDesktop(machine: Machine, workspace: string, replaying: boolean): MachineDesktop {
  return replaying ? null : machineDesktop(machine, workspace);
}

function machineDesktop(machine: Machine, workspace: string): MachineDesktop {
  if (machine.mount.name === "computer") return { kind: "screen", src: desktopClientUrl(location, workspace, null), ...DESKTOP_SIZE };
  const desktop = machine.device?.desktop;

  if (machine.device === null || desktop === undefined || desktop.state === "none") return null;

  if (desktop.state === "ready") return { kind: "screen", src: desktopClientUrl(location, workspace, machine.device.id), width: desktop.width, height: desktop.height };

  return { kind: "step", state: desktop.state, detail: desktop.state === "setup" ? desktop.detail : null };
}

function machineLabel(machine: Machine, exec: ExecutorInfo | undefined): string {
  return machine.device?.label ?? exec?.label ?? executorLabel(machine.mount.name);
}

/** A PC's state is the account's first: offline, or connected without this workspace's grant. */
function machineStatus(machine: Machine, exec: ExecutorInfo | undefined, seen: { waiting: boolean }): StatusReading {
  if (machine.device !== null && !machine.device.connected) return { word: "Offline", tone: "off" };

  if (machine.device !== null && !machine.device.granted) return { word: "No access", tone: "attention" };

  // A PC's program waiting for an answer reads as the computer's does (1019-aa).
  if (seen.waiting) return { word: "Needs input", tone: "attention" };

  return statusOf(machine.mount, exec);
}

/** One status language for every machine: a dot's tone and a word. */
type Tone = "working" | "ready" | "attention" | "off" | "danger";

interface StatusReading { readonly word: string; readonly tone: Tone }

/** A machine's state: ready to run commands, or why not. "Running" is a command's word, not a machine's. */
function statusOf(mount: EnvironmentInfo, exec: ExecutorInfo | undefined): StatusReading {
  // Reach before liveness, but only for a live row: `granted` is answered only while
  // the machine is connected, so a not-live mount stays offline.
  if (mount.live && mount.name === "device" && exec?.granted === false) return { word: "Needs approval", tone: "attention" };

  if (!mount.live) return { word: mount.name === "computer" ? "Not available" : "Offline", tone: "off" };

  if (exec?.status === "error") return { word: "Error", tone: "danger" };

  return { word: "Ready", tone: "ready" };
}

/**
 * The computer's state: restarting under a resize, its last stop waiting on a disk that stopped answering (its Stop is
 * beside the size), waiting on a session's prompt, asleep while stopped (it wakes when used), else as any machine. A
 * session open on it says it woke since its size was read.
 */
function computerStatus(mount: EnvironmentInfo, exec: ExecutorInfo | undefined, size: ComputerSizeControl, seen: { waiting: boolean; awake: boolean }): StatusReading {
  if (size.pending === "resize") return { word: "Restarting", tone: "working" };

  if (size.state?.stalled != null) return { word: "Waiting on its disk", tone: "attention" };

  if (seen.waiting) return { word: "Needs input", tone: "attention" };

  if (mount.live && size.state !== null && size.state.running === null && !seen.awake) return { word: "Asleep", tone: "off" };

  return statusOf(mount, exec);
}

/** A machine one of whose sessions waits for an answer. */
function sessionWaits(read: MachineSessions): boolean {
  return read.sessions?.some((session) => session.needsInput) === true;
}

function Dot({ tone }: { tone: Tone }) {
  return <span aria-hidden className="p-env-dot" data-tone={tone} />;
}

export function EnvironmentSurface(props: EnvironmentSurfaceProps) {
  const { rpc, executors, executorOutputs, lastActiveExecutor, onExecute, onOpenFiles, onConnectDevice, desktopLanding = false, onDesktopLanded } = props;
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
  // The computer's sessions are read while they are on screen: its tabs, or the wide column's list. A PC's are read
  // while it is chosen and this workspace holds it (1019-aa); either one's waiting session marks its machine.
  const sessions = useMachineSessions(rpc, computerLive && (wide || selectedMachine?.key === "computer"), null);
  const chosenDevice = selectedMachine?.device ?? null;
  const pcSessions = useMachineSessions(rpc, chosenDevice !== null && chosenDevice.connected && chosenDevice.granted, chosenDevice?.id ?? null);

  const waiting = new Set([
    ...(sessionWaits(sessions) ? ["computer"] : []),
    ...(chosenDevice !== null && selectedMachine !== null && sessionWaits(pcSessions) ? [selectedMachine.key] : []),
  ]);

  const choose = (machine: string, tab?: string) => {
    setSelected(machine);

    if (tab !== undefined) setTabs((was) => ({ ...was, [machine]: tab }));

    if (machine !== selectedMachine?.key) setSplit(null);
  };

  // The desktop's old address: once the chosen machine is listed, its desktop tab is the one shown, if it has a desktop.
  const replaying = useContext(TerminalReplay) !== null;
  const landOn = selectedMachine !== null && shownDesktop(selectedMachine, workspaceName, replaying) !== null ? selectedMachine.key : null;

  useEffect(() => {
    if (!desktopLanding || selectedMachine === null) return;

    if (landOn !== null) setTabs((was) => ({ ...was, [landOn]: "desktop" }));
    onDesktopLanded?.();
  }, [desktopLanding, selectedMachine, landOn, onDesktopLanded]);

  const shown: Shown = {
    tab: (machine) => tabs[machine] ?? (machine === "computer" ? sessions.sessions?.[0]?.id ?? FIRST_SESSION_ID : ONE_SHELL),
    choose,
    split,
    setSplit,
  };

  // The machine row, with the chosen machine's state and actions once it is chosen.
  const machineRow = (chosenMachine: ChosenMachine | null) => (
    <MachineRow environments={environments} execByName={execByName} selected={selectedMachine?.key ?? null} chosen={chosenMachine}
      onSelect={(machine) => choose(machine)} waiting={waiting} onConnectDevice={onConnectDevice}
      empty={mounts.length === 0 && loaded !== null} loading={mounts.length === 0 && resource.status === "loading"} />
  );

  return (
    <div ref={frame} className="flex h-full flex-col">
      {selectedMachine === null ? <>{machineRow(null)}<div className="min-h-0 flex-1" /></> : (
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
          sessions={chosenDevice === null ? sessions : pcSessions}
          shown={shown}
          wide={wide}
          machineRow={machineRow}
        />
      )}
      {resource.status === "error" && (
        <Surface look="panel" className="mx-4 mb-3 px-3 py-2"><LoadFailure what="the environments" message={resource.message} onRetry={reload} /></Surface>
      )}
      {account.failure !== null && <p data-failure className="t-meta mx-4 mb-3 p-danger">Could not read your machines: {account.failure}</p>}
    </div>
  );
}

/** The column turns wide enough for two of the computer's sessions side by side. */
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

/** The chosen machine's state and what it offers, drawn at the machine row's end. */
interface ChosenMachine {
  readonly status: StatusReading;
  readonly actions: ReactNode;
}

/**
 * Every machine in one row, the chosen one with its state, and the chosen one's actions at its end: the Env tab's one
 * row of machines, at every width. The owner asked for no second column of sessions (2026-10-14).
 */
function MachineRow({ environments, execByName, selected, chosen, onSelect, onConnectDevice, empty, loading, waiting }: {
  /** Machines a session of which waits at a prompt (D95). */
  waiting: ReadonlySet<string>;
  environments: readonly Machine[];
  execByName: ReadonlyMap<string, ExecutorInfo>;
  selected: string | null;
  chosen: ChosenMachine | null;
  onSelect: (machine: string) => void;
  onConnectDevice: () => void;
  empty: boolean;
  loading: boolean;
}) {
  return (
    <div role="group" aria-label="Environments" className="flex shrink-0 flex-wrap items-center gap-2 px-4 pt-3 pb-2">
      {environments.map((m) => {
        const exec = execByName.get(m.mount.name);
        const { Icon: KindIcon, about } = environmentOf(m.mount.name);
        const active = selected === m.key;
        const status = active && chosen !== null ? chosen.status : machineStatus(m, exec, { waiting: waiting.has(m.key) });

        return (
          <div key={m.key} data-env-card={m.mount.name} className="min-w-0">
            {/* A narrow column names only the chosen machine; the others keep their icon and state. */}
            <ChipToggle data-env-select onClick={() => onSelect(m.key)} aria-pressed={active} title={`${machineLabel(m, exec)}: ${about}`}>
              <KindIcon size={14} weight={active ? "fill" : "regular"} className="shrink-0" aria-hidden />
              <span className={active ? "truncate" : "sr-only @[30rem]:not-sr-only @[30rem]:truncate"}>{machineLabel(m, exec)}</span>
              {m.mount.policy.readOnly && <LockSimpleIcon size={11} className="shrink-0 p-text-3" aria-label="Read-only" />}
              <Dot tone={waiting.has(m.key) ? "attention" : status.tone} />
            </ChipToggle>
          </div>
        );
      })}
      <ChipToggle data-env-connect onClick={onConnectDevice} aria-label="Connect a PC" title="Connect a PC" className="border-dashed p-text-3">
        <PlusIcon size={14} className="shrink-0" aria-hidden /><span className="hidden @[56rem]:inline">Connect a PC</span>
      </ChipToggle>
      {empty && <span className="t-meta p-text-3" data-env-empty>No environments available.</span>}
      {loading && <Loader size="sm" />}
      {/* The chosen machine's state in words, then what it offers: the chips are named by their machines alone. */}
      {chosen !== null && (
        <div className="ml-auto flex min-w-0 items-center gap-2">
          <span data-env-status className="t-meta mr-1 shrink-0" data-tone={chosen.status.tone}>{chosen.status.word}</span>
          {chosen.actions}
        </div>
      )}
    </div>
  );
}

function SelectedEnvironment({ rpc, machine, grant, exec, workspace, executorOutputs, onExecute, onOpenFiles, sessions, shown, wide, machineRow }: {
  rpc: WorkspaceRpc;
  machine: Machine;
  grant: (device: string) => Effect.Effect<void, KinuError>;
  exec: ExecutorInfo | undefined;
  workspace: string;
  executorOutputs: Map<string, ExecutorOutput[]>;
  onExecute: (id: string, cmd: string) => Promise<ExecutorCommandResult>;
  onOpenFiles: (root: string) => void;
  /** The computer's sessions, or the chosen PC's. */
  sessions: MachineSessions;
  shown: Shown;
  wide: boolean;
  machineRow: (chosen: ChosenMachine) => ReactNode;
}) {
  const { mount, device } = machine;
  const computer = mount.name === "computer";
  // A replayed computer (the landing's sample) has no screen to show.
  const replaying = useContext(TerminalReplay) !== null;
  // The computer's size, read here: its control sits in the head, its restart covers the view.
  const size = useComputerSize(rpc, computer && mount.live);
  const name = machineLabel(machine, exec);
  const restarting = computer && size.pending === "resize";
  // The computer's sessions or the chosen PC's, read above for the machine row's marks too; another machine has one shell.
  const machineSessions = computer || device !== null ? sessions : null;
  const listed = sessions.sessions ?? [];
  const seen = { waiting: listed.some((session) => session.needsInput), awake: listed.some((session) => session.open) };
  const status = computer ? computerStatus(mount, exec, size, seen) : machineStatus(machine, exec, { waiting: device !== null && seen.waiting });

  return (
    <section aria-label={name} className="flex min-h-0 flex-1 flex-col">
      {machineRow({ status, actions: <MachineActions mount={mount} name={name} size={computer ? <ComputerSize state={size} /> : null} onOpenFiles={onOpenFiles} /> })}
      {computer && size.notice}
      {machineSessions?.failure != null && <p className="t-meta px-4 pb-1 p-danger">{machineSessions.failure}</p>}
      {device !== null && !device.connected && (
        <Absence icon={DesktopTowerIcon} title={`${name} is offline`}>
          Its Kinu daemon is not running. Run <code className="t-meta t-mono">kinu connect</code> on it to bring it back.
        </Absence>
      )}
      {device !== null && device.connected && !device.granted && <GiveAccess name={name} onGive={() => grant(device.id)} />}
      {(device === null || (device.connected && device.granted)) && (
        <EnvironmentView mount={mount} machineKey={machine.key} device={device?.id ?? null} exec={exec} name={name} workspace={workspace}
          desktop={shownDesktop(machine, workspace, replaying)}
          restartingTo={restarting ? size.restartingTo ?? "" : null} executorOutputs={executorOutputs} onExecute={onExecute}
          sessions={machineSessions} shown={shown} wide={wide} />
      )}
    </section>
  );
}

/** The chosen machine's actions: its size where it has one, and its files where the drive mounts them. */
function MachineActions({ mount, name, size, onOpenFiles }: {
  mount: EnvironmentInfo;
  name: string;
  size: ReactNode;
  onOpenFiles: (root: string) => void;
}) {
  const filesRoot = filesRootFor(mount.name);

  if (!mount.live) return null;

  return (
    <>
      {size}
      {filesRoot !== null && (
        <Button size="sm" icon={<FolderOpenIcon size={14} aria-hidden />} data-env-files onClick={() => onOpenFiles(filesRoot)} aria-label={`${name}'s files`} title={`Browse ${name}'s files at ${filesRoot}`}>
          <span className="hidden @[56rem]:inline">Files</span>
          <span data-env-mount className="t-meta t-mono hidden p-text-3 @[56rem]:inline">{filesRoot}</span>
        </Button>
      )}
    </>
  );
}

/** Under the machine row: the machine's absence, its restart, or its tabs and its terminal or screen. */
function EnvironmentView({ mount, machineKey, device, exec, name, workspace, desktop, restartingTo, executorOutputs, onExecute, sessions, shown, wide }: {
  mount: EnvironmentInfo;
  /** The machine's key in the column: its tabs are kept under it. */
  machineKey: string;
  /** The PC's id, so its terminal opens on it when several are connected; null for any other machine. */
  device: string | null;
  exec: ExecutorInfo | undefined;
  name: string;
  workspace: string;
  desktop: MachineDesktop;
  /** While a resize restarts the computer, the size it starts at. */
  restartingTo: string | null;
  executorOutputs: Map<string, ExecutorOutput[]>;
  onExecute: (id: string, cmd: string) => Promise<ExecutorCommandResult>;
  /** The computer's sessions, or a PC's; null for a machine with one shell. */
  sessions: MachineSessions | null;
  shown: Shown;
  wide: boolean;
}) {
  if (!mount.live) return <UnavailableMount mount={mount} exec={exec} />;

  if (exec === undefined) return <Absence icon={PlugIcon} title="No command lane">This environment runs no commands.</Absence>;

  const tab = shownTab(shown.tab(machineKey), sessions?.sessions ?? null);
  // A PC's pane names its session once its list has read; one whose list failed opens its first, naming none.
  const unlisted = device !== null && sessions?.sessions === null;

  const tabs = (
    <SessionTabs label={`${name} sessions`} sessions={sessions?.sessions ?? null} current={tab} desktop={desktop !== null}
      onChoose={(id) => shown.choose(machineKey, id)} onDesktop={() => shown.choose(machineKey, "desktop")}
      onOpen={sessions === null ? null : () => openSession(sessions, (id) => shown.choose(machineKey, id))}
      onRename={(id, next) => sessions?.rename(id, next) ?? Effect.void}
      onClose={(id) => sessions?.close(id) ?? Effect.void} />
  );

  // A resize restarts the computer, which ends its shells and its desktop's session: the panes open again after it.
  if (restartingTo !== null) return <>{tabs}<div className="p-terminal-ground flex min-h-0 flex-1 flex-col"><Restarting to={restartingTo === "" ? null : restartingTo} /></div></>;

  if (unlisted && sessions?.failure === null && tab !== "desktop") return <>{tabs}<ListWaits /></>;

  const showing = tab === "desktop" && desktop !== null
    ? [tab]
    : [tab, ...(wide && shown.split !== null && shown.split !== tab ? [shown.split] : [])];

  const pane = (id: string, place: PanePlace) => (id === "desktop" && desktop !== null
    ? <DesktopPane name={name} desktop={desktop} />
    : <SessionPane workspace={workspace} exec={exec} device={device} session={id} sessions={unlisted ? null : sessions}
      executorOutputs={executorOutputs} onExecute={onExecute} named={place !== "kept" && showing.length > 1}
      trailing={wide && sessions !== null ? <SplitToggle sessions={sessions} shown={shown} showing={id} /> : null} />);

  return <>{tabs}<MachinePanes showing={showing} sessions={sessions} pane={pane} /></>;
}

/** The tab a machine shows: the one chosen, or its first session where its list lacks the chosen one (a closed
 *  session's, or a PC's chosen before its list read, whose ids are its daemon's). */
function shownTab(chosen: string, listed: readonly TerminalSession[] | null): string {
  if (chosen === "desktop" || listed === null || listed.some((session) => session.id === chosen)) return chosen;

  return listed[0]?.id ?? chosen;
}

/** A PC's pane waits for its list, so it opens the session it will keep showing. */
function ListWaits() {
  return <div className="flex min-h-0 flex-1 items-center justify-center"><Loader size="sm" /></div>;
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
  sessions: MachineSessions | null;
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
function SessionPane({ workspace, exec, device, session, sessions, executorOutputs, onExecute, named, trailing }: {
  workspace: string;
  exec: ExecutorInfo;
  device: string | null;
  session: string;
  sessions: MachineSessions | null;
  executorOutputs: Map<string, ExecutorOutput[]>;
  onExecute: (id: string, cmd: string) => Promise<ExecutorCommandResult>;
  /** Two panes side by side name theirs. */
  named: boolean;
  trailing: ReactNode;
}) {
  const read = sessions?.sessions?.find((candidate) => candidate.id === session) ?? null;

  return (
    <div className="@container flex min-h-0 min-w-0 flex-1 flex-col">
      <Suspense fallback={<div className="flex h-full items-center justify-center"><Loader size="sm" /></div>}>
        <TerminalPane workspace={workspace} executor={exec.name} outputs={executorOutputs.get(exec.name) ?? []}
          onExecute={(cmd) => onExecute(exec.name, cmd)} session={sessions === null ? undefined : session} device={device ?? undefined} barOnGround
          leading={<SessionDetails session={read} name={named ? read?.name ?? session : undefined} />} trailing={trailing} />
      </Suspense>
    </div>
  );
}

/** The wide column's split: a second pane with the next session, or one pane again. */
function SplitToggle({ sessions, shown, showing }: { sessions: MachineSessions; shown: Shown; showing: string }) {
  const others = (sessions.sessions ?? []).filter((session) => session.id !== showing);

  if (shown.split === showing) {
    return <IconControl place="bar" aria-label="One pane" title="One pane" onClick={() => shown.setSplit(null)}><XIcon size={13} /></IconControl>;
  }

  if (shown.split !== null || others[0] === undefined) return null;
  const next = others[0].id;

  return (
    <IconControl place="bar" aria-label="Split" title={`Split: ${others[0].name} beside it`} onClick={() => shown.setSplit(next)}>
      <SplitHorizontalIcon size={14} />
    </IconControl>
  );
}

/** A machine's Desktop tab: its screen, or what it needs first, said where the screen would be. */
function DesktopPane({ name, desktop }: { name: string; desktop: NonNullable<MachineDesktop> }) {
  if (desktop.kind === "screen") return <DesktopView name={name} src={desktop.src} width={desktop.width} height={desktop.height} />;

  return <div className="p-terminal-ground flex min-h-0 flex-1 flex-col"><DesktopStep name={name} state={desktop.state} detail={desktop.detail} /></div>;
}

/** What each step before a PC's screen says: what is on the PC, and what opens it. */
const DESKTOP_STEPS = {
  setup: (name: string, detail: string | null) => ({ title: `${name} needs one step first`, body: detail ?? "" }),
  permission: (name: string) => ({
    title: `Allow screen sharing on ${name}`,
    body: `A prompt on ${name} asks to share its screen with Kinu. Its screen opens here once it is allowed there.`,
  }),
} satisfies Record<"setup" | "permission", (name: string, detail: string | null) => { readonly title: string; readonly body: ReactNode }>;

function DesktopStep({ name, state, detail }: { name: string; state: "setup" | "permission"; detail: string | null }) {
  const { title, body } = DESKTOP_STEPS[state](name, detail);

  return <Absence icon={DesktopIcon} title={title}>{body}</Absence>;
}

/**
 * A machine's screen under its strip: in the column, or expanded over the workspace area with the rail folded. One
 * frame either way, so expanding moves no client and reconnects nothing. Production f9c17ac7b opened a second client
 * in a new tab instead, on a page that drew it as a thin strip (the owner, 2026-10-14).
 */
function DesktopView({ name, src, width, height }: { name: string; src: string; width: number; height: number }) {
  const title = `${name}'s desktop`;
  const area = useWorkspaceArea();
  const [expanded, setExpanded] = useState(false);
  const cover = useCover(area, expanded);

  const screen = (
    <div style={{ aspectRatio: `${String(width)} / ${String(height)}`, width: `min(100cqw, 100cqh * ${String(width)} / ${String(height)})` }}>
      <DesktopScreen src={src} title={title} />
    </div>
  );

  return (
    <div data-desktop-view={cover === null ? undefined : "expanded"} style={cover ?? undefined}
      className={`p-terminal-ground flex min-h-0 flex-1 flex-col ${cover === null ? "" : "fixed z-40"}`}>
      <div className={`t-meta flex shrink-0 items-center gap-3 pr-3 pl-4 p-text-3 ${cover === null ? "h-9" : "h-11 border-b p-border"}`}>
        {cover !== null && <strong className="inline-flex min-w-0 items-center gap-2 p-text-2"><DesktopIcon size={13} aria-hidden /><span className="truncate">{title}</span></strong>}
        <span className="shrink-0">{String(width)} × {String(height)}</span>
        {area !== null && cover === null && (
          <Button variant="ghost" size="sm" icon={<ArrowsOutIcon size={14} aria-hidden />} data-desktop-expand onClick={() => setExpanded(true)} aria-label={`Expand ${title}`}
            title="Expand over the workspace" className="ml-auto">Expand</Button>
        )}
        {cover !== null && (
          <Button size="sm" icon={<ArrowsInIcon size={14} aria-hidden />} data-desktop-return onClick={() => setExpanded(false)} aria-label="Back to the Environment panel"
            className="ml-auto">Back to panel</Button>
        )}
      </div>
      {/* The screen at its own shape, as large as its place allows, so the client draws it edge to edge; expanded, on
          the screen's own black, as a player letterboxes. */}
      {/* One element expanded or not, so the screen's client is never opened twice. */}
      <div className={`p-desktop-stage flex min-h-0 flex-1 justify-center @container-size ${cover === null ? "items-start" : "items-center"}`}
        data-expanded={cover === null ? undefined : ""}>
        {screen}
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
      <span className="p-dot-pulse"><DesktopIcon size={24} className="p-accent-fg" aria-hidden /></span>
      <div className="space-y-1">
        <p className="t-label p-text">{to === null ? "Restarting" : `Restarting at ${to}`}</p>
        <p className="t-meta p-text-3">Your files stay and services start again; open terminals start fresh.</p>
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
        <div className="space-y-1">
          <p className="t-label p-text">{name} is connected</p>
          <p className="t-meta p-text-2">This workspace can&apos;t use it yet.</p>
        </div>
        <Button variant="primary" size="sm" onClick={() => detach(give)} disabled={giving}>{giving ? "Giving access…" : "Give this workspace access"}</Button>
        {failure !== null && <p className="t-meta p-danger">{failure}</p>}
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
        <p className="t-label p-text">{title}</p>
        <p className="t-meta p-text-2">{children}</p>
      </div>
    </div>
  );
}

const EXECUTION_DOCS = "https://github.com/AshishKumar4/kinu/blob/main/docs/EXECUTION-LAYER-SPEC.md";

function UnavailableMount({ mount, exec }: { mount: EnvironmentInfo; exec: ExecutorInfo | undefined }) {
  const text = mount.name === "computer"
    ? "This deployment has no computer. Use the Workspace shell instead."
    : mount.reason ?? exec?.reason ?? "This environment is not enabled here.";

  return (
    <Absence icon={PlugIcon} title={`${executorLabel(mount.name)} is not available here`}>
      {text}{" "}<a href={EXECUTION_DOCS} target="_blank" rel="noreferrer" className="p-accent-fg hover:underline">Learn more</a>
    </Absence>
  );
}
