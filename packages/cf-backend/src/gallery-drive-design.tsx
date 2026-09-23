import { Navigate, Route, Routes } from "react-router-dom";
import Layout from "@/components/layout";
import {
  DriveDesignPage, SKILLS_FOLDER, type Dialog, type DriveData, type DriveEntry, type GivenItem, type ReceivedItem,
  type SlateItem,
} from "@/drive-design/DriveDesignPage";
import type { ShareSubject } from "@/drive-design/ShareDialog";
import { SharedWorkspaceView } from "@/drive-design/SharedWorkspaceView";
import { ReviewBar } from "@/drive-design/ReviewBar";
import type { Preview } from "@/drive-design/previews";
import type { Person } from "@/drive-design/tiles";

const ME: Person = { name: "Ashish", email: "ashish@example.com" };

const SAM: Person = { name: "Sam Lee", email: "sam@example.com" };

const LEE: Person = { name: "Lee Park", email: "lee@example.com" };

const coupons: Preview = { kind: "slate", art: "coupons" };

const issues: Preview = { kind: "slate", art: "issues" };

const SLATES: readonly SlateItem[] = [
  {
    id: "coupon-board", title: "Coupon board", workspace: "checkout-fixes", workspaceTitle: "Checkout coupon bug",
    updated: "12m", preview: coupons, access: { kind: "people", people: [SAM, LEE] },
  },
  {
    id: "landing-perf", title: "Landing perf report", workspace: "perf-audit", workspaceTitle: "Perf audit — landing",
    updated: "2h", preview: { kind: "slate", art: "perf" },
  },
  {
    id: "receipts", title: "Receipts ledger", workspace: "email-triage", workspaceTitle: "Email triage automation",
    updated: "1d", preview: { kind: "slate", art: "ledger" },
  },
  {
    id: "release", title: "Release checklist", workspace: "checkout-fixes", workspaceTitle: "Checkout coupon bug",
    updated: "3d", preview: { kind: "slate", art: "release" },
  },
  {
    id: "palette", title: "Token palette", workspace: "design-sys", workspaceTitle: "Design system v2",
    updated: "5d", preview: { kind: "slate", art: "palette" },
  },
  {
    id: "issue-board", title: "Issue board", workspace: "checkout-fixes", workspaceTitle: "Checkout coupon bug",
    updated: "1w", preview: issues, access: { kind: "link" },
  },
];

const RECEIVED: readonly ReceivedItem[] = [
  { id: "inbox-digest", kind: "live", title: "Inbox digest", from: SAM, when: "2h", unseen: true, preview: { kind: "slate", art: "inbox" } },
  { id: "deploy-board", kind: "blueprint", title: "Deploy status board", from: LEE, when: "1d", unseen: true, preview: { kind: "cover", hue: 152, letter: "D" } },
  { id: "q3-launch", kind: "workspace", title: "Q3 launch plan", from: LEE, when: "3d", unseen: false, preview: { kind: "cover", hue: 32, letter: "Q" } },
];

const GIVEN: readonly GivenItem[] = [
  { id: "coupon-board", kind: "live", title: "Coupon board", access: { kind: "people", people: [SAM, LEE] }, preview: coupons },
  { id: "issue-board", kind: "live", title: "Issue board", access: { kind: "link" }, preview: issues, status: "Paused today: limit reached" },
  { id: "landing-perf", kind: "blueprint", title: "Landing perf report", access: { kind: "link" }, preview: { kind: "cover", hue: 262, letter: "L" } },
  { id: "checkout-fixes", kind: "workspace", title: "Checkout coupon bug", access: { kind: "people", people: [SAM] }, preview: { kind: "cover", hue: 212, letter: "C" } },
];

const ROOT: readonly DriveEntry[] = [
  { kind: "folder", name: "skills" },
  { kind: "folder", name: "data" },
  { kind: "folder", name: "notes" },
  { kind: "folder", name: "projects" },
  {
    kind: "file", name: "runbook.md", size: "2 KB", updated: "2h",
    preview: {
      kind: "doc", heading: "Runbook",
      lines: ["When the checkout alarms fire, start", "with the coupon service dashboard.", "", "1. Check the error budget", "2. Roll back the last deploy", "3. Page the on-call owner", "", "Escalate after fifteen minutes."],
    },
  },
  {
    kind: "file", name: "q3-metrics.csv", size: "18 KB", updated: "1d",
    preview: {
      kind: "sheet",
      rows: [["week", "orders", "aov", "refunds"], ["w27", "4,112", "$61.20", "38"], ["w28", "4,386", "$63.05", "41"], ["w29", "4,020", "$59.80", "33"], ["w30", "4,771", "$64.10", "29"], ["w31", "5,004", "$65.35", "31"], ["w32", "5,210", "$66.00", "27"]],
    },
  },
  { kind: "file", name: "architecture.png", size: "240 KB", updated: "3d", preview: { kind: "diagram" } },
  { kind: "file", name: "brand-guide.pdf", size: "1.2 MB", updated: "12d", preview: { kind: "pdf", heading: "Brand guide" } },
  {
    kind: "file", name: "seed-orders.ts", size: "4 KB", updated: "2w",
    preview: {
      kind: "code",
      lines: ["import { db } from './db';", "", "export async function seed() {", "  const rows = await load('orders');", "  for (const row of rows) {", "    await db.insert(row);", "  }", "  return rows.length;", "}"],
    },
  },
  { kind: "file", name: "exports-2026-08.zip", size: "36 MB", updated: "1mo", preview: { kind: "generic", ext: "zip" } },
];

const SKILLS: readonly DriveEntry[] = [
  {
    kind: "skill", name: "deploy", description: "Build, run the checks, deploy, then watch the first ten minutes.", updated: "2d",
    steps: ["Build and run the checks", "Deploy to production", "Watch errors for ten minutes", "Roll back if the rate climbs"],
  },
  {
    kind: "skill", name: "review", description: "Read a diff for bugs, missing tests and unclear names.", updated: "5d",
    steps: ["Read the diff end to end", "Name each bug and its line", "Ask for the missing tests", "Suggest clearer names"],
  },
  {
    kind: "skill", name: "triage", description: "Sort new issues by area and urgency, and draft a first reply.", updated: "2w",
    steps: ["Read the new issues", "Tag the area and urgency", "Draft a first reply", "Name an owner"],
  },
];

const OPS: readonly DriveEntry[] = [
  { kind: "folder", name: "staging" },
  {
    kind: "file", name: "deploy.sh", size: "1 KB", updated: "4h",
    preview: { kind: "code", lines: ["#!/usr/bin/env bash", "set -euo pipefail", "", "bun run build", "bun test --bail", "wrangler deploy \\", "  --env production", "echo \"deployed $(git rev-parse --short HEAD)\""] },
  },
  {
    kind: "file", name: "incident-0914.md", size: "3 KB", updated: "9d",
    preview: { kind: "doc", heading: "Incident 09-14", lines: ["Coupons applied twice at checkout", "for 22 minutes after the 2.13 deploy.", "", "Cause: the guard ran after the", "discount was written.", "", "Fix: move the guard ahead of the write."] },
  },
  {
    kind: "file", name: "rollback.md", size: "1 KB", updated: "3w",
    preview: { kind: "doc", heading: "Rollback", lines: ["wrangler rollback --env production", "", "Then confirm the error rate falls", "below 0.1% within five minutes."] },
  },
  { kind: "file", name: "q3-report.pdf", size: "2.4 MB", updated: "now", preview: { kind: "upload", progress: 0.64 } },
];

const FULL: DriveData = {
  me: ME,
  slates: SLATES,
  received: RECEIVED,
  given: GIVEN,
  folders: {
    "/": ROOT,
    [SKILLS_FOLDER]: SKILLS,
    "/data": [],
    "/notes": [],
    "/projects": [{ kind: "folder", name: "ops" }, { kind: "folder", name: "web" }],
    "/projects/ops": OPS,
    "/projects/ops/staging": [],
    "/projects/web": [],
  },
};

const DATA = {
  full: FULL,
  empty: { me: ME, slates: [], received: [], given: [], folders: { "/": [], [SKILLS_FOLDER]: [] } },
  recipient: {
    me: ME, slates: [], given: [], folders: { "/": [], [SKILLS_FOLDER]: [] },
    received: RECEIVED.filter((item) => item.kind !== "blueprint").map((item) => ({ ...item, unseen: true })),
  },
  "files-only": { ...FULL, slates: [], received: [], given: [] },
} satisfies Record<string, DriveData>;

const COUPON_BOARD: ShareSubject = { kind: "slate", title: "Coupon board", owner: ME, access: { kind: "people", people: [SAM, LEE] } };

const DIALOGS = {
  share: { kind: "share", subject: COUPON_BOARD, pane: "live" },
  "share-access": { kind: "share", subject: COUPON_BOARD, pane: "live", accessOpen: true },
  "share-reach": { kind: "share", subject: COUPON_BOARD, pane: "reach" },
  "share-limits": { kind: "share", subject: COUPON_BOARD, pane: "limits" },
  "share-activity": { kind: "share", subject: COUPON_BOARD, pane: "activity" },
  "share-blueprint": { kind: "share", subject: COUPON_BOARD, pane: "blueprint" },
  "share-workspace": {
    kind: "share", pane: "workspace",
    subject: { kind: "workspace", title: "Checkout coupon bug", owner: ME, access: { kind: "people", people: [SAM] } },
  },
  stop: { kind: "stop", title: "Coupon board", who: "Sam Lee and Lee Park" },
} satisfies Record<string, Dialog>;

export function driveDesignFrame() {
  const params = new URLSearchParams(location.search);
  const theme = params.get("theme");

  if (theme === "dark" || theme === "light") {
    localStorage.setItem("theme", theme);
    document.documentElement.setAttribute("data-mode", theme);
    document.documentElement.style.colorScheme = theme;
  }

  const page = (
    <DriveDesignPage data={Object.entries(DATA).find(([name]) => name === params.get("data"))?.[1] ?? FULL}
      initialDialog={Object.entries(DIALOGS).find(([name]) => name === params.get("dialog"))?.[1] ?? null}
      menuFor={params.get("menu")} dropping={params.get("drop") === "1"} />
  );

  return {
    entries: [params.get("path") ?? "/drive"],
    node: (
      <>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/drive" element={page} />
            <Route path="/drive/:place/*" element={page} />
            <Route path="/shared/workspace/:id" element={<SharedWorkspaceView title="Q3 launch plan" owner={LEE} />} />
            <Route path="*" element={<Navigate to="/drive" replace />} />
          </Route>
        </Routes>
        {params.get("review") !== "0" && <ReviewBar />}
      </>
    ),
  };
}
