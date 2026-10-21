/**
 * The deploy page's door, answered in the design gallery (`/deploy` in the whole app): the real page against fixtures
 * typed by core's own deploy types, its runs built by core's `deployRunView` from step rows and its refusals judged by
 * core's `judgeRefusal`, so the page shows only what the product can say. `&deploy=` names the state; a sign-in comes
 * back to the state after it, and a run begun here goes through its phases to live as the page reads it.
 */
import {
  FACT_ADDRESS, SIGN_IN_AGAIN_NEED, deployRunView, judgeRefusal,
  type CloudflareWords, type DeployDomain, type DeployedKinu, type DeployNeed, type DeployPreflight, type DeployRunView, type DeploySession,
  type DeployStepRow, type DeployZone, type MailPreview, type UpdateOffer,
} from "@kinu.run/core/deploy";

const ACCOUNT = "4b1ad7e0c3f24f6c9a51d2e8b7c60a13";

const SECOND_ACCOUNT = "9e2c41f07a6b4d3e8f15c0a9b2d7e684";

const ACCOUNTS = [{ id: ACCOUNT, name: "Ada Lovelace's account" }, { id: SECOND_ACCOUNT, name: "Flour & Hearth" }] as const;

const ZONES: readonly DeployZone[] = [{ id: "0c5e9a1d7b2f4e6a8c3d1f0b9e7a5c42", name: "flourandhearth.com", status: "active" }];

const WORKERS = "kinu.ada.workers.dev";

/** Each state the review opens, as the design bar lists it; `at` is the page's own address when it has a query. */
export const DEPLOY_FIXTURE_STATES = [
  { id: "start", label: "Start" },
  { id: "declined", label: "Start: Cloudflare's consent declined", at: "/deploy?error=access_denied&error_description=The+user+denied+the+request." },
  { id: "unconfigured", label: "Start: no OAuth client on this Kinu" },
  { id: "checking", label: "Ready: checking the account" },
  { id: "ready", label: "Ready" },
  { id: "two-accounts", label: "Ready: two accounts" },
  { id: "name-taken", label: "Ready: kinu already taken" },
  { id: "no-subdomain", label: "Ready: no workers.dev name yet" },
  { id: "r2", label: "Ready: R2 to turn on" },
  { id: "mail-conflict", label: "Ready: a domain that gets mail elsewhere" },
  { id: "running", label: "Deploying" },
  { id: "paused-r2", label: "Deploying: paused on R2" },
  { id: "paused-plan", label: "Deploying: paused on Workers Paid" },
  { id: "paused-signin", label: "Deploying: paused past an hour, sign in" },
  { id: "refused", label: "Deploying: one thing to change" },
  { id: "live", label: "Live" },
  { id: "live-domain", label: "Live: own domain" },
  { id: "live-pending", label: "Live: a domain still moving" },
  { id: "live-pending-ready", label: "Live: a domain ready to move onto" },
  { id: "manage", label: "An existing Kinu, an update out" },
  { id: "manage-current", label: "An existing Kinu, up to date" },
  { id: "manage-blocked", label: "An existing Kinu, an update it can't take here" },
  { id: "manage-two", label: "Two Kinus, one made with the CLI" },
  { id: "manage-domain", label: "An existing Kinu on its own domain" },
] as const;

export type DeployFixtureState = (typeof DEPLOY_FIXTURE_STATES)[number]["id"];

function stateNow(): DeployFixtureState {
  const said = new URLSearchParams(location.search).get("deploy");

  return DEPLOY_FIXTURE_STATES.find((each) => each.id === said)?.id ?? "start";
}

/** The gallery's address for `state`: the review's own parameters kept, the page's address set. */
export function deployStateHref(state: DeployFixtureState): string {
  const params = new URLSearchParams(location.search);
  const entry = DEPLOY_FIXTURE_STATES.find((each) => each.id === state);

  params.set("deploy", state);
  params.set("at", entry !== undefined && "at" in entry ? entry.at : "/deploy");

  return `${location.pathname}?${params.toString()}`;
}

// ── Reads ──────────────────────────────────────────────────────────────────────────────────────────────────────────

const BUILT = { version: "0.1.0+3c19318", sha: "3c19318", builtAt: "2026-10-14T09:12:00Z" };

const LATEST = { version: "0.1.0+694e257", sha: "694e257", builtAt: "2026-10-20T16:40:00Z" };

function offer(kind: "behind" | "current" | "blocked"): UpdateOffer {
  if (kind === "current") return { current: LATEST, available: LATEST, channelOrigin: "https://kinu.run", upToDate: true, installable: true, reason: "" };

  return {
    current: BUILT, available: LATEST, channelOrigin: "https://kinu.run", upToDate: false, installable: kind === "behind",
    reason: kind === "blocked" ? "This Kinu was set up by hand, so update it with kinu deploy cloudflare from your terminal." : "",
  };
}

function kinu(url: string, update: UpdateOffer, account: string = ACCOUNT, name = "kinu"): DeployedKinu {
  return { account, name, url, update };
}

const SIGNED_OUT: DeploySession = { signedIn: false, email: "", accounts: [], resume: null, deployments: [], unreadable: [] };

function signedIn(extra: Partial<DeploySession> = {}): DeploySession {
  return { signedIn: true, email: "ada@lovelace.dev", accounts: [ACCOUNTS[0]], resume: null, deployments: [], unreadable: [], ...extra };
}

const RUN_STATES: ReadonlySet<DeployFixtureState> = new Set(["running", "paused-r2", "paused-plan", "paused-signin", "refused", "live", "live-domain", "live-pending", "live-pending-ready"]);

function sessionOf(state: DeployFixtureState): DeploySession {
  if (state === "start" || state === "declined" || state === "unconfigured") return SIGNED_OUT;

  if (state === "two-accounts") return signedIn({ accounts: ACCOUNTS });

  if (state === "manage") return signedIn({ deployments: [kinu(`https://${WORKERS}`, offer("behind"))] });

  if (state === "manage-current") return signedIn({ deployments: [kinu(`https://${WORKERS}`, offer("current"))] });

  if (state === "manage-blocked") return signedIn({ deployments: [kinu(`https://${WORKERS}`, offer("blocked"))] });

  if (state === "manage-domain") return signedIn({ deployments: [kinu("https://kinu.flourandhearth.com", offer("current"))] });

  if (state === "manage-two") {
    return signedIn({
      accounts: ACCOUNTS,
      deployments: [kinu(`https://${WORKERS}`, offer("current")), kinu("https://kinu.flourandhearth.com", offer("blocked"), SECOND_ACCOUNT)],
    });
  }

  if (RUN_STATES.has(state) || begun) {
    const run = runOf(state);

    return signedIn({ resume: { runId: run.runId, account: run.account, phase: run.phase.id, state: run.state } });
  }

  return signedIn();
}

/** A need as the catalog words Cloudflare's refusal. */
function needOf(words: CloudflareWords): DeployNeed {
  const judged = judgeRefusal(words, ACCOUNT);

  return "need" in judged ? judged.need : SIGN_IN_AGAIN_NEED;
}

const R2_REFUSED: CloudflareWords = { message: "Please enable R2 through the Cloudflare Dashboard.", code: 10_042, status: 403, endpoint: `/accounts/${ACCOUNT}/r2/buckets` };

const PLAN_REFUSED: CloudflareWords = { message: "Containers are available on the Workers Paid plan.", status: 403, endpoint: `/accounts/${ACCOUNT}/containers/applications` };

function preflightOf(state: DeployFixtureState): DeployPreflight {
  return {
    workersSubdomain: state === "no-subdomain" ? null : "ada",
    suggestedName: state === "name-taken" ? "kinu-2" : "kinu",
    r2: state === "r2" ? "off" : "on",
    plan: "unknown",
    zones: ZONES,
    needs: state === "r2" ? [needOf(R2_REFUSED)] : [],
    checkedAt: "2026-10-21T08:00:00.000Z",
  };
}

/** As core's `domainsMatching` answers: the account's zones the query names, and a whole domain it does not hold. */
function domainsOf(query: string): readonly DeployDomain[] {
  const typed = query.trim().toLowerCase();
  const under = (zone: DeployZone) => typed === zone.name || typed.endsWith(`.${zone.name}`);

  const yours = ZONES.filter((zone) => typed === "" || zone.name.includes(typed) || under(zone))
    .map((zone): DeployDomain => ({ name: zone.name, state: "yours", zone: zone.id, status: zone.status }));

  return !/^[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}$/u.test(typed) || ZONES.some(under) ? yours : [...yours, { name: typed, state: "elsewhere" }];
}

/** As core's `mailHostPreview` answers a domain not sending yet: Email Routing's records under the host, and DMARC; an MX
 *  already pointing elsewhere is the conflict, beside the same records. */
function mailOf(state: DeployFixtureState, host: string): MailPreview {
  const conflict = state === "mail-conflict" && host === "flourandhearth.com" ? { mx: "in1-smtp.messagingengine.com", suggestion: "mail.flourandhearth.com" } : null;

  return {
    host,
    conflict,
    writes: [
      { type: "MX", name: host, content: "route1.mx.cloudflare.net", purpose: "receive" },
      { type: "MX", name: host, content: "route2.mx.cloudflare.net", purpose: "receive" },
      { type: "MX", name: host, content: "route3.mx.cloudflare.net", purpose: "receive" },
      { type: "TXT", name: host, content: "v=spf1 include:_spf.mx.cloudflare.net ~all", purpose: "send" },
      { type: "TXT", name: `_dmarc.${host}`, content: `v=DMARC1; p=none; rua=mailto:dmarc@${host}`, purpose: "report" },
    ],
    kept: [],
  };
}

// ── Runs ───────────────────────────────────────────────────────────────────────────────────────────────────────────

const STEPS = ["account", "kv", "r2", "vectorize", "ai-gateway", "seed", "secrets", "upload", "address", "smoke", "promote", "handover"] as const;

function row(id: string, seq: number, state: DeployStepRow["state"], extra: Partial<DeployStepRow> = {}): DeployStepRow {
  return { id, seq, title: id, state, attempt: state === "pending" ? 0 : 1, detail: "", notes: [], failure: null, facts: {}, ...extra };
}

/** The steps done before `at`, `at` itself in `state`, the rest still to come. */
function rowsAt(at: number, state: DeployStepRow["state"], extra: Partial<DeployStepRow> = {}): DeployStepRow[] {
  return STEPS.map((id, seq) => {
    if (seq < at) return row(id, seq, "done");

    return seq === at ? row(id, seq, state, extra) : row(id, seq, "pending");
  });
}

const RUN_ID = "gallery-run-0001";

/** Every step done, the address it answers on, and the one-time link while it holds one. */
function liveRows(address: string): DeployStepRow[] {
  return STEPS.map((id, seq) => row(id, seq, "done", id === "address" ? { facts: { [FACT_ADDRESS]: address } } : {}));
}

const SEAT = { link: `https://${WORKERS}/setup#seat-7f3a91`, expiresAt: Date.parse("2026-10-28T08:00:00Z") };

/** How far a run begun here has gone, in reads of it: half the steps a read, then live. */
let begun = false;

let reads = 0;

const NAMESERVERS = ["ada.ns.cloudflare.com", "jim.ns.cloudflare.com"];

/** The refusal of the address step: a record already there, which no catalog entry names, so the run says so plainly. */
const ADDRESS_REFUSED = { detail: "A DNS record with that host already exists.", code: 81_057, status: 400, endpoint: `/zones/${ZONES[0]?.id ?? ""}/dns_records` };

type Standing = Parameters<typeof deployRunView>[0];

/** Each state's run, past what every run holds; a state not named here is a run going through its upload. */
const FIXED_RUNS: Partial<Record<DeployFixtureState, Pick<Standing, "rows" | "state"> & Partial<Standing>>> = {
  "paused-r2": { rows: rowsAt(2, "running"), state: "running", paused: needOf(R2_REFUSED) },
  "paused-plan": { rows: rowsAt(7, "running"), state: "running", paused: needOf(PLAN_REFUSED) },
  "paused-signin": { rows: rowsAt(8, "pending"), state: "running", signedOut: true },
  refused: { rows: rowsAt(8, "failed", { failure: ADDRESS_REFUSED }), state: "failed" },
  live: { rows: liveRows(WORKERS), state: "done", seat: SEAT },
  "live-domain": { rows: liveRows("kinu.flourandhearth.com"), state: "done", mail: true, seat: SEAT },
  "live-pending": { rows: liveRows(WORKERS), state: "done", seat: SEAT, pending: { domain: "ada.dev", nameservers: NAMESERVERS, ready: false } },
  "live-pending-ready": { rows: liveRows(WORKERS), state: "done", seat: SEAT, pending: { domain: "ada.dev", nameservers: NAMESERVERS, ready: true } },
};

function standingOf(state: DeployFixtureState): Standing {
  const base = { runId: RUN_ID, account: ACCOUNT, mail: false, paused: null, signedOut: false, seat: null, pending: null, note: "", now: Date.parse("2026-10-21T08:00:00Z") };

  if (begun) {
    const at = Math.min(STEPS.length, reads * (STEPS.length / 2));

    return at >= STEPS.length
      ? { ...base, rows: liveRows(WORKERS), state: "done", seat: SEAT }
      : { ...base, rows: rowsAt(at, "running"), state: "running" };
  }

  const fixed = FIXED_RUNS[state];

  return fixed === undefined ? { ...base, rows: rowsAt(7, "running"), state: "running" } : { ...base, ...fixed };
}

function runOf(state: DeployFixtureState): DeployRunView {
  return deployRunView(standingOf(state));
}

// ── The door ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** What the door answers: its reads, a run begun, a hand-off, or a refusal in words. */
type DoorAnswer = DeploySession | DeployPreflight | readonly DeployDomain[] | MailPreview | DeployRunView | null | { readonly runId: string } | { readonly location: string } | { readonly error: string };

function json(body: DoorAnswer, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Never answered: the account's checks, while they run. */
const CHECKING = new Promise<Response>(() => undefined);

/** What the page asked the door to do, in order, for the review and its tests (`<html data-deploy-asked>`). */
function record(route: string, body: string | null): void {
  const asked: unknown[] = JSON.parse(document.documentElement.dataset.deployAsked ?? "[]");

  document.documentElement.dataset.deployAsked = JSON.stringify([...asked, { route, body: body === null ? null : JSON.parse(body) }]);
}

/** The page's door in the gallery; null for any other path. */
export function deployFixture(path: string, method: string, body: string | null): Promise<Response> | null {
  if (!path.startsWith("/api/deploy/")) return null;

  const url = new URL(path, location.origin);
  const state = stateNow();
  const route = url.pathname.slice("/api/deploy/".length);

  if (method === "POST") record(route, body);

  if (route === "signin" && method === "POST") {
    if (state === "unconfigured") return Promise.resolve(json({ error: "This Kinu has no Cloudflare OAuth client configured, so it cannot deploy to Cloudflare." }, 503));

    // Back from Cloudflare: a run waiting on a sign-in carries on, and anything else is signed in and ready.
    return Promise.resolve(json({ location: deployStateHref(state === "paused-signin" || state === "live-pending-ready" ? "running" : "ready") }));
  }

  if (route === "session") return Promise.resolve(json(sessionOf(state)));

  if (route === "preflight") return state === "checking" ? CHECKING : Promise.resolve(json(preflightOf(state)));

  if (route === "domains") return Promise.resolve(json(domainsOf(url.searchParams.get("q") ?? "")));

  if (route === "mail") return Promise.resolve(json(mailOf(state, url.searchParams.get("host") ?? "")));

  if (route === "runs" && method === "POST") {
    begun = true;
    reads = 0;

    return Promise.resolve(json({ runId: RUN_ID }));
  }

  if (route === "runs/current") {
    if (begun) reads += 1;

    return Promise.resolve(json(RUN_STATES.has(state) || begun ? runOf(state) : null));
  }

  if (route === "runs/current/continue" && method === "POST") {
    begun = true;

    return Promise.resolve(json(runOf(state)));
  }

  return Promise.resolve(json({ error: "No such deploy route." }, 404));
}
