import * as v from "valibot";
import { CONNECT_CHANNEL, ConnectEndedSchema, sanitizeReturnTo, type ConnectEnded } from "@kinu.run/core";

/** Set in a tab that runs a connect itself, so the finish page it lands on takes it back to the step it left. */
const RETURN_KEY = "kinu-connect-return";

/** One connect from a person's click: where it runs, and how its end reaches the page that started it. */
export interface ConnectRun {
  /** Runs the connect that starts at `start`; `onEnded` hears how it ended, in this page, without a reload. */
  start(start: string, onEnded: (ended: ConnectEnded) => void): void;
  /** Gives the connect up before it started (its start could not be had): the helper tab closes unused. */
  cancel(): void;
}

/**
 * Begins a connect, at the person's click: every service's sign-in to connect it (Cloudflare, an MCP server) runs here.
 * It opens a helper tab now, before any await a popup blocker would count against it, and cuts its opener before it
 * leaves this origin, so the provider's pages cannot reach this tab. The helper ends on the finish page
 * (`APP_ROUTES.connected`), which broadcasts on `CONNECT_CHANNEL` and closes itself; this page hears it and closes it
 * too. Measured 2026-10-20 (Chrome 151, Firefox 158, headless; /mnt/local/kinu/tmp/close-measure/measure.ts): after a
 * round trip through another origin, a tab a script or a `target=_blank` link opened, opener kept, cut or never
 * given, closed itself every time. With no helper (a blocked popup) the connect runs in this tab, and the finish page
 * brings it back here.
 */
export function beginConnect(): ConnectRun {
  // Cleared first: a helper starts with a copy of this tab's session storage, and must not take a stale return home.
  sessionStorage.removeItem(RETURN_KEY);
  const helper = window.open("", "kinu-connect", "popup,width=520,height=720");

  if (helper === null) {
    return {
      start(start) {
        sessionStorage.setItem(RETURN_KEY, window.location.pathname + window.location.search);
        window.location.assign(start);
      },
      cancel() {},
    };
  }

  helper.opener = null;

  return {
    start(start, onEnded) {
      const channel = new BroadcastChannel(CONNECT_CHANNEL);

      channel.onmessage = (event) => {
        const ended = v.safeParse(ConnectEndedSchema, event.data);

        if (!ended.success) return;
        channel.close();
        // A browser that refused the finish page's own close lets the tab that opened it.
        helper.close();
        onEnded(ended.output);
      };

      helper.location.href = start;
    },
    cancel() { helper.close(); },
  };
}

/**
 * On the finish page: a connect run in this tab returns to the step it left; one run in a helper tells the tab that
 * started it and closes. Where the browser keeps the helper open, the page says so and stays: it never routes into
 * the app, which would land a person not yet set up on setup's first step. True when this tab is going back.
 */
export function finishConnect(ended: ConnectEnded): boolean {
  const back = sessionStorage.getItem(RETURN_KEY);

  sessionStorage.removeItem(RETURN_KEY);

  if (back !== null) {
    window.location.replace(sanitizeReturnTo(back, window.location.origin));

    return true;
  }

  const channel = new BroadcastChannel(CONNECT_CHANNEL);

  channel.postMessage(ended);
  channel.close();
  window.close();

  return false;
}
