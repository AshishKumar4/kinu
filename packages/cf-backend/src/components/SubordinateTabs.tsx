import { useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "@cloudflare/kumo";
import { FilledButton } from "./ui/FilledButton";
import { tabCls, tabStripH } from "./ui/form";
import { InlineRenameTitle } from "./WorkspaceBar";
import { HouseIcon, PlusIcon, TrashIcon } from "@phosphor-icons/react";
import type { SubordinateRosterEntry } from "@kinu.run/core/protocol";
import { codenameFor } from "@kinu.run/core";
import { Modal } from "./ui/Modal";
import { diagnostics, toKinuError, renderThrownChain } from "@kinu.run/core/obs";

/* A workspace's title is answered in core — `workspaceDisplayTitle` in
 * read-models/workspace-title — because the slug stored as a title is the
 * defect this file's callers all share; there is no local copy of the rule. */

/** The plus button's label: an ACTION, never a name. */
const ADD_AGENT_LABEL = "New agent";

/** A roster entry's shown name. An agent is born with its slug's codename,
 *  so a blank here is a row from before codenames and shows the same word
 *  pair it would have been born with. */
export function agentTitle(entry: Pick<SubordinateRosterEntry, "name" | "displayName">): string {
  return entry.displayName.trim() || codenameFor(entry.name);
}

interface SubordinateTabsProps {
  workspace: string;
  subordinates: readonly SubordinateRosterEntry[];
  activeName?: string;
  /** One-click create — identity only, no form. WorkspacePage owns the action
   *  and its failure banner because the sidebar can invoke it while this strip
   *  is not mounted. */
  onCreate(): Promise<void>;
  creating: boolean;
  onDismiss(name: string, keepHistory?: boolean): Promise<void>;
  /** Retitle the open agent from its own tab; resolves to the saved title. */
  onRename(name: string, displayName: string): Promise<string>;
  /** Controls for the conversation this strip has open, pinned to its right
   *  edge — the chat column has no other chrome row to hang them on. */
  trailing?: ReactNode;
}

function StatusMark({ subordinate }: { subordinate: SubordinateRosterEntry }) {
  if (subordinate.status === "awaiting_input") {
    return <span className="rounded-sm px-1.5 py-0.5 p-badge-warning">input</span>;
  }

  return (
    <span
      className={`size-1.5 shrink-0 rounded-full ${subordinate.status === "working" ? "p-dot-success p-dot-pulse" : "p-dot-neutral"}`}
      aria-label={subordinate.status === "working" ? "Working" : "Idle"}
    />
  );
}


export function SubordinateTabs({
  workspace, subordinates, activeName, onCreate, creating, onDismiss, onRename, trailing,
}: SubordinateTabsProps) {
  const navigate = useNavigate();
  const [dismissTarget, setDismissTarget] = useState<SubordinateRosterEntry | null>(null);
  const [dismissing, setDismissing] = useState(false);
  const [dismissError, setDismissError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const mainPath = `/workspace/${workspace}`;

  return (
    <>
      {/* One tab grammar with the work surfaces: a bottom edge, not a box.

          The ROW owns the rule and the strip reaches one pixel over it, so the
          open tab's bar lands ON that rule and the two read as one line. The
          rule cannot live on the strip itself: the strip clips vertically —
          a tab's overhang is enough to raise a scrollbar beside a single row
          of tabs — and a bar drawn past the strip's own edge is clipped away.
          `h-full` with `items-stretch` makes each tab the strip's own height,
          so the bar stays inside the box the strip shows.

          The trailing controls are a SIBLING of the strip, not content inside
          it: the strip scrolls horizontally once the roster outgrows the
          column, and anything within it scrolls away with the tabs. The row's
          rule runs under both, so the two still read as one line. */}
      <div className={`flex shrink-0 items-stretch border-b p-border ${tabStripH}`}>
        <nav aria-label="Workspace agents" className={`p-tabstrip -mb-px flex min-w-0 flex-1 items-stretch gap-2 px-2 ${tabStripH}`}>
          <Link
            to={mainPath}
            data-agent-tab="main"
            aria-current={!activeName ? "page" : undefined}
            className={`${tabCls} h-full px-3 ${!activeName ? "p-tab-active font-medium" : ""}`}
          >
            <HouseIcon size={13} weight={!activeName ? "fill" : "regular"} />
            Main
          </Link>
          {subordinates.map((subordinate) => {
            const active = activeName === subordinate.name;
            const title = agentTitle(subordinate);

            return (
              <div key={subordinate.name} data-agent-tab={subordinate.name} className="group/tab relative shrink-0">
                {active ? (
                  // The open tab is not a link anywhere; it is where the agent is renamed.
                  <div aria-current="page" className={`${tabCls} p-tab-active h-full max-w-64 pl-3 pr-8 font-medium`}>
                    {/* The mounting row names the colour its title reads in,
                        so the open tab hands the rename control its accent. An
                        agent still under its codename keeps the italic; a lit
                        tab never prints its name muted. */}
                    <InlineRenameTitle
                      title={title}
                      editValue={subordinate.displayName}
                      onRename={(displayName) => onRename(subordinate.name, displayName)}
                      subject="agent"
                      textClass={`p-t-control p-accent font-medium ${subordinate.displayName ? "" : "italic"}`}
                    />
                    <StatusMark subordinate={subordinate} />
                  </div>
                ) : (
                  <Link
                    to={`${mainPath}/agents/${subordinate.name}`}
                    title={subordinate.currentTask ?? title}
                    className={`${tabCls} h-full max-w-52 pl-3 pr-8 p-text-3`}
                  >
                    <span className={`truncate ${subordinate.displayName ? "" : "italic p-text-3"}`}>{title}</span>
                  </Link>
                )}
                <button
                  type="button"
                  disabled={deleting === subordinate.name}
                  onClick={async () => {
                    if (subordinate.createdBy === "user") {
                      setDeleteError(null);
                      setDeleting(subordinate.name);

                      try {
                        await onDismiss(subordinate.name, false);

                        if (subordinate.name === activeName) await navigate(mainPath);
                      } catch (cause) {
                        setDeleteError(renderThrownChain({ cause }));
                      } finally {
                        setDeleting(null);
                      }

                      return;
                    }

                    setDismissError(null);
                    setDismissTarget(subordinate);
                  }}
                  className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-sm p-1 opacity-0 p-text-3 transition-all hover:p-danger focus-visible:opacity-100 group-hover/tab:opacity-70 disabled:opacity-40"
                  title={subordinate.createdBy === "user" ? `Delete ${title}` : `Dismiss ${title}`}
                  aria-label={subordinate.createdBy === "user" ? `Delete ${title}` : `Dismiss ${title}`}
                >
                  <TrashIcon size={11} />
                </button>
              </div>
            );
          })}
          <button
            type="button"
            onClick={async () => {
              try {
                await onCreate();
              } catch (cause) {
                // WorkspacePage shows the failure banner; this catch owns the
                // strip's own click, so a parent that rejects is recorded
                // rather than becoming an unhandled rejection with no context.
                diagnostics.failure("subordinates.create_failed", toKinuError({
                  doing: "create a subordinate agent", cause, otherwise: "io",
                }));
              }
            }}
            disabled={creating}
            className="p-btn-ghost my-1 ml-2 flex size-7 shrink-0 self-center items-center justify-center disabled:opacity-50"
            title={ADD_AGENT_LABEL}
            aria-label={ADD_AGENT_LABEL}
          >
            <PlusIcon size={14} className={creating ? "animate-pulse" : undefined} />
          </button>
        </nav>
        {trailing && (
          <div className="flex shrink-0 items-center gap-2 pl-2 pr-3">{trailing}</div>
        )}
      </div>

      {dismissTarget && dismissTarget.createdBy !== "user" && (
        <Modal
          title={`Dismiss ${agentTitle(dismissTarget)}?`}
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

                  if (dismissTarget.name === activeName) await navigate(mainPath);
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
          {/* What this button does, and what it does NOT do. The copy names no
              second action: an agent's own helper has no delete here, and
              "deleting would…" described a control the reader cannot reach. */}
          <p className="text-xs leading-relaxed p-text-2">
            Dismissing closes the tab and stops this agent being given work. Its conversation is kept, not deleted.
          </p>
          {dismissError && <div role="alert" className="rounded-md px-2.5 py-2 text-xs p-notice-danger">{dismissError}</div>}
        </Modal>
      )}
      {deleteError && (
        <div role="alert" className="mx-2 mb-1 rounded-md px-2.5 py-2 text-xs p-notice-danger">{deleteError}</div>
      )}
    </>
  );
}
