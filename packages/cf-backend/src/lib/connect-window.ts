import { APP_ROUTES } from "@kinu.run/core";
import { cloudflareReconnectPath } from "@/lib/user-api";

/** The helper window's word to the tab that opened it: the sign-in ended. */
const CONNECTED_CHANNEL = "kinu-connected";

/** A path on this origin, else home: `next` comes off a URL anyone can write. */
export function sameOriginPath(next: string | null): string {
  return next !== null && next.startsWith("/") && !next.startsWith("//") ? next : APP_ROUTES.home;
}

/**
 * Runs the Cloudflare sign-in in a helper window, so the tab that asked stays where it is (an onboarding step);
 * when the sign-in ends, the helper closes and this tab returns to `returnTo` with the new connection. False when no
 * window could open (a blocked popup): the caller's own link then runs the sign-in in this tab, back to `returnTo`.
 */
export function connectCloudflareInHelper(returnTo: string): boolean {
  const ended = `${APP_ROUTES.connected}?${new URLSearchParams({ next: returnTo }).toString()}`;
  const helper = window.open(cloudflareReconnectPath(ended), "kinu-connect", "popup,width=520,height=720");

  if (helper === null) return false;
  const channel = new BroadcastChannel(CONNECTED_CHANNEL);

  channel.onmessage = () => {
    channel.close();
    // The sign-in may have ended in a tab the browser opened, which cannot close itself; the helper this tab opened can.
    helper.close();
    window.location.assign(returnTo);
  };

  return true;
}

/** On the page a sign-in ends on: tells the tab that asked, closes this window, or, if it may not, goes where it began. */
export function announceConnected(next: string): void {
  const channel = new BroadcastChannel(CONNECTED_CHANNEL);

  channel.postMessage({ next });
  channel.close();
  window.close();

  if (!window.closed) window.location.replace(next);
}
