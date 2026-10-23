/**
 * A free account's limits as every surface says them (the owner's boards, 2026-10-23): one row's name, icon, share and
 * line, and the ways on that need nothing freed.
 */
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ChatsIcon, CloudIcon, CpuIcon, DownloadSimpleIcon, HardDrivesIcon, KeyIcon, SquaresFourIcon } from "@phosphor-icons/react";
import { APP_ROUTES, shownBytes, type ComputerSize, type LimitReading, type LimitsReport } from "@kinu.run/core";
import { getLimits } from "@/lib/limits-api";
import { lastValue, useAsyncResource } from "@/hooks/use-async-resource";
import { ShareBar, type ShareTone } from "@/components/ui/Meter";
import { buttonClass } from "@/components/ui/Button";
import { Notice } from "@/components/ui/Notice";
import { settingsPath } from "@/components/SettingsRail";

const RUN_YOUR_OWN = "Run your own Kinu";

/** The limits a person sees: the running computer is the hours' own line, never a row of its own. */
export type ShownLimit = Exclude<LimitReading["id"], "computers_running">;

const SHOWN: readonly ShownLimit[] = ["workspaces", "computer_hours", "stored_bytes", "model_tokens"];

/** Short dates as the boards write them: "Nov 1". */
function day(at: number): string {
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** When the day's models start again (00:00 UTC), on the reader's own clock: "midnight" where the days turn together. */
export function dayTurnsAt(): string {
  const next = new Date();

  next.setUTCHours(24, 0, 0, 0);

  return next.getHours() === 0 && next.getMinutes() === 0 ? "midnight" : next.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

/** Hours as a whole number where it is one: "17 h". */
function hours(seconds: number): string {
  const value = seconds / 3600;

  return `${value >= 10 || Number.isInteger(value) ? String(Math.floor(value)) : value.toFixed(1)} h`;
}

/** A limit as one row says it. */
export interface LimitWords {
  readonly icon: ReactNode;
  readonly name: string;
  /** Its use and its limit: "2 of 3". */
  readonly shown: string;
  readonly line: string;
  /** 0 to 100. */
  readonly percent: number;
}

function workspacesLine(reading: LimitReading): string {
  const left = reading.limit - reading.used;

  if (reading.reached) return `All ${String(reading.used)} keep working. Remove one to start another.`;

  return left === 1 ? "One more to go." : `${String(left)} more to go.`;
}

/** A share's tone, as the Meter turns: warning from 80%, danger at 100%. */
export function toneOf(percent: number): ShareTone {
  if (percent >= 100) return "danger";

  return percent >= 80 ? "warning" : "accent";
}

export function wordsOf(reading: LimitReading): LimitWords {
  const percent = Math.min(100, Math.round((reading.used / Math.max(reading.limit, 1)) * 100));

  switch (reading.id) {
    case "workspaces":
      return {
        icon: <SquaresFourIcon size={16} />, name: "Workspaces", percent,
        shown: `${String(reading.used)} of ${String(reading.limit)}`,
        line: workspacesLine(reading),
      };
    case "computer_hours":
      return {
        icon: <CpuIcon size={16} />, name: "Computer time", percent,
        shown: `${hours(reading.used)} of ${hours(reading.limit)}`,
        line: `1 small computer · this month · starts again ${day(reading.resetsAt ?? Date.now())}`,
      };
    case "stored_bytes":
      return { icon: <HardDrivesIcon size={16} />, name: "Storage", percent, shown: `${shownBytes(reading.used)} of ${shownBytes(reading.limit)}`, line: "Drive, workspace files and mail" };
    case "model_tokens":
    case "computers_running":
      return { icon: <ChatsIcon size={16} />, name: "Kinu's models today", percent, shown: `${String(percent)}%`, line: `Starts again at ${dayTurnsAt()} · then your own key keeps going` };
  }
}

/** The account's limits a person is shown, in the boards' order. */
export function shownReadings(report: LimitsReport): readonly (LimitReading & { readonly id: ShownLimit })[] {
  return SHOWN.flatMap((id) => report.limits.filter((reading): reading is LimitReading & { readonly id: ShownLimit } => reading.id === id));
}

/** A limit's share as the bar alone, its words beside it; warning from 80%, danger at 100%, as the Meter turns. */
export function Spent({ percent }: { percent: number }) {
  return <ShareBar share={percent / 100} tone={toneOf(percent)} />;
}

/** One limit's row: its icon, name, use, bar and line. */
export function LimitRow({ reading }: { reading: LimitReading }) {
  const words = wordsOf(reading);

  return (
    <div className="flex items-start gap-3 px-4 py-3" data-limit={reading.id}>
      <span className="mt-px shrink-0 p-text-2">{words.icon}</span>
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex items-baseline gap-2">
          <span className="t-item p-text">{words.name}</span>
          <span className="t-meta ml-auto tabular-nums p-text-2">{words.shown}</span>
        </div>
        <Spent percent={words.percent} />
        <p className="t-meta p-text-3">{words.line}</p>
      </div>
    </div>
  );
}

/** "Run your own Kinu", where a person goes to have no limits. */
export function RunYourOwn({ variant = "primary", suffix = "" }: { variant?: "primary" | "ghost"; suffix?: string }) {
  return <Link to={APP_ROUTES.deploy} className={buttonClass({ variant, size: "sm" })}><CloudIcon size={12} />{RUN_YOUR_OWN}{suffix}</Link>;
}

/** A turn on Kinu's models the day's limit stopped, where its answer would have gone (the owner's board, limit A). */
export function ModelsUsedUp() {
  return (
    <Notice tone="warning" className="my-1" data-turn-limit="model_tokens"
      action={<Link to={settingsPath("models")} className={buttonClass({ size: "sm" })}><KeyIcon size={12} />Use your own key</Link>}>
      Today&apos;s Kinu models are used up, so this turn stopped. Add your own key to go on now, or they start again at {dayTurnsAt()}.
    </Notice>
  );
}

/** The largest size this account's computers start at (core limits/ `startSize`); null where none caps them, or before
 *  the limits are read. */
export function useComputerSizeCap(): ComputerSize | null {
  const limits = useAsyncResource(getLimits);

  return lastValue(limits.resource)?.computerSizeCap ?? null;
}

/** "Move my data": Settings › Account's list of what moves, and the download that carries it. */
export function MoveMyData({ onGo }: { onGo?: () => void }) {
  return (
    <Link to={settingsPath("account")} onClick={onGo} className={buttonClass({ variant: "ghost", size: "sm" })} data-move-my-data="">
      <DownloadSimpleIcon size={12} />Move my data
    </Link>
  );
}
