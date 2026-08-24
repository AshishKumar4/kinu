import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "@cloudflare/kumo";
import { FilledButton } from "./ui/FilledButton";
import { HouseIcon, PlusIcon, TrashIcon } from "@phosphor-icons/react";
import type { SubordinateRosterEntry } from "@kinu.run/core";
import { Modal } from "./ui/Modal";
import { renderThrownChain } from "@kinu.run/core/obs";

/** What an agent with no name yet is called everywhere one renders. */
export const NEW_AGENT_TITLE = "New agent";

/** A roster entry's shown name. Blank means created-but-untitled: the
 *  first-message titler (or the owner's rename) fills it in, and until then
 *  every surface says the same thing instead of an empty string. */
export function agentTitle(displayName: string): string {
  return displayName.trim() === "" ? NEW_AGENT_TITLE : displayName;
}

interface CreatedAgent {
  name: string;
  displayName: string;
}

interface SubordinateTabsProps {
  workspace: string;
  subordinates: readonly SubordinateRosterEntry[];
  activeName?: string;
  /** One-click create — identity only, no form. The agent arrives idle with a
   *  blank name; its inherited mission is internal and never shown. The strip
   *  opens the new conversation itself. */
  onCreate(): Promise<CreatedAgent>;
  onDismiss(name: string): Promise<void>;
  /** Controls for the conversation this strip has open, pinned to its right
   *  edge — the chat column has no other chrome row to hang them on. */
  trailing?: ReactNode;
}

function StatusMark({ subordinate }: { subordinate: SubordinateRosterEntry }) {
  if (subordinate.status === "awaiting_input") {
    return <span className="rounded-sm px-1.5 py-0.5 text-[9px] font-medium p-badge-warning">input</span>;
  }
  return (
    <span
      className={`size-1.5 shrink-0 rounded-full ${subordinate.status === "working" ? "p-dot-success p-dot-pulse" : "p-dot-neutral"}`}
      aria-label={subordinate.status === "working" ? "Working" : "Idle"}
    />
  );
}

export function SubordinateTabs({ workspace, subordinates, activeName, onCreate, onDismiss, trailing }: SubordinateTabsProps) {
  const navigate = useNavigate();
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  // Re-entrancy fence for the two doors into one flow (the strip's + and the
  // sidebar's row): state renders the spinner, the ref refuses the double.
  const creatingRef = useRef(false);
  const [dismissTarget, setDismissTarget] = useState<SubordinateRosterEntry | null>(null);
  const [dismissing, setDismissing] = useState(false);
  const [dismissError, setDismissError] = useState<string | null>(null);

  const mainPath = `/workspace/${workspace}`;
  const createAndOpen = useCallback(async () => {
    if (creatingRef.current) return;
    creatingRef.current = true;
    setCreating(true);
    setCreateError(null);
    try {
      const created = await onCreate();
      navigate(`${mainPath}/agents/${created.name}`);
    } catch (cause) {
      setCreateError(renderThrownChain({ cause: cause }));
    } finally {
      creatingRef.current = false;
      setCreating(false);
    }
  }, [mainPath, navigate, onCreate]);

  // The sidebar's "+ New agent" row is the second door into this same flow —
  // it has no socket of its own, so it asks the mounted strip over a window
  // event rather than duplicating the create+open sequence.
  useEffect(() => {
    const h = () => { void createAndOpen(); };
    window.addEventListener("kinu:new-agent", h);
    return () => window.removeEventListener("kinu:new-agent", h);
  }, [createAndOpen]);

  return (
    <>
      {/* One tab grammar with the work surfaces: a bottom edge, not a box.
          `-mb-px` puts the active bar on the strip's own rule so the two
          read as one line rather than two.

          The trailing controls are a SIBLING of the strip, not content inside
          it: the strip scrolls horizontally once the roster outgrows the
          column, and anything within it scrolls away with the tabs. They carry
          the same bottom rule so the two still read as one line. */}
      <div className="flex shrink-0 items-stretch">
        <nav aria-label="Workspace agents" className="p-tabstrip flex min-w-0 flex-1 items-stretch border-b p-border px-2">
          <Link
            to={mainPath}
            aria-current={!activeName ? "page" : undefined}
            className={`p-tab -mb-px flex shrink-0 items-center gap-1.5 px-3 py-2 text-xs transition-colors ${!activeName ? "p-tab-active font-medium" : ""}`}
          >
            <HouseIcon size={13} weight={!activeName ? "fill" : "regular"} />
            Main
          </Link>
          {subordinates.map((subordinate) => {
            const active = activeName === subordinate.name;
            const title = agentTitle(subordinate.displayName);
            return (
              <div key={subordinate.name} className="group/tab relative shrink-0">
                <Link
                  to={`${mainPath}/agents/${subordinate.name}`}
                  aria-current={active ? "page" : undefined}
                  title={subordinate.currentTask ?? title}
                  className={`p-tab -mb-px flex h-full max-w-52 items-center gap-2 py-2 pl-3 pr-8 text-xs transition-colors ${active ? "p-tab-active font-medium" : ""}`}
                >
                  <span className={`truncate ${subordinate.displayName ? "" : "italic p-text-3"}`}>{title}</span>
                  <StatusMark subordinate={subordinate} />
                </Link>
                <button
                  type="button"
                  onClick={() => { setDismissError(null); setDismissTarget(subordinate); }}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-sm p-1 opacity-0 p-text-3 transition-all hover:p-danger focus-visible:opacity-100 group-hover/tab:opacity-70"
                  title={`Dismiss ${title}`}
                  aria-label={`Dismiss ${title}`}
                >
                  <TrashIcon size={11} />
                </button>
              </div>
            );
          })}
          <button
            type="button"
            onClick={() => { void createAndOpen(); }}
            disabled={creating}
            className="p-btn-ghost my-1 ml-1 flex size-7 shrink-0 self-center items-center justify-center disabled:opacity-50"
            title={NEW_AGENT_TITLE}
            aria-label={NEW_AGENT_TITLE}
          >
            <PlusIcon size={14} className={creating ? "animate-pulse" : undefined} />
          </button>
          {createError && (
            <button
              type="button"
              role="alert"
              onClick={() => setCreateError(null)}
              className="my-1 ml-1 max-w-64 shrink-0 self-center truncate rounded-md px-2 py-1 text-[11px] p-notice-danger"
              title={`Couldn't create an agent: ${createError} — click to dismiss`}
            >
              Couldn't create an agent
            </button>
          )}
        </nav>
        {trailing && (
          <div className="flex shrink-0 items-center gap-2 border-b p-border pl-2 pr-3">{trailing}</div>
        )}
      </div>

      {dismissTarget && (
        <Modal
          title={`Dismiss ${agentTitle(dismissTarget.displayName)}?`}
          icon={<TrashIcon size={18} className="p-danger" />}
          onClose={() => setDismissTarget(null)}
          busy={dismissing}
          footer={<>
            <Button size="sm" variant="ghost" disabled={dismissing} onClick={() => setDismissTarget(null)}>Cancel</Button>
            <FilledButton danger disabled={dismissing}
              onClick={async () => {
                setDismissing(true);
                setDismissError(null);
                try {
                  await onDismiss(dismissTarget.name);
                  if (dismissTarget.name === activeName) navigate(mainPath);
                  setDismissTarget(null);
                } catch (cause) {
                  setDismissError(renderThrownChain({ cause: cause }));
                } finally {
                  setDismissing(false);
                }
              }}
            >
              {dismissing ? "Dismissing…" : "Dismiss"}
            </FilledButton>
          </>}
        >
          <p className="text-xs leading-relaxed p-text-2">
            This archives the agent and removes its tab. Its conversation and private state are preserved.
          </p>
          {dismissError && <div role="alert" className="rounded-md px-2.5 py-2 text-xs p-notice-danger">{dismissError}</div>}
        </Modal>
      )}
    </>
  );
}
