import { useCallback, useState } from "react";
import { ArrowsClockwiseIcon } from "@phosphor-icons/react";
import {
  fmtTokens, fmtUsd, limitHeading, limitUnreadText, limitWindowText, quotaWindowText, timeAgo, usageTotal,
  type AccountSpend, type AccountUsage, type LimitReport, type LimitWindow,
} from "@kinu.run/core";
import { getAccountUsage } from "@/lib/user-api";
import { Card } from "@/components/ui/form";
import { CardSlot } from "@/components/ui/CardSlot";
import { useAsyncResource } from "@/hooks/use-async-resource";
import { Group } from "@/components/ui/Group";

function usedShare(window: LimitWindow): number | undefined {
  if (window.usedPercent !== undefined) return Math.min(1, Math.max(0, window.usedPercent / 100));

  return window.limit !== undefined && window.used !== undefined && window.limit > 0 ? Math.min(1, window.used / window.limit) : undefined;
}

function LimitRow({ report, now }: { report: LimitReport; now: number }) {
  return (
    <div className="px-4 py-2" title={report.undocumented === true ? "Read from a route the provider does not document; it may change without notice." : undefined}>
      <div className="t-item p-text">{limitHeading(report, now)}</div>
      {report.windows.length === 0 && <p className="t-meta p-text-3">No limit reported.</p>}
      <ul className="mt-1 space-y-2">
        {report.windows.map((window) => {
          const share = usedShare(window);

          return (
            <li key={window.name} className="space-y-px">
              <p className="t-meta p-text-2">{limitWindowText(window, now)}</p>
              {share !== undefined && (
                <div className="h-1 overflow-hidden rounded-full bg-[var(--c-fill)]" aria-hidden="true">
                  <div className={`h-full rounded-full ${share >= 0.9 ? "bg-[var(--c-danger)]" : "bg-[var(--c-accent)]"}`} style={{ width: `${String(Math.round(share * 100))}%` }} />
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function AccountRow({ row, now, live }: { row: AccountSpend; now: number; live: boolean }) {
  const cost = row.usd === undefined ? "unpriced" : `${fmtUsd(row.usd)}${row.unpricedCalls > 0 ? "+" : ""}`;

  return (
    <div className="px-4 py-2">
      <div className="t-body flex items-baseline gap-2">
        <span className="min-w-0 flex-1 break-words font-medium p-text">
          {row.provider === null ? "No account recorded" : `${row.provider} · ${row.account ?? ""}`}
        </span>
        <span className="p-text-3 shrink-0">×{row.calls}</span>
        <span className="shrink-0 p-text-2 tabular-nums">{fmtTokens(usageTotal(row.usage))}</span>
        <span className="w-20 shrink-0 text-right p-text tabular-nums">{cost}</span>
      </div>
      {row.quota !== undefined && !live && (
        <ul className="t-meta mt-1 space-y-px p-text-3" title={`As the provider reported it ${timeAgo(row.quota.at)}.`}>
          {row.quota.windows.map((window) => <li key={window.measure}>{quotaWindowText(window, now)}</li>)}
        </ul>
      )}
    </div>
  );
}

function LimitsTable({ usage, onRefresh }: { usage: AccountUsage; onRefresh: () => void }) {
  const now = Date.now();
  const limits = usage.limits ?? [];
  const unread = usage.limitsUnread ?? [];

  return (
    <div className="space-y-3">
      {limits.length === 0 && unread.length === 0 && <p className="t-body p-text-3">No connected account reports its limits.</p>}
      {(limits.length > 0 || unread.length > 0) && (
        <Group>
          {limits.map((report) => <LimitRow key={`${report.provider}@${report.account}`} report={report} now={now} />)}
          {unread.map((entry) => (
            <p key={`${entry.provider}@${entry.account}`} className="t-body px-4 py-2 p-warning">{limitUnreadText(entry)}</p>
          ))}
        </Group>
      )}
      <button type="button" onClick={onRefresh} className="t-meta inline-flex items-center gap-1 p-text-3 hover:p-text-2">
        <ArrowsClockwiseIcon size={11} /> Read again
      </button>
    </div>
  );
}

function SpendTable({ usage }: { usage: AccountUsage }) {
  const now = Date.now();
  const live = new Set((usage.limits ?? []).map((report) => `${report.provider}@${report.account}`));

  return (
    <div className="space-y-3">
      {usage.accounts.length === 0
        ? <p className="t-body p-text-3">No model call has been recorded yet.</p>
        : (
          <Group>
            {usage.accounts.map((row) => (
              <AccountRow key={`${row.provider ?? ""}@${row.account ?? ""}`} row={row} now={now} live={live.has(`${row.provider ?? ""}@${row.account ?? ""}`)} />
            ))}
          </Group>
        )}
      <p className="t-meta p-text-3">
        Across {usage.workspaces} workspace{usage.workspaces === 1 ? "" : "s"}, at API rates from the models.dev catalog;
        a subscription is billed by its plan instead.
      </p>
      {usage.unread.length > 0 && (
        <p className="t-meta p-danger">Not counted, could not be read: {usage.unread.join(", ")}.</p>
      )}
    </div>
  );
}

export function AccountUsageCard() {
  const [refresh, setRefresh] = useState(false);
  const load = useCallback(() => getAccountUsage(refresh), [refresh]);
  const usage = useAsyncResource(load, undefined, refresh ? "fresh" : "cached");

  const readAgain = () => {
    if (refresh) usage.reload();
    else setRefresh(true);
  };

  return (
    <>
      <Card title="Limits">
        <CardSlot resource={usage.resource} what="your limits" onRetry={usage.reload}>
          {(value) => <LimitsTable usage={value} onRefresh={readAgain} />}
        </CardSlot>
      </Card>
      <Card title="By account · API-equivalent cost">
        <CardSlot resource={usage.resource} what="your usage" onRetry={usage.reload}>
          {(value) => <SpendTable usage={value} />}
        </CardSlot>
      </Card>
    </>
  );
}
