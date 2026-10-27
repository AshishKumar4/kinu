/**
 * The deploy page's door, answered in the design gallery (`/deploy` in the whole app): the real page against fixtures
 * built by core's own rules, so the page shows only what the product can say. Runs are core's `deployRunView` of step
 * rows, refusals core's `judgeRefusal`, update offers core's `updateOffer`; a session resumes only a run the door would
 * (one unfinished, or live with a domain still moving), and a finished run is listed as a Kinu. `&deploy=` names the
 * state; a sign-in comes back to the state it leads to, and a run begun or carried on goes to live as the page reads it.
 */
import * as v from "valibot";
import {
  DEPLOY_GITHUB_PATH, DeployRunRequestSchema, FACT_ADDRESS, GITHUB_APP_NEW, GoogleClientSchema, SIGN_IN_AGAIN_NEED, deployRunView, githubAppManifest, judgeRefusal, updateOffer,
  type CloudflareWords, type DeployDomain, type DeployedKinu, type DeployNeed, type DeployPreflight, type DeployRefusal, type DeployRunView, type DeploySession,
  type DeployStepRow, type DeployZone, type MailPreview, type UpdateBuild,
} from "@kinu.run/core/deploy";

const ACCOUNT = "4b1ad7e0c3f24f6c9a51d2e8b7c60a13";

const SECOND_ACCOUNT = "9e2c41f07a6b4d3e8f15c0a9b2d7e684";

const ACCOUNTS = [{ id: ACCOUNT, name: "Ada Lovelace's account" }, { id: SECOND_ACCOUNT, name: "Flour & Hearth" }] as const;

const ZONES: readonly DeployZone[] = [{ id: "0c5e9a1d7b2f4e6a8c3d1f0b9e7a5c42", name: "flourandhearth.com", status: "active" }];

const WORKERS = "kinu.ada.workers.dev";

const ON_DOMAIN = "kinu.flourandhearth.com";

/** Each state the review opens, as the design bar lists it; `at` is the page's own address when it has a query. */
export const DEPLOY_FIXTURE_STATES = [
  { id: "start", label: "Start" },
  { id: "declined", label: "Start: Cloudflare's consent declined", at: "/deploy?error=access_denied&error_description=The+user+denied+the+request." },
  { id: "unconfigured", label: "Start: no OAuth client on this Kinu" },
  { id: "no-account", label: "New login: no Cloudflare account behind it" },
  { id: "free", label: "Free account: Workers Paid and R2 to do" },
  { id: "upgrading", label: "Free account: upgraded on Cloudflare, ticked off when read again" },
  { id: "checking", label: "Ready: checking the account" },
  { id: "ready", label: "Ready" },
  { id: "two-accounts", label: "Ready: two accounts" },
  { id: "name-taken", label: "Ready: kinu already taken" },
  { id: "no-subdomain", label: "Ready: no workers.dev name yet" },
  { id: "r2", label: "Ready: R2 to turn on" },
  { id: "no-credits", label: "Ready: no AI credits for web search" },
  { id: "credits-added", label: "Ready: credits bought on Cloudflare, ticked off when read again" },
  { id: "mail-conflict", label: "Ready: a domain that gets mail elsewhere" },
  { id: "mail-conflict-both", label: "Ready: a domain and its mail subdomain both getting mail elsewhere" },
  { id: "unreadable", label: "Ready: an account whose Kinus can't be read" },
  { id: "running", label: "Deploying" },
  { id: "running-hiccup", label: "Deploying: a read of it that fails once" },
  { id: "paused-r2", label: "Deploying: paused on R2" },
  { id: "paused-plan", label: "Deploying: paused on Workers Paid" },
  { id: "paused-signin", label: "Deploying: paused past an hour, sign in" },
  { id: "paused-signin-back", label: "Deploying: back from signing in, carrying on" },
  { id: "refused", label: "Deploying: one thing to change" },
  { id: "live", label: "Live" },
  { id: "live-domain", label: "Live: own domain with mail" },
  { id: "live-pending", label: "Live: a domain still moving" },
  { id: "live-pending-ready", label: "Live: a domain ready to move onto" },
  { id: "live-pending-back", label: "Live: back from signing in, moving onto it" },
  { id: "manage", label: "An existing Kinu, an update out" },
  { id: "manage-current", label: "An existing Kinu, up to date" },
  { id: "manage-unread", label: "An existing Kinu, its release channel unread" },
  { id: "manage-two", label: "Two Kinus in two accounts" },
  { id: "manage-domain", label: "An existing Kinu on its own domain" },
  { id: "manage-connected", label: "An existing Kinu with its own GitHub and Google apps" },
] as const;

export type DeployFixtureState = (typeof DEPLOY_FIXTURE_STATES)[number]["id"];

/** Where a sign-in in Cloudflare's window left the review: its end told the page, which reads the door again. */
let signedInAs: DeployFixtureState | null = null;

/** How often the account was read: an upgrade on Cloudflare shows on the read after the first. */
let preflightReads = 0;

function stateNow(): DeployFixtureState {
  const said = new URLSearchParams(location.search).get("deploy");

  return signedInAs ?? DEPLOY_FIXTURE_STATES.find((each) => each.id === said)?.id ?? "start";
}

/** Cloudflare's consent, in the gallery: given at once, so its window goes straight to the shared finish page. */
function consentGiven(run: string): string {
  return `${location.pathname}?${new URLSearchParams({ frame: "connected", run, service: "cloudflare-deploy" }).toString()}`;
}

/** The gallery's address for `state`: the review's own parameters kept, the page's address set. */
export function deployStateHref(state: DeployFixtureState): string {
  const params = new URLSearchParams(location.search);
  const entry = DEPLOY_FIXTURE_STATES.find((each) => each.id === state);

  params.set("deploy", state);
  params.set("at", entry !== undefined && "at" in entry ? entry.at : "/deploy");

  return `${location.pathname}?${params.toString()}`;
}

/** Where a sign-in from `state` comes back to: a run that waited on it carries on, and anything else is ready. */
function signedInFrom(state: DeployFixtureState): DeployFixtureState {
  if (state === "paused-signin") return "paused-signin-back";

  return state === "live-pending-ready" ? "live-pending-back" : "ready";
}

// ── Kinus and their updates ────────────────────────────────────────────────────────────────────────────────────────

const BUILT: UpdateBuild = { version: "0.1.0+3c19318", sha: "3c19318", builtAt: "2026-10-14T09:12:00Z" };

const LATEST: UpdateBuild = { version: "0.1.0+694e257", sha: "694e257", builtAt: "2026-10-20T16:40:00Z" };

/** Whether the review gave its Kinus a Google client of their own, as Save on the deploy page does. */
let googleOwn = false;

/** A Kinu the session lists: core's offer for its build against the channel's, and every listed Kinu is the account's. */
function kinu(host: string, current: UpdateBuild, available: UpdateBuild | null, account: string = ACCOUNT): DeployedKinu {
  return {
    account, name: "kinu", url: `https://${host}`, update: updateOffer({ current, available, channelOrigin: "https://kinu.run", owned: true }),
    connectors: { github: false, google: false },
  };
}

const LISTED: Partial<Record<DeployFixtureState, readonly DeployedKinu[]>> = {
  manage: [kinu(WORKERS, BUILT, LATEST)],
  "manage-current": [kinu(WORKERS, LATEST, LATEST)],
  "manage-unread": [kinu(WORKERS, BUILT, null)],
  "manage-domain": [kinu(ON_DOMAIN, LATEST, LATEST)],
  "manage-two": [kinu(WORKERS, LATEST, LATEST), kinu(ON_DOMAIN, BUILT, LATEST, SECOND_ACCOUNT)],
  "manage-connected": [{ ...kinu(WORKERS, LATEST, LATEST), connectors: { github: true, google: true } }],
};

// ── Runs ───────────────────────────────────────────────────────────────────────────────────────────────────────────

const STEPS = ["account", "kv", "r2", "vectorize", "ai-gateway", "seed", "secrets", "upload", "address", "smoke", "promote", "handover"] as const;

/** The address step: where a run that stopped on its address carries on from. */
const ADDRESS_STEP = STEPS.indexOf("address");

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

/** Every step done, and the address it answers on. */
function liveRows(address: string): DeployStepRow[] {
  return STEPS.map((id, seq) => row(id, seq, "done", id === "address" ? { facts: { [FACT_ADDRESS]: address } } : {}));
}

const RUN_ID = "gallery-run-0001";

const SEAT = { link: `https://${WORKERS}/setup#seat-7f3a91`, expiresAt: Date.parse("2026-10-28T08:00:00Z") };

const NAMESERVERS = ["ada.ns.cloudflare.com", "jim.ns.cloudflare.com"];

type Standing = Parameters<typeof deployRunView>[0];

const BASE: Omit<Standing, "rows" | "state"> = {
  runId: RUN_ID, account: ACCOUNT, mail: false, paused: null, signedOut: false, seat: null, pending: null, note: "", now: Date.parse("2026-10-21T08:00:00Z"),
};

/** A need as the catalog words Cloudflare's refusal. */
function needOf(words: CloudflareWords): DeployNeed {
  const judged = judgeRefusal(words, ACCOUNT);

  return "need" in judged ? judged.need : SIGN_IN_AGAIN_NEED;
}

const R2_REFUSED: CloudflareWords = { message: "Please enable R2 through the Cloudflare Dashboard.", code: 10_042, status: 403, endpoint: `/accounts/${ACCOUNT}/r2/buckets` };

/** As Cloudflare refused it on Workers Free (core's refusals table, measured 2026-10-21). */
const PLAN_REFUSED: CloudflareWords = {
  message: "Unauthorized: You do not have access to Cloudflare Containers. Deploying containers requires the Workers Paid plan.",
  code: 1000, status: 401, endpoint: `/accounts/${ACCOUNT}/containers/applications`,
};

/** The refusal of the address step: a record already there, which no catalog entry names, so the run says so plainly. */
const ADDRESS_REFUSED = { detail: "A DNS record with that host already exists.", code: 81_057, status: 400, endpoint: `/zones/${ZONES[0]?.id ?? ""}/dns_records` };

/**
 * A run going by itself: begun here, carried on, or found on the way. It finishes in two reads of it, from `from`.
 * Where it lands: its address, the setup link a new Kinu gets, mail, and a domain still moving onto Cloudflare.
 */
interface Going {
  readonly from: number;
  readonly address: string;
  readonly seat: boolean;
  readonly mail: boolean;
  readonly pending: Standing["pending"];
}

const GOING: Going = { from: 0, address: WORKERS, seat: true, mail: false, pending: null };

/** Each state's run as found, when it is one going by itself. */
const GOING_FROM: Partial<Record<DeployFixtureState, Going>> = {
  running: { ...GOING, from: STEPS.indexOf("upload") },
  "running-hiccup": { ...GOING, from: STEPS.indexOf("upload") },
  live: { ...GOING, from: STEPS.length - 1 },
  "live-domain": { ...GOING, from: STEPS.length - 1, address: ON_DOMAIN, mail: true },
};

/** Each state's run as found, when it is one waiting: on a need, on a sign-in, or refused. */
const STOPPED: Partial<Record<DeployFixtureState, Pick<Standing, "rows" | "state"> & Partial<Standing>>> = {
  "paused-r2": { rows: rowsAt(2, "running"), state: "running", paused: needOf(R2_REFUSED) },
  "paused-plan": { rows: rowsAt(7, "running"), state: "running", paused: needOf(PLAN_REFUSED) },
  "paused-signin": { rows: rowsAt(ADDRESS_STEP, "pending"), state: "running", signedOut: true },
  // Back from signing in: the run still waits on it until the page carries it on with the new sign-in.
  "paused-signin-back": { rows: rowsAt(ADDRESS_STEP, "pending"), state: "running", signedOut: true },
  refused: { rows: rowsAt(ADDRESS_STEP, "failed", { failure: ADDRESS_REFUSED }), state: "failed" },
  "live-pending": { rows: liveRows(WORKERS), state: "done", seat: SEAT, pending: { domain: "ada.dev", nameservers: NAMESERVERS, ready: false } },
  "live-pending-ready": { rows: liveRows(WORKERS), state: "done", seat: SEAT, pending: { domain: "ada.dev", nameservers: NAMESERVERS, ready: true } },
  "live-pending-back": { rows: liveRows(WORKERS), state: "done", seat: SEAT, pending: { domain: "ada.dev", nameservers: NAMESERVERS, ready: true } },
};

/** Where a carry-on from a stopped state goes. */
const CARRIED_ON: Partial<Record<DeployFixtureState, Going>> = {
  refused: { ...GOING, from: ADDRESS_STEP, address: ON_DOMAIN },
  "paused-signin-back": { ...GOING, from: ADDRESS_STEP },
  "live-pending-back": { ...GOING, from: ADDRESS_STEP, address: "kinu.ada.dev", seat: false },
};

/** The run going now, and how many times it has been read. */
let going: Going | null = GOING_FROM[stateNow()] ?? null;

let reads = 0;

function stepOf(run: Going): number {
  const stride = Math.max(1, Math.ceil((STEPS.length - run.from) / 2));

  return Math.min(STEPS.length, run.from + reads * stride);
}

function goingView(run: Going): DeployRunView {
  const at = stepOf(run);
  const done = at >= STEPS.length;

  return deployRunView({
    ...BASE, mail: run.mail, pending: done ? run.pending : null, seat: done && run.seat ? SEAT : null,
    rows: done ? liveRows(run.address) : rowsAt(at, "running"), state: done ? "done" : "running",
  });
}

/** The run as the door reads it now, or null for none. */
function runNow(state: DeployFixtureState): DeployRunView | null {
  if (going !== null) return goingView(going);

  const stopped = STOPPED[state];

  return stopped === undefined ? null : deployRunView({ ...BASE, ...stopped });
}

/** A finished run is a Kinu the session lists; an unfinished one, or one live with a domain still moving, is resumed. */
function sessionOf(state: DeployFixtureState): DeploySession {
  if (state === "start" || state === "declined" || state === "unconfigured") {
    return { signedIn: false, email: "", accounts: [], resume: null, deployments: [], unreadable: [] };
  }

  const accounts = state === "two-accounts" || state === "manage-two" || state === "unreadable" ? ACCOUNTS : [ACCOUNTS[0]];
  const run = runNow(state);
  const finished = run !== null && run.state === "live" && run.live?.pending === undefined;
  const resume = run === null || finished ? null : { runId: run.runId, account: run.account, phase: run.phase.id, state: run.state };
  const listed = finished && run.live !== undefined ? [kinu(new URL(run.live.url).hostname, LATEST, LATEST)] : LISTED[state] ?? [];
  const unreadable = state === "unreadable" ? [{ account: SECOND_ACCOUNT, words: { message: "Authentication error", code: 10_000, status: 403, endpoint: `/accounts/${SECOND_ACCOUNT}/workers/scripts` } }] : [];

  const deployments = listed.map((each) => ({ ...each, connectors: { ...each.connectors, google: googleOwn || each.connectors.google } }));

  return { signedIn: true, email: "ada@lovelace.dev", accounts: state === "no-account" ? [] : accounts, resume, deployments, unreadable };
}

// ── Reads ──────────────────────────────────────────────────────────────────────────────────────────────────────────

function preflightOf(state: DeployFixtureState): DeployPreflight {
  preflightReads += 1;
  const free = state === "free" || (state === "upgrading" && preflightReads === 1);
  const noR2 = state === "r2" || state === "free" || state === "upgrading";

  return {
    workersSubdomain: state === "no-subdomain" ? null : "ada",
    suggestedName: state === "name-taken" ? "kinu-2" : "kinu",
    r2: noR2 ? "off" : "on",
    plan: free ? "free" : "paid",
    zones: ZONES,
    needs: [...free ? [needOf(PLAN_REFUSED)] : [], ...noR2 ? [needOf(R2_REFUSED)] : []],
    credits: state === "no-credits" || (state === "credits-added" && preflightReads === 1)
      ? { balance: 0, card: false, autoTopUp: null }
      : { balance: 18.4, card: true, autoTopUp: { threshold: 5, amount: 20 } },
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
/** Hosts that already get mail elsewhere, by state: core suggests the host's own mail subdomain for each. */
const TAKEN: Partial<Record<DeployFixtureState, readonly string[]>> = {
  "mail-conflict": ["flourandhearth.com"],
  "mail-conflict-both": ["flourandhearth.com", "mail.flourandhearth.com"],
};

function mailOf(state: DeployFixtureState, host: string): MailPreview {
  const conflict = (TAKEN[state] ?? []).includes(host) ? { mx: "in1-smtp.messagingengine.com", suggestion: `mail.${host}` } : null;

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

/** Where a run the page asked for lands, read as the door reads what it is asked (core's `DeployRunRequestSchema`). */
function goingFor(body: string | null): Going {
  const asked = v.parse(DeployRunRequestSchema, JSON.parse(body ?? "null"));

  if (asked.kind === "update") return { ...GOING, seat: false };

  const address = asked.address ?? null;
  const mail = asked.mail !== undefined && asked.mail !== null;

  // A domain registered elsewhere: the Kinu starts on workers.dev, and the domain waits on its nameservers.
  if (address?.kind === "domain" && address.domain !== undefined) return { ...GOING, seat: asked.kind === "new", mail, pending: { domain: address.domain, nameservers: NAMESERVERS, ready: false } };

  const host = address?.kind === "domain" ? address.host : WORKERS;

  return { ...GOING, address: host, mail, seat: asked.kind === "new" || asked.setupLink === true };
}

// ── The door ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** What the door answers: its reads, a run begun, a hand-off, or a refusal in words. */
type DoorAnswer =
  | DeploySession | DeployPreflight | readonly DeployDomain[] | MailPreview | DeployRunView | null | { readonly runId: string } | { readonly location: string }
  | { readonly action: string; readonly manifest: string } | { readonly google: boolean }
  | { readonly error: string; readonly need?: DeployNeed; readonly refused?: DeployRefusal };

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

/** A carry-on: a stopped state goes on from where it stopped; one whose sign-in ran out is refused until there is one. */
function carryOn(state: DeployFixtureState): Response {
  if (state === "paused-signin" || state === "live-pending-ready") return json({ error: SIGN_IN_AGAIN_NEED.sentence, need: SIGN_IN_AGAIN_NEED }, 401);

  going = CARRIED_ON[state] ?? going ?? GOING;
  reads = 1;

  return json(goingView(going));
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

    const asked = v.parse(v.object({ run: v.string() }), JSON.parse(body ?? "{}"));

    signedInAs = signedInFrom(state);

    return Promise.resolve(json({ location: consentGiven(asked.run) }));
  }

  if (route === "session") return Promise.resolve(json(sessionOf(state)));

  if (route === "preflight") return state === "checking" ? CHECKING : Promise.resolve(json(preflightOf(state)));

  if (route === "domains") return Promise.resolve(json(domainsOf(url.searchParams.get("q") ?? "")));

  if (route === "mail") return Promise.resolve(json(mailOf(state, url.searchParams.get("host") ?? "")));

  if (route === "runs" && method === "POST") {
    going = goingFor(body);
    reads = 0;

    return Promise.resolve(json({ runId: RUN_ID }));
  }

  if (route === "runs/current") {
    if (going !== null) reads += 1;

    // The page's second read of the run, refused as Cloudflare refuses a request it could not serve: said, and read again.
    if (state === "running-hiccup" && reads === 2) {
      const judged = judgeRefusal({ message: "Internal server error", code: 10_013, status: 500, endpoint: `/accounts/${ACCOUNT}/workers/scripts/kinu` }, ACCOUNT);

      return Promise.resolve("refused" in judged ? json({ error: judged.refused.sentence, refused: judged.refused }, 502) : json({ error: judged.need.sentence, need: judged.need }, 409));
    }

    return Promise.resolve(json(runNow(state)));
  }

  if (route === "runs/current/continue" && method === "POST") return Promise.resolve(carryOn(state));

  return Promise.resolve(connectorAnswer(route, body));
}

/** The connectors' routes (GitHub's form for the Kinu asked, Google's own client set or taken away), and the door's
 *  answer to a route it has none for. */
function connectorAnswer(route: string, body: string | null): Response {
  if (route === "github") {
    const manifest = githubAppManifest(`https://${WORKERS}`, new URL(DEPLOY_GITHUB_PATH, location.origin).href);

    return json({ action: `${GITHUB_APP_NEW}?state=gallery`, manifest: JSON.stringify(manifest) });
  }

  if (route !== "google") return json({ error: "No such deploy route." }, 404);
  const asked = v.safeParse(v.object({ client: v.nullable(GoogleClientSchema) }), JSON.parse(body ?? "{}"));

  if (!asked.success) return json({ error: asked.issues[0]?.message ?? "That is not a Google client." }, 400);
  googleOwn = asked.output.client !== null;

  return json({ google: googleOwn });
}
