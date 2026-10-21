import { Cause, Effect } from "effect";
import * as v from "valibot";
import { CONNECT_CHANNEL, ConnectEndedSchema, sanitizeReturnTo, type ConnectEnded } from "@kinu.run/core";
import { renderThrownChain, settle } from "@kinu.run/core/obs";
import { beginMcpConnect } from "@/lib/user-api";

/** Set in a tab that runs a connect itself: the run, and the view it left, which the finish page returns it to. */
const RETURN_KEY = "kinu-connect-return";

const ReturnSchema = v.object({ run: v.string(), back: v.string() });

/** One connect from a person's click: its own unpredictable run, where it runs, and how its end reaches this page. */
export interface ConnectRun {
  /** Carried with the connect's start to the server, which binds it to the sign-in and names it to the finish page. */
  readonly id: string;
  /** Runs the connect that starts at `start`; `onEnded` hears this run's end, and no other's, without a reload. */
  start(start: string, onEnded: (ended: ConnectEnded) => void): void;
  /** Gives the connect up before it started (its start could not be had): the helper tab closes unused. */
  cancel(): void;
}

/**
 * Begins a connect, at the person's click: every service's sign-in to connect it (Cloudflare, an MCP server) runs here.
 * It opens a helper tab now, before any await a popup blocker would count against it, and cuts its opener before it
 * leaves this origin, so the provider's pages cannot reach this tab. The helper ends on the finish page
 * (`APP_ROUTES.connected`), which broadcasts its run's end on `CONNECT_CHANNEL` and closes itself; this page takes only
 * its own run's end, and closes the helper too. Measured 2026-10-20 (Chrome 151, Firefox 158, headless;
 * /mnt/local/kinu/tmp/close-measure/measure.ts): after a round trip through another origin, a tab a script or a
 * `target=_blank` link opened, opener kept, cut or never given, closed itself every time. With no helper (a blocked
 * popup) the connect runs in this tab, and the finish page brings it back to the view it left, address and all.
 */
export function beginConnect(): ConnectRun {
  const id = crypto.randomUUID();

  // Cleared first: a helper starts with a copy of this tab's session storage, and must not take a stale return home.
  sessionStorage.removeItem(RETURN_KEY);
  const helper = window.open("", "kinu-connect", "popup,width=520,height=720");

  if (helper === null) {
    return {
      id,
      start(start) {
        const back = window.location.pathname + window.location.search + window.location.hash;

        sessionStorage.setItem(RETURN_KEY, JSON.stringify({ run: id, back } satisfies v.InferOutput<typeof ReturnSchema>));
        window.location.assign(start);
      },
      cancel() {},
    };
  }

  helper.opener = null;

  return {
    id,
    start(start, onEnded) {
      const channel = new BroadcastChannel(CONNECT_CHANNEL);

      channel.onmessage = (event) => {
        const ended = v.safeParse(ConnectEndedSchema, event.data);

        // Only this run's end: another tab's connect, or a finish page no callback reached, is not this one's.
        if (!ended.success || ended.output.run !== id) return;
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

/** What the finish page does with its run's end: goes back to the view this tab left, shows why it failed with the way
 *  back, or has told the tab that started it and closes; with no run, it has nothing to report. */
export type FinishedConnect =
  | { readonly kind: "returning" }
  | { readonly kind: "failed-here"; readonly back: string }
  | { readonly kind: "told" }
  | { readonly kind: "unknown" };

/**
 * On the finish page: a connect run in this tab returns to the view it left, or shows its failure with the way back; one
 * run in a helper tells the tab that started it and closes. A page no callback reached names no run and tells no one.
 * It never routes into the app, which would land a person not yet set up on setup's first step.
 */
export function finishConnect(ended: ConnectEnded): FinishedConnect {
  const stored = v.safeParse(v.pipe(v.string(), v.parseJson(), ReturnSchema), sessionStorage.getItem(RETURN_KEY));

  if (ended.run === null) return { kind: "unknown" };

  // Kept, not taken: a finish page loaded again for the same run, by a reload before it left, goes back all the same.
  // The next connect's begin clears it.
  if (stored.success && stored.output.run === ended.run) {
    const back = sanitizeReturnTo(stored.output.back, window.location.origin);

    if (ended.error !== null) return { kind: "failed-here", back };
    window.location.replace(back);

    return { kind: "returning" };
  }

  const channel = new BroadcastChannel(CONNECT_CHANNEL);

  channel.postMessage(ended);
  channel.close();
  window.close();

  return { kind: "told" };
}

/** An MCP server's sign-in in `connect`'s run: begun on the server for it, then run; null, or why it could not begin. */
export function signInMcpServer(connect: ConnectRun, server: string, onEnded: (ended: ConnectEnded) => void): Promise<string | null> {
  return settle(Effect.matchCause(Effect.promise(async () => beginMcpConnect(server, connect.id)), {
    onSuccess: ({ authUrl }) => {
      connect.start(authUrl, onEnded);

      return null;
    },
    onFailure: (failed) => {
      connect.cancel();

      return renderThrownChain({ cause: Cause.squash(failed) });
    },
  }));
}
