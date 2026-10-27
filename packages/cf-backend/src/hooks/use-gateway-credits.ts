/**
 * The AI credits that pay for searches through Cloudflare, and buying more. Cloudflare sells them on its own page, which
 * opens beside this one; once it is open the credits are read again every few seconds until they change.
 */
import { useCallback, useState } from "react";
import { gatewayCreditsUrl, type GatewayCreditsRead } from "@kinu.run/core";
import { readGatewayCredits } from "@/lib/user-api";
import { openProviderWindow } from "@/lib/connect-window";
import { lastValue, useAsyncResource } from "@/hooks/use-async-resource";

/** How often the credits are read again while Cloudflare's page to buy them is open. */
const CREDITS_RECHECK_MS = 5000;

export interface GatewayCredits {
  /** Null before the first read, and where Kinu has no account of the person's to read. */
  readonly read: GatewayCreditsRead | null;
  readonly empty: boolean;
  /** Cloudflare's page is open, and the credits read as they did when it opened. */
  readonly waiting: boolean;
  /** They changed since the page opened: the purchase landed. */
  readonly changed: boolean;
  readonly buy: () => void;
}

/** Off, nothing is read: a chat asks only once a search was refused. */
export function useGatewayCredits(on = true): GatewayCredits {
  // The credits the purchase was opened at, as read then: any change is the purchase landing.
  const [openedAt, setOpenedAt] = useState<string | null>(null);
  const load = useCallback(async () => (on ? readGatewayCredits() : null), [on]);
  const recheck = useCallback((read: GatewayCreditsRead | null) => (openedAt !== null && JSON.stringify(read) === openedAt ? CREDITS_RECHECK_MS : null), [openedAt]);
  const read = lastValue(useAsyncResource<GatewayCreditsRead | null>(load, recheck).resource);
  const waiting = read !== null && openedAt === JSON.stringify(read);

  const buy = () => {
    if (read === null) return;
    setOpenedAt(JSON.stringify(read));
    const url = gatewayCreditsUrl(read.account);

    // A refused window goes there in this tab instead; the page reads the credits again when it is loaded back.
    if (openProviderWindow("kinu-ai-credits", url) === null) window.location.assign(url);
  };

  return { read, empty: read !== null && read.credits.balance <= 0, waiting, changed: openedAt !== null && read !== null && !waiting, buy };
}
