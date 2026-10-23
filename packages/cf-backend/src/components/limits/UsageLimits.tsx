/**
 * Settings › Usage's own section (the owner's board, usage A): the account's plan on this deployment and a row per
 * limit, above the providers' limits. An invited account reads one line; an account no free tier binds, nothing.
 */
import { Link } from "react-router-dom";
import { GiftIcon, KeyIcon } from "@phosphor-icons/react";
import type { LimitsReport } from "@kinu.run/core";
import { getLimits } from "@/lib/limits-api";
import { useAsyncResource } from "@/hooks/use-async-resource";
import { CardSlot } from "@/components/ui/CardSlot";
import { Group } from "@/components/ui/Group";
import { buttonClass } from "@/components/ui/Button";
import { settingsPath } from "@/components/SettingsRail";
import { LimitRow, RunYourOwn, shownReadings } from "./limit-words";

/** The deployment's name as a person knows it: the host they are on. */
function deploymentName(): string {
  return window.location.hostname;
}

function PlanHeader({ report }: { report: LimitsReport }) {
  const invited = report.class === "invited";

  return (
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <h3 className="t-title p-text">{`${deploymentName()} · ${invited ? "invited" : "free"}`}</h3>
      <span className="t-meta p-text-3">{invited ? "You were invited: no limits." : "At a limit only new things stop: everything you have keeps working."}</span>
    </div>
  );
}

function Plan({ report }: { report: LimitsReport }) {
  // An operator's, an eval's, or any account on a deployment with no free tier: nothing to show.
  if (report.class !== "invited" && report.limits.length === 0) return null;

  return (
    <section className="space-y-3" data-account-limits={report.class}>
      <PlanHeader report={report} />
      {report.class === "invited" ? (
        <Group>
          <div className="flex items-center gap-3 px-4 py-3">
            <GiftIcon size={16} className="p-accent-fg" />
            <span className="t-body p-text-2">Workspaces, computer time, storage and Kinu&apos;s models: no limits.</span>
          </div>
        </Group>
      ) : (
        <>
          <Group>{shownReadings(report).map((reading) => <LimitRow key={reading.id} reading={reading} />)}</Group>
          <div className="flex flex-wrap items-center gap-2">
            <Link to={settingsPath("models")} className={buttonClass({ size: "sm" })}><KeyIcon size={12} />Use your own key</Link>
            <RunYourOwn variant="ghost" suffix=": no limits" />
          </div>
        </>
      )}
    </section>
  );
}

export function UsageLimits() {
  const limits = useAsyncResource(getLimits);

  return (
    <CardSlot resource={limits.resource} what="your limits" onRetry={limits.reload}>
      {(report) => <Plan report={report} />}
    </CardSlot>
  );
}
