/** An operator's invite link, opened signed in (core limits/): spent once for this account, which then has no limits. */
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { GiftIcon, WarningIcon } from "@phosphor-icons/react";
import { APP_ROUTES } from "@kinu.run/core";
import { Cause, Effect } from "effect";
import { detach, renderThrownChain } from "@kinu.run/core/obs";
import { redeemInvite } from "@/lib/limits-api";
import { settingsPath } from "@/components/SettingsRail";
import { Loader } from "@/components/ui/Loader";
import { Surface } from "@/components/ui/Surface";

type Redeemed = { readonly phase: "spending" } | { readonly phase: "invited" } | { readonly phase: "refused"; readonly why: string };

export default function InvitePage() {
  const { token = "" } = useParams();
  const [redeemed, setRedeemed] = useState<Redeemed>({ phase: "spending" });

  // Spent by the page's first look: a second look of the same account is the link's own answer, already used by it.
  useEffect(() => {
    let live = true;

    detach(Effect.catchCause(
      Effect.map(Effect.promise(() => redeemInvite(token)), () => { if (live) setRedeemed({ phase: "invited" }); }),
      (failed) => Effect.sync(() => { if (live) setRedeemed({ phase: "refused", why: renderThrownChain({ cause: Cause.squash(failed) }) }); }),
    ));

    return () => { live = false; };
  }, [token]);

  return (
    <div className="flex h-full items-center justify-center p-6">
      <Surface look="panel" as="section" data-invite={redeemed.phase} className="max-w-md space-y-3 px-6 py-8 text-center">
        {redeemed.phase === "spending" && <Loader size="base" />}
        {redeemed.phase === "invited" && (
          <>
            <GiftIcon size={24} className="mx-auto p-accent-fg" aria-hidden />
            <h2 className="t-title p-text">You&apos;re invited</h2>
            <p className="t-body p-text-2">Workspaces, computer time, storage and Kinu&apos;s models: no limits on this account.</p>
            <Link to={settingsPath("usage")} className="t-control inline-block p-accent-fg">See usage →</Link>
          </>
        )}
        {redeemed.phase === "refused" && (
          <>
            <WarningIcon size={24} className="mx-auto p-warning" aria-hidden />
            <h2 className="t-title p-text">This invite didn&apos;t work</h2>
            <p className="t-body p-text-2">{redeemed.why}</p>
            <Link to={APP_ROUTES.home} className="t-control inline-block p-accent-fg">Go home →</Link>
          </>
        )}
      </Surface>
    </div>
  );
}
