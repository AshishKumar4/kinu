/** One deploy ledger row, shared by the guided page and the Updates page. */
import { Loader } from "@cloudflare/kumo";
import { Button } from "@/components/ui/Button";
import {
  ArrowClockwiseIcon, CheckCircleIcon, CircleIcon, WarningCircleIcon,
} from "@phosphor-icons/react";
import type { DeployStepRow } from "@kinu.run/core/deploy";

export function StepRow({ row, onRetry }: {
  row: DeployStepRow;
  /** Absent on the Updates page, which retries the whole run, not one step. */
  onRetry?: (id: string) => void;
}) {
  const note = row.notes.at(-1) ?? "";

  return (
    <li className="p-card px-4 py-3" data-step={row.id} data-state={row.state}>
      <div className="flex items-start gap-3">
        <span className="mt-px shrink-0">
          {row.state === "done" && <CheckCircleIcon size={16} className="text-[var(--c-success)]" />}
          {row.state === "failed" && <WarningCircleIcon size={16} className="text-[var(--c-danger)]" />}
          {row.state === "running" && <Loader size="sm" />}
          {row.state === "pending" && <CircleIcon size={16} className="p-text-3" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className={`t-body ${row.state === "pending" ? "p-text-3" : "p-text"}`}>{row.title}</span>
            {row.attempt > 1 && <span className="t-meta p-badge-neutral rounded-sm px-1 py-px">attempt {row.attempt}</span>}
          </div>
          {row.state === "done" && row.detail !== "" && <p className="t-meta mt-px p-text-3">{row.detail}</p>}
          {row.state === "running" && note !== "" && <p className="t-meta mt-px p-text-3">{note}</p>}
          {row.failure !== null && (
            <div className="t-meta mt-2 p-notice-danger rounded-md px-3 py-2" role="alert">
              <p className="font-mono">{row.failure.detail}</p>
              {row.failure.code !== 0 && (
                <p className="mt-1 opacity-80">Cloudflare error {row.failure.code}, HTTP {row.failure.status}.</p>
              )}
            </div>
          )}
        </div>
        {row.state === "failed" && onRetry !== undefined && (
          <Button variant="primary" size="sm" onClick={() => onRetry(row.id)} className="shrink-0">
            <ArrowClockwiseIcon size={13} /> Retry this step
          </Button>
        )}
      </div>
    </li>
  );
}
