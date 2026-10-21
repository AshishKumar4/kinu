/**
 * The machines' terminal sessions (D90): the computer's named sessions, each machine's one shell where it has no more,
 * and the one place a session says where it is, what it serves and how its last command ended. One status language:
 * the dot a machine wears, on a session.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Effect } from "effect";
import { DesktopIcon, FolderOpenIcon, GitBranchIcon, PlusIcon, SparkleIcon, XIcon } from "@phosphor-icons/react";
import { attempt, detach, renderThrownChain } from "@kinu.run/core/obs";
import type { SessionRecord, TerminalSession } from "@kinu.run/devbox";
import type { WorkspaceRpc } from "@/lib/workspace-rpc";
import { IconControl } from "@/components/ui/IconControl";
import { SessionButton, SessionRename } from "@/components/ui/SessionTabs";

/** A read is one exec in the box (about 150 ms there, 10 ms of it tmux, staging 2026-10-13); a few seconds keeps the
 *  marks current while the tab is open, and nothing reads while it is closed or hidden. */
const SESSIONS_EVERY_MS = 3_000;

type SessionTone = "working" | "ready" | "danger" | "off" | "attention";

/** A session's state: its dot's tone and its word. */
interface SessionReading { readonly tone: SessionTone; readonly word: string }

/** Waiting for an answer, running, done, failed, or not open. */
function sessionTone(session: TerminalSession): SessionReading {
  if (!session.open) return { tone: "off", word: "Not open" };

  if (session.needsInput) return { tone: "attention", word: "Needs input" };

  if (session.running !== null) return { tone: "working", word: "Running" };

  if (session.last !== null && session.last.exit !== 0) return { tone: "danger", word: "Failed" };

  return { tone: "ready", word: session.last === null ? "Ready" : "Done" };
}

/** What a session is doing or last did, in words. */
function sessionDetail(session: TerminalSession, now: number): string | null {
  if (session.running !== null) return session.running;

  if (session.last === null || session.last.command === "") return null;

  return `${session.last.command} · ${since(session.last.at, now)}`;
}

/** How long ago, as a row has room for: now, minutes, hours. */
function since(at: number, now: number): string {
  const minutes = Math.floor((now - at) / 60_000);

  if (minutes < 1) return "now";

  return minutes < 60 ? `${String(minutes)}m` : `${String(Math.floor(minutes / 60))}h`;
}

export interface MachineSessions {
  /** Null until the first read answers; empty never, the box and a PC's daemon each keep one. */
  readonly sessions: readonly TerminalSession[] | null;
  readonly failure: string | null;
  readonly open: () => Effect.Effect<SessionRecord | null>;
  readonly rename: (id: string, name: string) => Effect.Effect<void>;
  readonly close: (id: string) => Effect.Effect<void>;
}

/** A machine's sessions: the computer's, or the PC `device`'s (1014-t), read while `watching` and the page is visible,
 *  and changed by that machine's own calls. */
export function useMachineSessions(rpc: WorkspaceRpc, watching: boolean, device: string | null): MachineSessions {
  const [sessions, setSessions] = useState<readonly TerminalSession[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const live = useRef(true);

  const read = useCallback(() => attempt({ doing: device === null ? "reading the computer's sessions" : "reading the PC's sessions", otherwise: "io" },
    () => (device === null ? rpc("listComputerSessions", []) : rpc("listDeviceSessions", [device]))).pipe(
    Effect.map((next) => { if (live.current) { setSessions(next ?? []); setFailure(null); } }),
    Effect.catch((cause) => Effect.sync(() => { if (live.current) setFailure(renderThrownChain({ cause })); })),
  ), [rpc, device]);

  // Only a page someone can see reads, and one read at a time: a slow box never stacks them.
  const reading = useRef(false);

  const readSeen = useCallback(() => Effect.suspend(() => {
    if (document.visibilityState !== "visible" || reading.current) return Effect.void;

    reading.current = true;

    return read().pipe(Effect.ensuring(Effect.sync(() => { reading.current = false; })));
  }), [read]);

  useEffect(() => {
    live.current = true;

    if (!watching) return () => { live.current = false; };

    const stop = new AbortController();
    const timer = setInterval(() => detach(readSeen()), SESSIONS_EVERY_MS);

    detach(readSeen());
    document.addEventListener("visibilitychange", () => detach(readSeen()), { signal: stop.signal });

    return () => {
      live.current = false;
      clearInterval(timer);
      stop.abort();
    };
  }, [watching, readSeen]);

  const call = <T,>(doing: string, change: () => Promise<T>) => attempt({ doing, otherwise: "io" }, change).pipe(
    Effect.tap(() => read()),
    Effect.catch((cause) => Effect.sync(() => {
      setFailure(renderThrownChain({ cause }));

      return null;
    })),
  );

  return {
    sessions,
    failure,
    open: () => call("opening a session", () => (device === null ? rpc("openComputerSession", []) : rpc("openDeviceSession", [device]))),
    rename: (id, name) => call("renaming a session", () => (device === null ? rpc("renameComputerSession", [id, name]) : rpc("renameDeviceSession", [device, id, name]))).pipe(Effect.asVoid),
    close: (id) => call("closing a session", () => (device === null ? rpc("closeComputerSession", [id]) : rpc("closeDeviceSession", [device, id]))).pipe(Effect.asVoid),
  };
}

function Dot({ tone }: { tone: SessionTone }) {
  return <span aria-hidden className="p-env-dot" data-tone={tone} />;
}

/** A session an agent's job runs in (D95), beside the person's own. */
function AgentMark() {
  return <span title="Started by the agent" className="inline-flex shrink-0"><SparkleIcon size={11} weight="fill" className="p-accent-mark" aria-label="Started by the agent" /></span>;
}

/** A machine's one shell, where it keeps no sessions of its own: the workspace's, a PC's. */
export const ONE_SHELL = "shell";

/**
 * The machine's sessions as tabs, then its screen, then a new session: a name and its dot each. A tab renames on a
 * double press, and closes from its ×, while the machine keeps another.
 */
export function SessionTabs({ label, sessions, current, desktop, onChoose, onDesktop, onOpen, onRename, onClose }: {
  label: string;
  /** Null for a machine with one shell. */
  sessions: readonly TerminalSession[] | null;
  /** The open tab: a session's id, `desktop`, or the one shell's. */
  current: string;
  desktop: boolean;
  onChoose: (id: string) => void;
  onDesktop: () => void;
  onOpen: (() => Effect.Effect<void>) | null;
  onRename: (id: string, name: string) => Effect.Effect<void>;
  onClose: (id: string) => Effect.Effect<void>;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const strip = useRef<HTMLDivElement>(null);
  const hidden = useHiddenEdges(strip, `${current}:${String(sessions?.length ?? 0)}`);

  return (
    <div className="flex shrink-0 items-end gap-1 border-b p-border pr-2 pl-4">
      {/* Scrolls sideways when the tabs outrun the column: a wheel turns it, and a fade marks the side with more. */}
      <div ref={strip} role="tablist" aria-label={label} className="p-session-tabs"
        data-hidden-start={hidden.start || undefined} data-hidden-end={hidden.end || undefined}
        onWheel={(event) => { if (Math.abs(event.deltaY) > Math.abs(event.deltaX)) event.currentTarget.scrollLeft += event.deltaY; }}>
        {sessions === null && (
          <SessionButton part="tab" aria-selected={current === ONE_SHELL} onClick={() => onChoose(ONE_SHELL)}>
            <Dot tone="ready" />{ONE_SHELL}
          </SessionButton>
        )}
        {sessions?.map((session) => {
          const { tone, word } = sessionTone(session);

          return renaming === session.id ? (
            <SessionRename key={session.id} autoFocus defaultValue={session.name} aria-label={`Rename ${session.name}`} maxLength={40}
              onBlur={(event) => { setRenaming(null); detach(onRename(session.id, event.currentTarget.value)); }}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();

                if (event.key === "Escape") setRenaming(null);
              }} />
          ) : (
            <span key={session.id} className="p-session-tab-slot">
              <SessionButton part="tab" aria-selected={current === session.id} data-session={session.id}
                title={`${session.name}: ${word}. Double-click to rename.`} onClick={() => onChoose(session.id)}
                onDoubleClick={() => setRenaming(session.id)}>
                <Dot tone={tone} />{session.job !== undefined && <AgentMark />}{session.name}
              </SessionButton>
              {sessions.length > 1 && (
                <SessionButton part="close" aria-label={`Close ${session.name}`} title={`Close ${session.name}: its shell ends`}
                  onClick={() => detach(onClose(session.id))}><XIcon size={10} weight="bold" /></SessionButton>
              )}
            </span>
          );
        })}
        {desktop && (
          <SessionButton part="tab" aria-selected={current === "desktop"} onClick={onDesktop}>
            <DesktopIcon size={14} aria-hidden />Desktop
          </SessionButton>
        )}
      </div>
      {onOpen !== null && (
        <IconControl place="bar" className="mb-1 shrink-0" aria-label="New session" title="New session" onClick={() => detach(onOpen())}>
          <PlusIcon size={14} />
        </IconControl>
      )}
    </div>
  );
}

/** Room kept at a scrolled edge for its fade, so a tab brought into view clears it. */
const EDGE_FADE_PX = 40;

/**
 * Which ends of a sideways strip hide tabs, and the chosen tab brought into view each time `shown` changes: a tab
 * chosen or opened past the column's edge (a new session lands last) is never left behind the fade.
 */
function useHiddenEdges(strip: RefObject<HTMLDivElement | null>, shown: string): { start: boolean; end: boolean } {
  const [edges, setEdges] = useState({ start: false, end: false });

  useLayoutEffect(() => {
    const element = strip.current;
    const chosen = element?.querySelector<HTMLElement>('[aria-selected="true"]');

    if (element === null || chosen === null || chosen === undefined) return;
    // Measured on screen: a tab sits in its own positioned slot, so its offsets are its slot's, not the strip's.
    const left = chosen.getBoundingClientRect().left - element.getBoundingClientRect().left + element.scrollLeft;
    const right = left + chosen.getBoundingClientRect().width;

    if (left < element.scrollLeft + EDGE_FADE_PX) element.scrollLeft = Math.max(0, left - EDGE_FADE_PX);
    else if (right > element.scrollLeft + element.clientWidth - EDGE_FADE_PX) element.scrollLeft = right - element.clientWidth + EDGE_FADE_PX;
  }, [strip, shown]);

  useEffect(() => {
    const element = strip.current;

    if (element === null) return undefined;
    const read = () => setEdges({ start: element.scrollLeft > 1, end: element.scrollLeft + element.clientWidth < element.scrollWidth - 1 });
    const observer = new ResizeObserver(read);

    read();
    observer.observe(element);
    element.addEventListener("scroll", read, { passive: true });

    return () => {
      observer.disconnect();
      element.removeEventListener("scroll", read);
    };
  }, [strip, shown]);

  return edges;
}

/** The one place a session says where it is, the branch there, what it serves, and what it runs or last ran. */
export function SessionDetails({ session, name }: { session: TerminalSession | null; name?: string }): ReactNode {
  const now = Date.now();

  if (session === null) return name === undefined ? null : <span className="t-item p-text">{name}</span>;
  const detail = sessionDetail(session, now);
  const failed = session.last !== null && session.last.exit !== 0 && session.running === null;

  return (
    <span className="t-meta flex min-w-0 items-center gap-3 p-text-3">
      {name !== undefined && <span className="t-item inline-flex shrink-0 items-center gap-2 p-text"><Dot tone={sessionTone(session).tone} />{name}</span>}
      {/* A narrow pane keeps its ports and state: the branch goes first, then the folder shows its last part. The text
          holds both forms, so the folder itself is named on the element. */}
      <span data-session-cwd={session.cwd} title={session.cwd} className="inline-flex min-w-0 items-center gap-2">
        <FolderOpenIcon size={12} className="shrink-0" aria-hidden />
        <span className="hidden truncate @[34rem]:inline">{session.cwd}</span>
        <span className="truncate @[34rem]:hidden">{folderTail(session.cwd)}</span>
      </span>
      {session.branch !== null && <span className="hidden min-w-0 items-center gap-2 @[38rem]:inline-flex"><GitBranchIcon size={12} className="shrink-0" aria-hidden /><span className="truncate">{session.branch}</span></span>}
      {session.ports.map((port) => <span key={port} data-session-port className="p-term-port shrink-0">:{port}</span>)}
      {session.needsInput && <span data-session-waiting className="shrink-0 font-medium p-warning">Waiting for input</span>}
      {detail !== null && <span className={`hidden min-w-0 truncate @[42rem]:inline ${failed ? "p-danger" : ""}`}>{detail}</span>}
    </span>
  );
}

/** A folder's last part, `…/dashboard`; the root and a top-level folder as they are. */
function folderTail(cwd: string): string {
  const parts = cwd.split("/").filter((part) => part !== "");

  return parts.length <= 1 ? cwd : `…/${parts.at(-1) ?? ""}`;
}

/** Opens a session, then shows it; a refusal stays with the hook's failure. */
export function openSession(sessions: MachineSessions, show: (id: string) => void): Effect.Effect<void> {
  return sessions.open().pipe(Effect.map((record) => { if (record !== null) show(record.id); }));
}
