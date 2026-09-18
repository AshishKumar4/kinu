/**
 * One row of a deploy ledger, as both doors draw it.
 *
 * Shared because the guided page and the Updates page render the SAME rows:
 * they are one plan run in two places, and a second copy of this component
 * would be two ways of showing one ledger.
 */
import { Loader } from "@cloudflare/kumo";
import {
  ArrowClockwiseIcon, CheckCircleIcon, CircleIcon, WarningCircleIcon,
} from "@phosphor-icons/react";
import type { DeployStepRow } from "@kinu.run/core/deploy";
import { FilledButton } from "@/components/ui/FilledButton";

export function StepRow({ row, onRetry }: {
  row: DeployStepRow;
  /** Absent where a retry has nowhere to go — the Updates page watches a run
   *  it started and offers the whole run again, not one step of it. */
  onRetry?: (id: string) => void;
}) {
  const note = row.notes.at(-1) ?? "";

  return (
    <li className="p-card px-4 py-3" data-step={row.id} data-state={row.state}>
      <div className="flex items-start gap-3">
        <span className="mt-0.5 shrink-0">
          {row.state === "done" && <CheckCircleIcon size={16} className="text-[var(--c-success)]" />}
          {row.state === "failed" && <WarningCircleIcon size={16} className="text-[var(--c-danger)]" />}
          {row.state === "running" && <Loader size="sm" />}
          {row.state === "pending" && <CircleIcon size={16} className="p-text-3" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className={`p-row-text ${row.state === "pending" ? "p-text-3" : "p-text"}`}>{row.title}</span>
            {row.attempt > 1 && <span className="p-badge-neutral rounded-sm px-1.5 py-0.5 text-[10px]">attempt {row.attempt}</span>}
          </div>
          {row.state === "done" && row.detail !== "" && <p className="mt-0.5 p-meta p-text-3">{row.detail}</p>}
          {row.state === "running" && note !== "" && <p className="mt-0.5 p-meta p-text-3">{note}</p>}
          {row.failure !== null && (
            <div className="mt-2 p-notice-danger rounded-md px-3 py-2 text-xs" role="alert">
              <p className="font-mono">{row.failure.detail}</p>
              {row.failure.code !== 0 && (
                <p className="mt-1 opacity-80">Cloudflare error {row.failure.code}, HTTP {row.failure.status}.</p>
              )}
            </div>
          )}
        </div>
        {row.state === "failed" && onRetry !== undefined && (
          <FilledButton onClick={() => onRetry(row.id)} className="shrink-0">
            <ArrowClockwiseIcon size={13} /> Retry this step
          </FilledButton>
        )}
      </div>
    </li>
  );
}
