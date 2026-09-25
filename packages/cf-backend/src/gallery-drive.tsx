/** Gallery Drive frames on an in-memory tenant running the core Drive rules; `/api/shared` answers a fixed library. */
import { lazy, Suspense } from "react";
import { Loader } from "@cloudflare/kumo";
import { Route, Routes } from "react-router-dom";
import * as v from "valibot";
import Sidebar from "@/components/Sidebar";
import {
  addSkill, APP_ROUTES, deleteDriveEntry, listDrive, makeDriveFolder, markAsSkill, mossaicVfs, packDriveFolder, receiveDriveUpload,
  renameDriveEntry, SKILL_FOLDER_FILE, type DriveListing, type DriveUploadOutcome, type DriveUploadTarget,
  type MarkedSkill, type MossaicVfs, type SharedLibrary,
} from "@kinu.run/core";
import { KinuError, renderThrownChain, type ErrorCode } from "@kinu.run/core/obs";
import { fakeMossaic } from "@kinu.run/test-utils/mossaic";

const DrivePage = lazy(() => import("@/pages/DrivePage"));

const SKILL = (name: string, description: string): string => `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n\nSteps.\n`;

async function seededDrive(): Promise<MossaicVfs> {
  const drive = mossaicVfs(fakeMossaic().tenant("gallery-owner"));
  const write = (path: string, text: string) => drive.writeFile(path, text);

  await write("/README.md", "# Drive\n\nShared across every workspace.\n");
  await write("/data/customers.csv", "id,name\n1,Ada\n2,Grace\n".repeat(400));
  await write("/data/notes.txt", "call back on Tuesday");
  await write("/projects/ops/deploy/SKILL.md", SKILL("deploy", "Ship the current branch to production"));
  await write("/projects/ops/deploy/scripts/run.sh", "#!/bin/sh\necho ship\n");
  await write("/projects/ops/runbook.md", "# Runbook\n");
  await write("/notes/todo.md", "- write the skill\n");
  await write("/skills/review/SKILL.md", SKILL("review", "Review a pull request the way this team does"));
  await write("/skills/slates/SKILL.md", SKILL("slates", "The team's own notes on building slates"));
  await write("/skills/review.md", SKILL("review", "An older review, beside the folder that replaced it"));
  await write("/skills/slates.md", SKILL("slates", "A flat copy of the team's slate notes"));
  await write("/skills/standup.md", SKILL("standup", "Write the morning standup from yesterday's commits"));

  return drive;
}

const STATUS: Readonly<Record<ErrorCode, number>> = {
  bad_input: 400, denied: 403, missing: 404, unsupported: 415, budget: 413, unavailable: 503, timeout: 504, cancelled: 400, oom: 507, io: 500,
};

type DriveAnswerBody = DriveListing | DriveUploadOutcome | MarkedSkill | { error: string };

function answer(body: DriveAnswerBody, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

const PathBody = v.object({ path: v.string() });

const RenameBody = v.object({ from: v.string(), to: v.string() });

const SkillBody = v.object({ skill: v.string() });

async function bodyJson<Schema extends v.GenericSchema>(request: Request, schema: Schema): Promise<v.InferOutput<Schema>> {
  const parsed = v.safeParse(schema, await request.json());

  if (!parsed.success) throw new KinuError("bad_input", "malformed body");

  return parsed.output;
}

function uploadTarget(url: URL): DriveUploadTarget {
  const folder = url.searchParams.get("folder");

  if (folder !== null && url.searchParams.get("unpack") === "zip") return { kind: "zip", folder };
  const path = url.searchParams.get("path");

  if (path === null) throw new KinuError("bad_input", "path query parameter required");

  return { kind: "file", path };
}

async function serveDrive(drive: MossaicVfs, request: Request): Promise<Response> {
  const url = new URL(request.url);
  const route = `${request.method} ${url.pathname.slice("/api/drive".length)}`;

  try {
    switch (route) {
      case "GET ": return answer(await listDrive(drive, url.searchParams.get("path") ?? "/"));

      case "DELETE ": {
        await deleteDriveEntry(drive, url.searchParams.get("path") ?? "");

        return answer({ ok: true });
      }

      case "POST /folders": {
        await makeDriveFolder(drive, (await bodyJson(request, PathBody)).path);

        return answer({ ok: true });
      }

      case "POST /rename": {
        const { from, to } = await bodyJson(request, RenameBody);
        await renameDriveEntry(drive, from, to);

        return answer({ ok: true });
      }

      case "POST /skills/mark": return answer(await markAsSkill(drive, (await bodyJson(request, PathBody)).path));

      case "POST /skills": {
        const { skill } = await bodyJson(request, SkillBody);

        return answer(await addSkill(drive, [{ path: SKILL_FOLDER_FILE, bytes: new TextEncoder().encode(skill) }], null));
      }

      case "PUT /skills": {
        const bytes = new Uint8Array(await request.arrayBuffer());
        const { skill } = await receiveDriveUpload(drive, { kind: "skill", name: url.searchParams.get("name") }, bytes);

        return answer(skill ?? { ok: true });
      }

      case "PUT /files": {
        const bytes = new Uint8Array(await request.arrayBuffer());

        return answer(await receiveDriveUpload(drive, uploadTarget(url), bytes));
      }

      case "GET /files": {
        const path = url.searchParams.get("path") ?? "";
        const stat = await drive.stat(path);

        if (stat === null) throw new KinuError("missing", `no such entry: ${path}`);
        const bytes = stat.isDir ? await packDriveFolder(drive, path, 64 * 1024 * 1024) : await drive.readFile(path);
        const owned = new Uint8Array(new ArrayBuffer(bytes.length));
        owned.set(bytes instanceof Uint8Array ? bytes : new TextEncoder().encode(bytes));

        return new Response(owned, { headers: { "content-type": "application/octet-stream" } });
      }

      default: return answer({ error: "gallery drive stub" }, 404);
    }
  } catch (cause) {
    const code = cause instanceof KinuError ? cause.code : "io";

    return answer({ error: renderThrownChain({ cause }) }, STATUS[code]);
  }
}

const NOW = Date.now();

const DESCRIPTION = "Reads the open issues of a repository, groups them by area, and writes a triage note every morning.";

const LIBRARY: SharedLibrary = {
  slates: [
    { id: "issue-triage", title: "Issue triage", workspace: "checkout-fixes", bindings: 4, visibility: "public" },
    { id: "lighthouse", title: "Landing perf report", workspace: "perf-audit", bindings: 1 },
    { id: "standup", title: "Standup notes", workspace: "email-triage", bindings: 0 },
  ],
  mine: [
    { id: "checkout-fixes~k7Qm2pV9xRt3aB4c~mfrq6zk3p2xw7ha", kind: "blueprint", share: "k7Qm2pV9xRt3aB4c", title: "Issue triage", description: DESCRIPTION, createdAt: NOW - 3 * 864e5, bindings: 4, workspace: "checkout-fixes", users: ["pat@example.com"] },
    { id: "live-board-1", kind: "live", share: "live-board-1", title: "Issue triage", description: DESCRIPTION, createdAt: NOW - 864e5, bindings: 4, visibility: "public", workspace: "checkout-fixes", users: [], fork: true },
  ],
  received: [
    { id: "live-mail-9", kind: "live", share: "live-mail-9", title: "Inbox digest", description: "Summarises unread mail into one morning note.", createdAt: NOW - 2 * 3600e3, bindings: 2, visibility: "users", workspace: "sam-mail", owner: "sam@example.com", fork: true },
    { id: "email-triage~z8Xc4vB2nM6qW3eR~a7bn3kd9pq2xw5ha", kind: "blueprint", share: "z8Xc4vB2nM6qW3eR", title: "Deploy status board", description: "Every service, its last deploy and who shipped it.", createdAt: NOW - 864e5, bindings: 2, workspace: "sam-mail", owner: "sam@example.com" },
  ],
};

const EMPTY_LIBRARY: SharedLibrary = { slates: [], mine: [], received: [] };

const FIXTURES = {
  drive: { seeded: true, library: LIBRARY },
  shared: { seeded: true, library: LIBRARY },
  app: { seeded: true, library: LIBRARY },
  "drive-empty": { seeded: false, library: EMPTY_LIBRARY },
  "drive-recipient": { seeded: false, library: { ...EMPTY_LIBRARY, received: LIBRARY.received } },
} satisfies Record<string, { seeded: boolean; library: SharedLibrary }>;

export function installDriveFixture(frame: string): void {
  const fixture = Object.entries(FIXTURES).find(([name]) => name === frame)?.[1];

  if (fixture === undefined) return;
  const next = window.fetch.bind(window);
  const drive = fixture.seeded ? seededDrive() : Promise.resolve(mossaicVfs(fakeMossaic().tenant("gallery-owner")));

  window.fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;

    if (path === "/api/drive" || path.startsWith("/api/drive/")) return drive.then((tenant) => serveDrive(tenant, request));

    if (path === "/api/shared" && request.method === "GET") {
      return Promise.resolve(new Response(JSON.stringify(fixture.library), { headers: { "content-type": "application/json" } }));
    }

    return next(input, init);
  }, { preconnect: next.preconnect });
}

const FALLBACK = <div className="flex h-full items-center justify-center"><Loader size="base" /></div>;

export function DrivePageFrame() {
  return (
    <div className="flex h-screen w-screen p-bg p-text overflow-hidden">
      <aside className="hidden w-60 shrink-0 p-sidebar border-r p-border md:block"><Sidebar /></aside>
      <main className="min-h-0 min-w-0 flex-1 overflow-hidden">
        <Suspense fallback={FALLBACK}>
          <Routes>
            <Route path={APP_ROUTES.drive} element={<DrivePage tab="mine" />} />
            <Route path={APP_ROUTES.driveFolder} element={<DrivePage tab="mine" />} />
            <Route path={APP_ROUTES.shared} element={<DrivePage tab="shared" />} />
          </Routes>
        </Suspense>
      </main>
    </div>
  );
}

export function DriveRoute({ tab }: { tab: "mine" | "shared" }) {
  return <Suspense fallback={FALLBACK}><DrivePage tab={tab} /></Suspense>;
}
