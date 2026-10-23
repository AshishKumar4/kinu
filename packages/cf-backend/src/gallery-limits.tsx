/**
 * The free tier's screens (core limits/) on fixed accounts, for review and shots: `limits&state=normal|near|full|invited`
 * draws Settings › Usage's section, the bar above every page, the turn the day's models stopped, Move my data and the
 * operators' accounts; `&dialog=workspaces|storage|computer|elsewhere|models` opens a refusal's dialog over them. The
 * operators' Invite and Suspend open from their buttons. The page's reads never reach the network.
 */
import { useEffect, type ReactNode } from "react";
import type { AccountLimits, LimitReading, LimitsReport } from "@kinu.run/core";
import type { AccountRow } from "@/lib/control-api";
import { LimitBanner } from "@/components/limits/LimitBanner";
import { LimitRefusalProvider, useLimitRefusal } from "@/components/limits/LimitRefusal";
import { UsageLimits } from "@/components/limits/UsageLimits";
import { ModelsUsedUp } from "@/components/limits/limit-words";
import { MoveMyDataSlot } from "@/components/limits/MoveMyDataCard";
import { AccountStanding, AccountsTable } from "@/components/control/AccountsView";
import { Surface } from "@/components/ui/Surface";

const NOW = Date.now();

const GB = 1024 ** 3;

const MONTH_END = Date.UTC(new Date(NOW).getUTCFullYear(), new Date(NOW).getUTCMonth() + 1, 1);

const DAY_END = Date.UTC(new Date(NOW).getUTCFullYear(), new Date(NOW).getUTCMonth(), new Date(NOW).getUTCDate() + 1);

const params = new URLSearchParams(location.search);

type State = "normal" | "near" | "full" | "invited";

const STATES: readonly State[] = ["normal", "near", "full", "invited"];

const state: State = STATES.find((each) => each === params.get("state")) ?? "normal";

function reading(id: LimitReading["id"], used: number, limit: number): LimitReading {
  const unit = { workspaces: "count", computers_running: "count", computer_hours: "seconds", stored_bytes: "bytes", model_tokens: "tokens" } as const;
  const resetsAt = { workspaces: null, computers_running: null, computer_hours: MONTH_END, stored_bytes: null, model_tokens: DAY_END } as const;

  return { id, used, limit, unit: unit[id], resetsAt: resetsAt[id], near: used >= limit * 0.8, reached: used >= limit };
}

/** A free account's use, as the owner's boards draw it at each stage. */
function use(stage: Exclude<State, "invited">): LimitReading[] {
  const at = {
    normal: { workspaces: 2, hours: 11, bytes: 1.2 * GB, tokens: 225_000 },
    near: { workspaces: 2, hours: 17, bytes: 1.7 * GB, tokens: 400_000 },
    full: { workspaces: 3, hours: 12, bytes: 1.2 * GB, tokens: 500_000 },
  }[stage];

  return [
    reading("workspaces", at.workspaces, 3),
    reading("computer_hours", at.hours * 3600, 20 * 3600),
    reading("computers_running", 0, 1),
    reading("stored_bytes", at.bytes, 2 * GB),
    reading("model_tokens", at.tokens, 500_000),
  ];
}

const REPORT: LimitsReport = state === "invited"
  ? { class: "invited", suspended: null, limits: [], computerSizeCap: null }
  : { class: "free", suspended: null, limits: use(state), computerSizeCap: "small" };

const account = (report: LimitsReport, readings: LimitReading[]): AccountLimits => ({ report, use: readings });

const row = (email: string, seen: number, limits: AccountLimits): AccountRow => ({
  userId: email.replace(/\W/gu, "").padEnd(32, "0").slice(0, 32), email, displayName: null, firstSeenAt: seen - 30 * 864e5, lastSeenAt: seen,
  workspaces: limits.use[0]?.used ?? 0, class: limits.report.class === "invited" ? "invited" : "free", suspendedAt: limits.report.suspended?.at ?? null, limits,
});

const FREE = { class: "free", suspended: null, computerSizeCap: "small" } as const;

const UNBOUND = { suspended: null, limits: [], computerSizeCap: null } as const;

/** The board's five accounts: one at a limit, one near one, one invited, one suspended, and the operator. */
const ACCOUNTS: readonly AccountRow[] = [
  row("ada@example.com", NOW - 2 * 3600e3, account({ ...FREE, limits: use("full") }, use("full"))),
  row("bo@example.com", NOW - 60e3, account({ ...FREE, limits: use("near") }, use("near"))),
  row("cy@example.com", NOW - 864e5, account({ class: "invited", ...UNBOUND }, [reading("workspaces", 7, 3), reading("computer_hours", 63 * 3600, 20 * 3600), reading("stored_bytes", 5.8 * GB, 2 * GB), reading("model_tokens", 0, 500_000)])),
  row("dee@example.com", NOW - 12 * 864e5, account({ ...FREE, suspended: { at: NOW - 3 * 864e5, reason: "Spam sign-ups from one address" }, limits: use("normal") }, use("normal"))),
  row("owner@kinu.run", NOW - 30e3, account({ class: "operator", ...UNBOUND }, [reading("workspaces", 11, 3), reading("computer_hours", 140 * 3600, 20 * 3600), reading("stored_bytes", 22 * GB, 2 * GB), reading("model_tokens", 0, 500_000)])),
];

/** Each refusal as its object words it (core limits/admit.ts), as a page's failed ask carries it. */
const REFUSALS = {
  workspaces: "This account has its 3 free workspaces. Remove one to make another, or run your own Kinu with no limits at /deploy (Settings → Backup downloads your data to bring along).",
  storage: "This account stores 1.9 GB, past its free 2 GB, so a new upload cannot be added. Remove files or workspaces to make room, or run your own Kinu with no limits at /deploy.",
  computer: `This account's computers have run their free 20 hours this month (20.0 hours); the hours start again on ${new Date(MONTH_END).toISOString().slice(0, 10)}. Until then, or run your own Kinu with no limits at /deploy.`,
  elsewhere: "This account's free computer is running in release-notes. Stop it there to start one here, or run your own Kinu with no limits at /deploy.",
  models: "Request refused before submission: today's free model use is spent (500,000 of 500,000 tokens); it starts again at 00:00 UTC.",
} as const;

function answerReads(): void {
  const next = window.fetch.bind(window);

  window.fetch = Object.assign(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(new Request(input, init).url);

    if (url.pathname === "/api/user/limits") return Response.json(REPORT);

    if (url.pathname === "/api/control/actions") return Response.json({ outcome: "ok", detail: "done", result: { path: "/invite/7f3a9c", expiresAt: NOW + 7 * 864e5 } });

    return next(input, init);
  }, { preconnect: next.preconnect });
}

/** Opens `&dialog=`'s refusal as the page that asked would, once mounted. */
function AskedFor() {
  const offer = useLimitRefusal();
  const asked = params.get("dialog");

  useEffect(() => {
    const words = Object.entries(REFUSALS).find(([name]) => name === asked)?.[1];

    if (words !== undefined) offer({ cause: new Error(words) }, asked === "storage" ? { file: { name: "report.zip", size: 240 * 1024 ** 2 } } : {});
  }, [asked, offer]);

  return null;
}

function Shot({ caption, children }: { caption: string; children: ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="t-label p-text-3">{caption}</h2>
      {children}
    </section>
  );
}

function LimitsFrame() {
  return (
    <LimitRefusalProvider>
      <Surface look="page" className="min-h-screen p-text">
        <LimitBanner />
        <div className="mx-auto max-w-4xl space-y-10 px-4 py-6 md:px-8">
          <Shot caption="Settings › Usage"><UsageLimits /></Shot>
          <Shot caption="A turn on Kinu's models, stopped by the day's limit"><ModelsUsedUp /></Shot>
          <Shot caption="Settings › Account › Move my data"><MoveMyDataSlot /></Shot>
          <Shot caption="Control › Accounts">
            <AccountsTable rows={ACCOUNTS} onOpen={() => undefined} onChanged={() => undefined} />
          </Shot>
          <Shot caption="Control › One account">
            <Surface look="panel" className="px-5 py-4">
              <AccountStanding userId={ACCOUNTS[1]?.userId ?? ""} email="bo@example.com" seen={NOW - 60e3} limits={ACCOUNTS[1]?.limits ?? account(REPORT, [])} onChanged={() => undefined} />
            </Surface>
          </Shot>
        </div>
      </Surface>
      <AskedFor />
    </LimitRefusalProvider>
  );
}

export default function limitsFrame() {
  answerReads();

  return { entries: ["/user/settings#usage"], node: <LimitsFrame /> };
}
