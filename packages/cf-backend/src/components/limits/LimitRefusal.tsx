/**
 * A free account's limit met at the moment of the ask (the owner's board, limit A): a dialog where the new workspace,
 * computer or upload was asked for, saying what is full and the ways on. Shown by whichever page asked, through the
 * layout's one provider, so every page offers the same.
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { WarningIcon } from "@phosphor-icons/react";
import { APP_ROUTES, shownBytes } from "@kinu.run/core";
import { limitRefusalOf, type LimitRefusal } from "@/lib/limits-api";
import { useWorkspaceRosterIfAny } from "@/hooks/use-workspace-roster";
import { Modal } from "@/components/ui/Modal";
import { Button, buttonClass } from "@/components/ui/Button";
import { dayTurnsAt, MoveMyData, RunYourOwn } from "./limit-words";

/** What the page knows of the ask beside the refusal: an upload's file. */
export interface AskedFor {
  readonly file?: { readonly name: string; readonly size: number };
}

/** A refusal as its dialog says it. */
interface Said {
  readonly title: string;
  readonly body: string;
  /** The screen's own way on: where to make room. */
  readonly room?: { readonly label: string; readonly to: string };
}

function day(text: string): string {
  const resets = /start again on (\d{4}-\d{2}-\d{2})/u.exec(text)?.[1];

  return resets === undefined ? "next month" : new Date(`${resets}T00:00:00Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
}

/** The computer's two refusals, told apart by the limits' own words (core limits/ `admitComputerStart`). */
function computerSaid(text: string, titled: (workspace: string) => string): Said {
  const elsewhere = /running in (\S+?)\. /u.exec(text)?.[1];

  if (elsewhere !== undefined) {
    return {
      title: `Your free computer is running in ${titled(elsewhere)}`,
      body: "Stop it there to start one here. Chats keep working without the computer. On your own Kinu every workspace has its own.",
      room: { label: `Open ${titled(elsewhere)}`, to: `/workspace/${encodeURIComponent(elsewhere)}` },
    };
  }

  const hours = /their free (\d+) hours/u.exec(text)?.[1] ?? "20";

  return {
    title: `This month's ${hours} computer hours are used`,
    body: `Your files stay where they are, and chats keep working without the computer. It starts again ${day(text)}. On your own Kinu the computer is yours.`,
  };
}

function said(refusal: LimitRefusal, asked: AskedFor, titled: (workspace: string) => string): Said {
  switch (refusal.limit) {
    case "workspaces": {
      const count = /has its (\d+) free workspaces/u.exec(refusal.text)?.[1] ?? "3";

      return {
        title: `You have ${count} workspaces, the most a free account holds`,
        body: "They all keep working. To start another, remove one you're done with, or run your own Kinu: no limits, on your own Cloudflare account.",
        room: { label: "Manage workspaces", to: APP_ROUTES.workspaces },
      };
    }

    case "stored_bytes": {
      const used = /stores ([\d.]+ [GM]B)/u.exec(refusal.text)?.[1];
      const cap = /past its free ([\d.]+ [GM]B)/u.exec(refusal.text)?.[1] ?? "2 GB";
      const file = asked.file;

      return {
        title: file === undefined ? `Your storage is past its free ${cap}` : `${file.name} would take you past ${cap}`,
        body: `${used === undefined ? "Your storage is full" : `${used} is used`}${file === undefined ? "" : ` and ${file.name} is ${shownBytes(file.size)}`}. Free some space in Drive, or run your own Kinu: its storage is your Cloudflare account's.`,
        room: { label: "Open Drive", to: APP_ROUTES.drive },
      };
    }

    case "computer":
      return computerSaid(refusal.text, titled);
    case "model_tokens":
      return { title: "Today's Kinu models are used up", body: `Add your own key to go on now, or they start again at ${dayTurnsAt()}.` };
    case "suspended":
      return { title: "This account is suspended", body: refusal.text };
  }
}

function RefusalDialog({ refusal, asked, onClose }: { refusal: LimitRefusal; asked: AskedFor; onClose: () => void }) {
  const roster = useWorkspaceRosterIfAny();
  const titled = (workspace: string) => roster?.entries.find((entry) => entry.name === workspace)?.displayName ?? workspace;
  const { title, body, room } = said(refusal, asked, titled);

  return (
    <Modal title={title} icon={<WarningIcon size={16} className="p-warning" />} width="md" maxWidthClass="max-w-xl" onClose={onClose}
      footer={(
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>Not now</Button>
          {room !== undefined && <Link to={room.to} onClick={onClose} className={buttonClass({ size: "sm" })}>{room.label}</Link>}
          {refusal.limit !== "suspended" && <MoveMyData onGo={onClose} />}
          {refusal.limit !== "suspended" && <RunYourOwn />}
        </>
      )}>
      <p className="t-body p-text-2" data-limit-refusal={refusal.limit}>{body}</p>
    </Modal>
  );
}

/**
 * Whether the failure was one of the account's limits, shown as its dialog if so: true then, and the page says nothing
 * more; false for any other failure, which the page says as it always has.
 */
type OfferRefusal = (failed: { readonly cause: unknown }, asked?: AskedFor) => boolean;

const LimitRefusalContext = createContext<OfferRefusal>(() => false);

export function useLimitRefusal(): OfferRefusal {
  return useContext(LimitRefusalContext);
}

export function LimitRefusalProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<{ readonly refusal: LimitRefusal; readonly asked: AskedFor } | null>(null);

  const offer = useCallback<OfferRefusal>((failed, asked = {}) => {
    const refusal = limitRefusalOf(failed);

    if (refusal === null) return false;
    setOpen({ refusal, asked });

    return true;
  }, []);

  const value = useMemo(() => offer, [offer]);

  return (
    <LimitRefusalContext.Provider value={value}>
      {children}
      {open !== null && <RefusalDialog refusal={open.refusal} asked={open.asked} onClose={() => setOpen(null)} />}
    </LimitRefusalContext.Provider>
  );
}
