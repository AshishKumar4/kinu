/**
 * Settings › Web search and its onboarding step in the gallery: `usersettingsstate&section=search` and
 * `welcome&step=3`. `&cloudflare=` names the account's Cloudflare login (`granted`, the default; `stale`, a sign-in from
 * before web search; `off`, none), `&searchtest=refused` has Test refused in Cloudflare's words, `&chain=` starts the
 * account on a chosen chain (`linkup-cloudflare,exa-cloudflare`), `&keys=` names the keys it holds (gallery.tsx), and
 * `&credits=` its AI credits (`held`, the default; `none`; `bought`, none until Add credits opens Cloudflare's page).
 * `&transcript=search-unpaid` is a chat whose newest search was refused.
 */
import * as v from "valibot";
import { WEB, WebSearchRouteSchema, USER_WEB_SEARCH_TEST_PATH, type GatewayCreditsRead, type WebSearchRoute } from "@kinu.run/core";
import type { CloudflareAccountStatus } from "@/lib/user-api";
import type { GalleryChatMessage } from "@/gallery-agent-stub";

const query = new URLSearchParams(location.search);

/** Whose Cloudflare login the account holds, for the account read and the bill line. */
const GALLERY_CLOUDFLARE = v.parse(v.picklist(["granted", "stale", "off"]), query.get("cloudflare") ?? "granted");

/** The account's chosen chain, where `&chain=` names one. */
export function galleryWebSearchChain(): WebSearchRoute[] | undefined {
  const named = query.get("chain");

  return named === null ? undefined : named.split(",").map((entry) => {
    const [provider, billing] = entry.split("-");

    return v.parse(WebSearchRouteSchema, { provider, billing });
  });
}

const GALLERY_CREDITS = v.parse(v.picklist(["held", "none", "bought"]), query.get("credits") ?? "held");

/** Whether Cloudflare's page was opened, and the person bought credits there. */
let bought = false;

if (GALLERY_CREDITS === "bought") {
  const opens = window.open.bind(window);

  window.open = (url, target, features) => {
    bought ||= target === "kinu-ai-credits";

    return opens(url, target, features);
  };
}

/** The credits read, as `readGatewayCredits` reads it: the person's own account's, where its login grants web search. */
export function galleryGatewayCredits(): GatewayCreditsRead | null {
  if (GALLERY_CLOUDFLARE !== "granted") return null;
  const none = GALLERY_CREDITS === "none" || (GALLERY_CREDITS === "bought" && !bought);

  return {
    payer: "yours", account: "acct-1",
    credits: none ? { balance: 0, card: true, autoTopUp: null } : { balance: 25, card: true, autoTopUp: { threshold: 5, amount: 20 } },
  };
}

/** Cloudflare's account read, as `listCloudflareAccounts` reads it. */
export function galleryCloudflareAccounts(): CloudflareAccountStatus {
  return GALLERY_CLOUDFLARE === "off"
    ? { connected: false, selectedId: null, accounts: [], webSearch: false, signInExpired: false, connectable: true }
    : { connected: true, selectedId: "acct-1", accounts: [{ id: "acct-1", name: "Primary" }], webSearch: GALLERY_CLOUDFLARE === "granted", signInExpired: false, connectable: true };
}

const TestBodySchema = v.object({ query: v.string(), limit: v.number(), route: WebSearchRouteSchema });

/** What a Test searching for Durable Objects alarms gets back. */
const RESULTS = [
  { title: "Alarms · Cloudflare Durable Objects docs", url: "https://developers.cloudflare.com/durable-objects/api/alarms/", snippet: "Durable Objects alarms allow you to schedule the Durable Object to be woken up at a time in the future." },
  { title: "Durable Object Storage API", url: "https://developers.cloudflare.com/durable-objects/api/storage-api/", snippet: "setAlarm(scheduledTimeMs) sets the current alarm time." },
  { title: "Use the Alarms API · Examples", url: "https://developers.cloudflare.com/durable-objects/examples/alarms-api/", snippet: "Use the Durable Objects Alarms API to batch requests to a Durable Object." },
];

/** Settings' Test, answered as the route does: the search, or the refusal in the provider's words. */
export async function galleryWebSearchTest(path: string, method: string, body: BodyInit | null | undefined): Promise<Response | null> {
  if (path !== USER_WEB_SEARCH_TEST_PATH || method !== "POST") return null;
  const asked = v.parse(TestBodySchema, JSON.parse(v.parse(v.string(), body)));

  // A search takes about as long as one measured through Cloudflare's API (1.5 s, staging, 2026-10-19).
  const searched = Promise.withResolvers<void>();
  setTimeout(searched.resolve, 1_200);
  await searched.promise;

  if (query.get("searchtest") === "refused") {
    return Response.json({ error: "Exa on your AI Gateway: Cloudflare answered 402: Your AI Gateway credit balance is zero", code: "denied" }, { status: 403 });
  }

  return Response.json(v.parse(WEB.search.output, {
    query: asked.query, source: asked.route.provider,
    results: RESULTS.slice(0, asked.limit).map((result, at) => ({ ...result, position: at + 1 })),
  }));
}

const NOW = Date.now();

/** A turn whose web search Cloudflare refused for want of AI credits, in the words the search chain ends with. */
export const SEARCH_UNPAID_THREAD: readonly GalleryChatMessage[] = [
  { id: "su-u1", role: "user", createdAt: NOW - 2 * 60e3, parts: [{ type: "text", text: "What changed in Durable Objects alarms this year?" }] },
  {
    id: "su-a1", role: "assistant", createdAt: NOW - 2 * 60e3,
    parts: [
      { type: "step-start" },
      {
        type: "tool-web", toolCallId: "su-c1", state: "output-error", input: { op: "search", query: "Durable Objects alarms changes 2026" },
        errorText: "Exa through Cloudflare: Cloudflare answered 402: Your AI Gateway credit balance is zero. "
          + "To search again, add credits to your AI Gateway in Cloudflare, or a search key in Settings > Web search.",
      },
      { type: "text", state: "done", text: "I couldn't search the web: Cloudflare refused the search because your AI Gateway has no credits left." },
    ],
  },
];
