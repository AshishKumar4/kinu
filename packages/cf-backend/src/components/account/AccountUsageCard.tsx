import { ChartBarIcon } from "@phosphor-icons/react";
import { fmtTokens, fmtUsd, quotaWindowText, timeAgo, usageTotal, type AccountSpend, type AccountUsage } from "@kinu.run/core";
import { getAccountUsage } from "@/lib/user-api";
import { Card } from "@/components/ui/form";
import { CardSlot } from "@/components/ui/CardSlot";
import { useAsyncResource } from "@/hooks/use-async-resource";

function AccountRow({ row, now }: { row: AccountSpend; now: number }) {
  const cost = row.usd === undefined ? "unpriced" : `${fmtUsd(row.usd)}${row.unpricedCalls > 0 ? "+" : ""}`;

  return (
    <div className="px-4 py-2.5">
      <div className="flex items-baseline gap-2 p-row-text">
        <span className="min-w-0 flex-1 break-words font-medium p-text">
          {row.provider === null ? "No account recorded" : `${row.provider} · ${row.account ?? ""}`}
        </span>
        <span className="p-text-3 shrink-0">×{row.calls}</span>
        <span className="shrink-0 p-text-2 tabular-nums">{fmtTokens(usageTotal(row.usage))}</span>
        <span className="w-20 shrink-0 text-right p-text tabular-nums">{cost}</span>
      </div>
      {row.quota !== undefined && (
        <ul className="mt-1 space-y-0.5 p-meta p-text-3" title={`As the provider reported it ${timeAgo(row.quota.at)}.`}>
          {row.quota.windows.map((window) => <li key={window.measure}>{quotaWindowText(window, now)}</li>)}
        </ul>
      )}
    </div>
  );
}

function UsageTable({ usage }: { usage: AccountUsage }) {
  const now = Date.now();

  return (
    <div className="space-y-3">
      {usage.accounts.length === 0
        ? <p className="p-row-text p-text-3">No model call has been recorded yet.</p>
        : <div className="p-group">{usage.accounts.map((row) => <AccountRow key={`${row.provider ?? ""}@${row.account ?? ""}`} row={row} now={now} />)}</div>}
      <p className="p-meta p-text-3">
        Across {usage.workspaces} workspace{usage.workspaces === 1 ? "" : "s"}, at API rates from the models.dev catalog;
        a subscription is billed by its plan instead.
      </p>
      {usage.unread.length > 0 && (
        <p className="p-meta p-danger">Not counted, could not be read: {usage.unread.join(", ")}.</p>
      )}
    </div>
  );
}

export function AccountUsageCard() {
  const usage = useAsyncResource(getAccountUsage);

  return (
    <Card title="By account · API-equivalent cost" icon={ChartBarIcon}>
      <CardSlot resource={usage.resource} what="your usage" onRetry={usage.reload}>
        {(value) => <UsageTable usage={value} />}
      </CardSlot>
    </Card>
  );
}
