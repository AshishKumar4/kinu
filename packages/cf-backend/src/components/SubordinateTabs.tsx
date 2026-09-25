import { useRef, useState, type ReactNode } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "@cloudflare/kumo";
import { FilledButton } from "./ui/FilledButton";
import { tabCls, tabStripH } from "./ui/form";
import { InlineRenameTitle } from "./WorkspaceBar";
import { CaretDownIcon, CaretRightIcon, HouseIcon, PlusIcon, TrashIcon } from "@phosphor-icons/react";
import type { SubordinateRosterEntry } from "@kinu.run/core/protocol";
import { codenameFor } from "@kinu.run/core";
import { Modal } from "./ui/Modal";
import { renderThrownChain, settleLogged } from "@kinu.run/core/obs";
import { useWheelScrollsSideways } from "@/hooks/use-wheel-scrolls-sideways";


const ADD_AGENT_LABEL = "New agent";

/** A blank name is a pre-codename row; it shows the word pair it would have been born with. */
export function agentTitle(entry: Pick<SubordinateRosterEntry, "name" | "displayName">): string {
  return entry.displayName.trim() || codenameFor(entry.name);
}

interface SubordinateTabsProps {
  workspace: string;
  /** Every retained agent, dismissed included: a dismissed one keeps its conversation, so its tab must stay reachable. */
  subordinates: readonly SubordinateRosterEntry[];
  activeName?: string;
  /** WorkspacePage owns the action and its failure banner: the sidebar can invoke it while this strip is unmounted. */
  onCreate: () => Promise<void>;
  creating: boolean;
  onDismiss: (name: string, keepHistory?: boolean) => Promise<void>;
  onRename: (name: string, displayName: string) => Promise<string>;
  trailing?: ReactNode;
}

function StatusMark({ subordinate }: { subordinate: SubordinateRosterEntry }) {
  const yields = "transition-opacity group-hover/tab:opacity-0 group-has-[[data-tab-delete]:focus-visible]/tab:opacity-0";

  if (subordinate.status === "awaiting_input") {
    return <span className={`rounded-sm px-1.5 py-0.5 p-badge-warning ${yields}`}>input</span>;
  }

  return (
    <span
      className={`size-1.5 shrink-0 rounded-full ${subordinate.status === "working" ? "p-dot-success p-dot-pulse" : "p-dot-neutral"} ${yields}`}
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
  // Open on a dismissed agent, so a deep link finds its tab.
  const dismissed = subordinates.filter((entry) => entry.status === "dismissed");
  const employable = subordinates.filter((entry) => entry.status !== "dismissed");
  const [showDismissed, setShowDismissed] = useState(false);
  const dismissedOpen = showDismissed || dismissed.some((entry) => entry.name === activeName);

  const mainPath = `/workspace/${workspace}`;
  const strip = useRef<HTMLElement>(null);

  useWheelScrollsSideways(strip);

  return (
    <>
      {/* The row draws the bottom rule, which the strip would clip; trailing controls sit outside the strip so they stay put. */}
      <div className={`flex shrink-0 items-stretch border-b p-border ${tabStripH}`}>
        <nav ref={strip} aria-label="Workspace agents" className={`p-tabstrip -mb-px flex min-w-0 flex-1 items-stretch gap-2 px-2 ${tabStripH}`}>
          <Link
            to={mainPath}
            data-agent-tab="main"
            aria-current={!activeName ? "page" : undefined}
            className={`${tabCls} h-full px-3 ${!activeName ? "p-tab-active font-medium" : ""}`}
          >
            <HouseIcon size={13} weight={!activeName ? "fill" : "regular"} className="-translate-y-px" />
            Main
          </Link>
          {employable.map((subordinate) => {
            const active = activeName === subordinate.name;
            const title = agentTitle(subordinate);

            return (
              <div key={subordinate.name} data-agent-tab={subordinate.name} className="group/tab relative shrink-0">
                {active ? (
                  <div aria-current="page" className={`${tabCls} p-tab-active h-full max-w-64 px-3 font-medium`}>
                    <InlineRenameTitle
                      title={title}
                      editValue={subordinate.displayName}
                      onRename={(displayName) => onRename(subordinate.name, displayName)}
                      subject="agent"
                      textClass={`p-t-control p-accent font-medium ${subordinate.displayName ? "" : "italic"}`}
                      pencil={false}
                    />
                    <StatusMark subordinate={subordinate} />
                  </div>
                ) : (
                  <Link
                    to={`${mainPath}/agents/${subordinate.name}`}
                    title={subordinate.currentTask ?? title}
                    className={`${tabCls} h-full max-w-52 px-3`}
                  >
                    <span className={`truncate ${subordinate.displayName ? "" : "italic"}`}>{title}</span>
                    <StatusMark subordinate={subordinate} />
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
                  data-tab-delete
                  className="absolute right-[7.5px] top-[calc(50%-1px)] -translate-y-1/2 rounded-sm p-0.5 opacity-0 p-text-3 transition-all hover:p-danger focus-visible:opacity-100 group-hover/tab:opacity-70 disabled:opacity-40"
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
            // WorkspacePage shows the banner; this keeps the rejection handled.
            onClick={() => settleLogged("subordinates.create_failed", {
              doing: "create a subordinate agent", otherwise: "io",
            }, onCreate)}
            disabled={creating}
            className="p-btn-ghost mb-0.5 ml-2 flex size-7 shrink-0 self-center items-center justify-center disabled:opacity-50"
            title={ADD_AGENT_LABEL}
            aria-label={ADD_AGENT_LABEL}
          >
            <PlusIcon size={14} className={creating ? "animate-pulse" : undefined} />
          </button>
          {dismissed.length > 0 && (
            <button
              type="button"
              onClick={() => setShowDismissed(!dismissedOpen)}
              aria-expanded={dismissedOpen}
              className={`${tabCls} h-full shrink-0 px-2.5`}
              title="Agents no longer taking work. Their conversations are kept."
            >
              {dismissedOpen ? <CaretDownIcon size={11} /> : <CaretRightIcon size={11} />}
              Dismissed ({dismissed.length})
            </button>
          )}
        </nav>
        {trailing && (
          <div className="flex shrink-0 items-center gap-2 pl-2 pr-3">{trailing}</div>
        )}
      </div>
      {dismissed.length > 0 && dismissedOpen && (
        // A row, not tabs: these agents take no work. The link keeps a dismissed agent's conversation reachable.
        <div className="flex shrink-0 flex-wrap items-center gap-2 border-b p-border px-3 py-1.5">
          <span className="p-eyebrow p-text-4">Dismissed</span>
          {dismissed.map((subordinate) => (
            <Link
              key={subordinate.name}
              data-agent-tab={subordinate.name}
              to={`${mainPath}/agents/${subordinate.name}`}
              aria-current={activeName === subordinate.name ? "page" : undefined}
              title={`Open ${agentTitle(subordinate)}'s kept conversation`}
              className={`inline-flex max-w-52 items-center gap-1.5 rounded-sm px-1.5 py-0.5 p-row-text ${
                activeName === subordinate.name ? "p-accent font-medium" : "p-text-3 hover:p-text"
              }`}
            >
              <span className="size-1.5 shrink-0 rounded-full p-dot-neutral opacity-60" aria-hidden />
              <span className="truncate">{agentTitle(subordinate)}</span>
            </Link>
          ))}
        </div>
      )}

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
