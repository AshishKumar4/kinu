/**
 * The machines' terminal sessions (D89): the computer's named sessions, each machine's one shell where it has no more,
 * and the one place a session says where it is, what it serves and how its last command ended. One status language:
 * the dot a machine wears, on a session.
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Effect } from "effect";
import { DesktopIcon, FolderOpenIcon, GitBranchIcon, PlusIcon, XIcon } from "@phosphor-icons/react";
import type { Rpc } from "@kinu.run/core";
import { attempt, detach, renderThrownChain } from "@kinu.run/core/obs";
import type { SessionRecord, TerminalSession } from "@kinu.run/devbox";

/** A read is one exec in the box (about 150 ms there, 10 ms of it tmux, staging 2026-10-13); a few seconds keeps the
 *  marks current while the tab is open, and nothing reads while it is closed or hidden. */
const SESSIONS_EVERY_MS = 3_000;

export type SessionTone = "working" | "ready" | "danger" | "off";

/** A session's state: its dot's tone and its word. */
export interface SessionReading { readonly tone: SessionTone; readonly word: string }

/** Running, done, failed, or not open. */
export function sessionTone(session: TerminalSession): SessionReading {
  if (!session.open) return { tone: "off", word: "Not open" };

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
export function since(at: number, now: number): string {
  const minutes = Math.floor((now - at) / 60_000);

  if (minutes < 1) return "now";

  return minutes < 60 ? `${String(minutes)}m` : `${String(Math.floor(minutes / 60))}h`;
}

export interface ComputerSessions {
  /** Null until the first read answers; empty never, the box keeps one. */
  readonly sessions: readonly TerminalSession[] | null;
  readonly failure: string | null;
  readonly open: () => Effect.Effect<SessionRecord | null>;
  readonly rename: (id: string, name: string) => Effect.Effect<void>;
  readonly close: (id: string) => Effect.Effect<void>;
}

/** The computer's sessions, read while `watching` and the page is visible, and changed by the box's own calls. */
export function useComputerSessions(rpc: Rpc, watching: boolean): ComputerSessions {
  const [sessions, setSessions] = useState<readonly TerminalSession[] | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const live = useRef(true);

  const read = useCallback(() => attempt({ doing: "reading the computer's sessions", otherwise: "io" },
    () => rpc<readonly TerminalSession[] | null>("listComputerSessions")).pipe(
    Effect.map((next) => { if (live.current) { setSessions(next ?? []); setFailure(null); } }),
    Effect.catch((cause) => Effect.sync(() => { if (live.current) setFailure(renderThrownChain({ cause })); })),
  ), [rpc]);

  useEffect(() => {
    live.current = true;

    if (!watching) return () => { live.current = false; };

    const tick = () => { if (document.visibilityState === "visible") detach(read()); };

    const timer = setInterval(tick, SESSIONS_EVERY_MS);

    tick();
    document.addEventListener("visibilitychange", tick);

    return () => {
      live.current = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [watching, read]);

  const call = <T,>(doing: string, method: string, args: unknown[]) => attempt({ doing, otherwise: "io" }, () => rpc<T>(method, args)).pipe(
    Effect.tap(() => read()),
    Effect.catch((cause) => Effect.sync(() => {
      setFailure(renderThrownChain({ cause }));

      return null;
    })),
  );

  return {
    sessions,
    failure,
    open: () => call<SessionRecord | null>("opening a session", "openComputerSession", []),
    rename: (id, name) => call<SessionRecord | null>("renaming a session", "renameComputerSession", [id, name]).pipe(Effect.asVoid),
    close: (id) => call<null>("closing a session", "closeComputerSession", [id]).pipe(Effect.asVoid),
  };
}

function Dot({ tone }: { tone: SessionTone }) {
  return <span aria-hidden className="p-env-dot" data-tone={tone} />;
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
  onOpen: (() => void) | null;
  onRename: (id: string, name: string) => void;
  onClose: (id: string) => void;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);

  return (
    <div className="flex shrink-0 items-end gap-1 border-b p-border pr-2 pl-4">
      <div role="tablist" aria-label={label} className="p-session-tabs">
        {sessions === null && (
          <button type="button" role="tab" aria-selected={current === ONE_SHELL} className="p-session-tab" onClick={() => onChoose(ONE_SHELL)}>
            <Dot tone="ready" />{ONE_SHELL}
          </button>
        )}
        {sessions?.map((session) => {
          const { tone, word } = sessionTone(session);

          return renaming === session.id ? (
            <input key={session.id} autoFocus defaultValue={session.name} aria-label={`Rename ${session.name}`} maxLength={40}
              className="p-session-rename" onBlur={(event) => { setRenaming(null); onRename(session.id, event.currentTarget.value); }}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();

                if (event.key === "Escape") setRenaming(null);
              }} />
          ) : (
            <span key={session.id} className="p-session-tab-slot">
              <button type="button" role="tab" aria-selected={current === session.id} className="p-session-tab" data-session={session.id}
                title={`${session.name}: ${word}. Double-click to rename.`} onClick={() => onChoose(session.id)}
                onDoubleClick={() => setRenaming(session.id)}>
                <Dot tone={tone} />{session.name}
              </button>
              {sessions.length > 1 && (
                <button type="button" aria-label={`Close ${session.name}`} title={`Close ${session.name}: its shell ends`} className="p-session-close"
                  onClick={() => onClose(session.id)}><XIcon size={10} weight="bold" /></button>
              )}
            </span>
          );
        })}
        {desktop && (
          <button type="button" role="tab" aria-selected={current === "desktop"} className="p-session-tab" onClick={onDesktop}>
            <DesktopIcon size={14} aria-hidden />Desktop
          </button>
        )}
      </div>
      {onOpen !== null && (
        <button type="button" aria-label="New session" title="New session" className="p-bar-icon mb-1 shrink-0" onClick={onOpen}>
          <PlusIcon size={14} />
        </button>
      )}
    </div>
  );
}

/** The one place a session says where it is, the branch there, what it serves, and what it runs or last ran. */
export function SessionDetails({ session, name }: { session: TerminalSession | null; name?: string }): ReactNode {
  const now = Date.now();

  if (session === null) return name === undefined ? null : <span className="p-row-text font-medium p-text">{name}</span>;
  const detail = sessionDetail(session, now);
  const failed = session.last !== null && session.last.exit !== 0 && session.running === null;

  return (
    <span className="flex min-w-0 items-center gap-3 p-meta p-text-3">
      {name !== undefined && <span className="inline-flex shrink-0 items-center gap-2 p-row-text font-medium p-text"><Dot tone={sessionTone(session).tone} />{name}</span>}
      <span data-session-cwd className="inline-flex min-w-0 items-center gap-1.5"><FolderOpenIcon size={12} className="shrink-0" aria-hidden /><span className="truncate">{session.cwd}</span></span>
      {session.branch !== null && <span className="hidden min-w-0 items-center gap-1.5 @[24rem]:inline-flex"><GitBranchIcon size={12} className="shrink-0" aria-hidden /><span className="truncate">{session.branch}</span></span>}
      {session.ports.map((port) => <span key={port} data-session-port className="p-term-port shrink-0">:{port}</span>)}
      {detail !== null && <span className={`hidden min-w-0 truncate @[32rem]:inline ${failed ? "p-danger" : ""}`}>{detail}</span>}
    </span>
  );
}

/** Opens a session, then shows it; a refusal stays with the hook's failure. */
export function opening(sessions: ComputerSessions, show: (id: string) => void): void {
  detach(sessions.open().pipe(Effect.map((record) => { if (record !== null) show(record.id); })));
}
