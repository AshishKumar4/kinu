/**
 * One bar across the top of every page when one of a free account's limits is near its end (the owner's board, warn
 * A), until it is dismissed for that limit: its own slot above the page, not a Notice inside one.
 */
import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { WarningIcon, XIcon } from "@phosphor-icons/react";
import { Effect } from "effect";
import { shownBytes, type LimitReading, type LimitsReport } from "@kinu.run/core";
import { detach } from "@kinu.run/core/obs";
import { getLimits } from "@/lib/limits-api";
import { Surface } from "@/components/ui/Surface";
import { Button } from "@/components/ui/Button";
import { settingsPath } from "@/components/SettingsRail";
import { dayTurnsAt, shownReadings } from "./limit-words";

/** How often the bar reads the limits again while the app stays open, beside every focus of the window. */
const READ_EVERY_MS = 5 * 60_000;

const DISMISSED = "kinu.limit-banner.dismissed";

/** A dismissal holds for one limit at one stage (near, then reached) of one period: a new period or stage shows again. */
function dismissalKey(reading: LimitReading): string {
  return `${reading.id}:${String(reading.resetsAt ?? "fixed")}:${reading.reached ? "reached" : "near"}`;
}

function dismissed(): ReadonlySet<string> {
  const stored = window.localStorage.getItem(DISMISSED);

  return new Set(stored === null ? [] : stored.split("\n"));
}

function day(at: number): string {
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** The bar's words for a limit near or at its end, as the board says them. */
export function bannerText(reading: LimitReading): string {
  switch (reading.id) {
    case "workspaces":
      return reading.reached
        ? `You have all ${String(reading.limit)} free workspaces. They all keep working; remove one to start another.`
        : `You've used ${String(reading.used)} of your ${String(reading.limit)} free workspaces.`;
    case "computer_hours":
      return `You've used ${String(Math.floor(reading.used / 3600))} of this month's ${String(reading.limit / 3600)} computer hours. It starts again ${day(reading.resetsAt ?? Date.now())}.`;
    case "stored_bytes":
      return `Your storage is ${shownBytes(reading.used)} of ${shownBytes(reading.limit)}.`;
    case "model_tokens":
    case "computers_running":
      return reading.reached
        ? `Today's Kinu models are used up. Your own key keeps going, or they start again at ${dayTurnsAt()}.`
        : `${String(Math.round((reading.used / reading.limit) * 100))}% of today's Kinu models are used. Then your own key keeps going, or they start again at ${dayTurnsAt()}.`;
  }
}

/** The first near limit not yet dismissed. */
function shown(report: LimitsReport | null, hidden: ReadonlySet<string>): LimitReading | null {
  if (report === null) return null;

  return shownReadings(report).find((reading) => reading.near && !hidden.has(dismissalKey(reading))) ?? null;
}

export function LimitBanner() {
  const [report, setReport] = useState<LimitsReport | null>(null);
  const [hidden, setHidden] = useState<ReadonlySet<string>>(dismissed);

  const read = useCallback(() => detach(Effect.promise(async () => {
    const [answer] = await Promise.allSettled([getLimits()]);

    // A read that failed shows nothing: the bar is a courtesy, and Settings › Usage says why it could not read.
    if (answer.status === "fulfilled") setReport(answer.value);
  })), []);

  useEffect(() => {
    read();
    const every = window.setInterval(read, READ_EVERY_MS);
    const onFocus = () => { read(); };

    window.addEventListener("focus", onFocus);

    return () => {
      window.clearInterval(every);
      window.removeEventListener("focus", onFocus);
    };
  }, [read]);

  const reading = shown(report, hidden);

  if (reading === null) return null;

  const dismiss = () => {
    const next = new Set(hidden).add(dismissalKey(reading));

    window.localStorage.setItem(DISMISSED, [...next].join("\n"));
    setHidden(next);
  };

  return (
    <Surface look="wash" className="t-meta flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 p-text" data-limit-banner={reading.id} role="status">
      <WarningIcon size={14} className={`shrink-0 ${reading.reached ? "p-danger" : "p-warning"}`} />
      <span className="min-w-0 flex-1">{bannerText(reading)}</span>
      <Link to={settingsPath("usage")} className="p-accent-fg underline underline-offset-2">See usage</Link>
      <Button variant="ghost" size="sm" icon={<XIcon size={14} />} aria-label="Dismiss" onClick={dismiss} />
    </Surface>
  );
}
