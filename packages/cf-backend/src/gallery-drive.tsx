/**
 * Gallery frames for the Drive.
 *
 *   /gallery.html?frame=drive[&path=/projects/ops]
 *     → the Drive page behind the shipped chrome over a seeded tenant: a
 *       skill folder outside `/skills`, a folder that is not one, plain
 *       files, and one skill already linked.
 *   /gallery.html?frame=drive-empty
 *     → the same page over a tenant nothing has landed on.
 *   /gallery.html?frame=shared and ?frame=shared-empty
 *     → the Drive's `/blueprints` folder, which draws the shared library.
 *
 * The tenant is the in-memory Mossaic the core suites run over, driven by
 * the SAME core rules the Durable Object runs (`listDrive`, `markAsSkill`,
 * `receiveDriveUpload`, …), so what a gate observes in the browser — a
 * non-skill folder refused with its reason, a pasted SKILL.md landing under
 * `/skills` — is the product's rule, not a fixture's restatement of it. The
 * fixture wraps whatever `fetch` the gallery installed and answers only
 * `/api/drive/*`; everything else passes through.
 */
import { lazy, Suspense, type ReactNode } from "react";
import { Loader } from "@cloudflare/kumo";
import { Route, Routes } from "react-router-dom";
import * as v from "valibot";
import Sidebar from "@/components/Sidebar";
import {
  addSkill, deleteDriveEntry, listDrive, makeDriveFolder, markAsSkill, mossaicVfs, packDriveFolder, receiveDriveUpload,
  renameDriveEntry, SKILL_FOLDER_FILE, type DriveListing, type DriveUploadOutcome, type DriveUploadTarget,
  type MarkedSkill, type MossaicVfs, type SharedLibrary,
} from "@kinu.run/core";
import { KinuError, renderThrownChain, type ErrorCode } from "@kinu.run/core/obs";
import { fakeMossaic } from "@kinu.run/test-utils/mossaic";
import type { SharedLibraryProps } from "@/components/shared/SharedLibrary";
import type { WorkspaceEntry } from "@/lib/user-api";

const DrivePage = lazy(() => import("@/pages/DrivePage"));

const SKILL = (name: string, description: string): string => `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n\nSteps.\n`;

/** The seeded tenant every `drive` frame opens on. */
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
  await drive.mkdir("/blueprints", { recursive: true });

  return drive;
}

const STATUS: Readonly<Record<ErrorCode, number>> = {
  bad_input: 400, denied: 403, missing: 404, unsupported: 415, budget: 413, unavailable: 503, timeout: 504, cancelled: 400, oom: 507, io: 500,
};

/** Every JSON body this stub answers with. */
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

/** What a PUT to /files lands as, from its query. */
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

/** Route `/api/drive/*` to the seeded tenant; everything else to `next`. */
export function installDriveFixture(seeded: boolean): void {
  const next = window.fetch.bind(window);
  const drive = seeded ? seededDrive() : Promise.resolve(mossaicVfs(fakeMossaic().tenant("gallery-owner")));

  window.fetch = Object.assign((input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;

    if (path === "/api/drive" || path.startsWith("/api/drive/")) return drive.then((tenant) => serveDrive(tenant, request));

    return next(input, init);
  }, { preconnect: next.preconnect });
}

/** The shipped chrome around the Drive page: the rail, then the page. */
export function DrivePageFrame({ library, workspaces }: { library?: SharedLibrary; workspaces?: readonly WorkspaceEntry[] }) {
  const fixture: SharedLibraryProps | undefined = library === undefined ? undefined : { fixture: library, workspaces };

  return (
    <div className="flex h-screen w-screen p-bg p-text overflow-hidden">
      <aside className="hidden w-60 shrink-0 p-sidebar border-r p-border md:block"><Sidebar /></aside>
      <main className="min-h-0 min-w-0 flex-1 overflow-hidden">
        <Suspense fallback={<div className="flex h-full items-center justify-center"><Loader size="base" /></div>}>
          <Routes>
            <Route path="/shared" element={<DrivePage library={fixture} />} />
            <Route path="/shared/*" element={<DrivePage library={fixture} />} />
          </Routes>
        </Suspense>
      </main>
    </div>
  );
}

/** A frame's Drive page for the app-shell frame's `/shared` route. */
export function DriveRoute({ children }: { children?: ReactNode }) {
  return (
    <Suspense fallback={<div className="flex h-full items-center justify-center"><Loader size="base" /></div>}>
      <DrivePage />
      {children}
    </Suspense>
  );
}
