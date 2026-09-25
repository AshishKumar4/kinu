/**
 * `/shared/blueprint/:id`: read-only, no workspace chrome; the viewer may have no account.
 * A secret-shaped scan hit is reported by location, never content.
 */
import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Loader } from "@cloudflare/kumo";
import { FileIcon, FolderIcon, GitBranchIcon, LinkIcon, WarningIcon, type Icon } from "@phosphor-icons/react";
import type { BlueprintView, SlateBindingDeclaration, SlateBindingKind } from "@kinu.run/core";
import { KinuLogo } from "@/components/ui/KinuLogo";
import { FilledButton } from "@/components/ui/FilledButton";
import { ForkDialog } from "@/components/shared/ForkDialog";
import { getBlueprint, signedInEmail } from "@/lib/shared-api";
import type { WorkspaceEntry } from "@/lib/user-api";
import { showRejection } from "@/hooks/use-async-resource";

export const BINDING_KIND_LABEL: Record<SlateBindingKind, string> = {
  mcp: "MCP server",
  tool: "Tool",
  namespace: "Executor",
  app: "Another slate",
  rpc: "Workspace read models",
  memory: "Workspace memory",
  tasks: "Workspace tasks",
  web: "Web access",
  agent: "Your agent",
  ai: "Model inference",
};

const KIND_ORDER: readonly SlateBindingKind[] = ["mcp", "tool", "namespace", "app", "ai", "agent", "web", "memory", "tasks", "rpc"];

function bindingsByKind(bindings: readonly SlateBindingDeclaration[]): Array<{ kind: SlateBindingKind; bindings: SlateBindingDeclaration[] }> {
  return KIND_ORDER
    .map((kind) => ({ kind, bindings: bindings.filter((binding) => binding.kind === kind) }))
    .filter((group) => group.bindings.length > 0);
}

export function SecretWarning({ warnings }: { warnings: BlueprintView["warnings"] }) {
  if (warnings.length === 0) return null;

  return (
    <div className="p-notice-warning rounded-md px-3 py-2.5 text-xs" role="alert">
      <p className="flex items-center gap-1.5 font-medium"><WarningIcon size={14} /> Possible secrets in the source</p>
      <p className="mt-1 opacity-90">
        A blueprint never carries your connected credentials, but it can carry text someone pasted into the source. These lines look like secrets. Check them before you use this blueprint.
      </p>
      <ul className="mt-1.5 space-y-0.5 font-mono">
        {warnings.map((warning) => (
          <li key={`${warning.path}:${warning.line}:${warning.pattern}`}>{warning.path}:{warning.line}: {warning.message}</li>
        ))}
      </ul>
    </div>
  );
}

const ENTRY_ICON: Record<BlueprintView["entries"][number]["kind"], Icon> = {
  file: FileIcon,
  directory: FolderIcon,
  symlink: LinkIcon,
};

function BlueprintBody({ view }: { view: BlueprintView }) {
  return (
    <>
      <section className="space-y-2" aria-label="Declared bindings">
        <h2 className="p-eyebrow">Bindings a fork must connect</h2>
        {view.bindings.length === 0 ? (
          <p className="text-xs p-text-3">This slate declares no bindings. A fork runs on its own.</p>
        ) : bindingsByKind(view.bindings).map((group) => (
          <div key={group.kind} className="p-card px-4 py-3">
            <div className="p-meta p-text-3">{BINDING_KIND_LABEL[group.kind]}</div>
            <ul className="mt-1 space-y-1">
              {group.bindings.map((binding) => (
                <li key={binding.name} className="flex flex-wrap items-baseline gap-x-2 text-sm">
                  <span className="font-mono p-text">{binding.name}</span>
                  {binding.target && <span className="p-text-2 text-xs">→ {binding.target}</span>}
                  {binding.credentialed && <span className="p-badge-neutral rounded-sm px-1.5 py-0.5 text-[10px]">runs as you</span>}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </section>
      <SecretWarning warnings={view.warnings} />
      <section className="space-y-2" aria-label="Files">
        <h2 className="p-eyebrow">Files</h2>
        <ul className="p-card px-4 py-3 font-mono text-xs">
          {view.entries.map((entry) => {
            const depth = entry.path.split("/").length - 1;
            const EntryIcon = ENTRY_ICON[entry.kind];

            return (
              <li key={entry.path} className="flex items-center gap-1.5 py-0.5 p-text-2" style={{ paddingLeft: `${depth * 14}px` }}>
                <EntryIcon size={12} className="p-text-3" />
                {entry.path.split("/").at(-1)}
              </li>
            );
          })}
        </ul>
      </section>
    </>
  );
}

export default function BlueprintPage({ fixture, viewer, workspaces }: {
  fixture?: BlueprintView;
  viewer?: string | null;
  workspaces?: readonly WorkspaceEntry[];
} = {}) {
  const { id = "" } = useParams();
  const [view, setView] = useState<BlueprintView | null>(fixture ?? null);
  const [email, setEmail] = useState<string | null | undefined>(viewer);
  const [err, setErr] = useState<string | null>(null);
  const [forking, setForking] = useState(false);

  useEffect(() => {
    if (fixture !== undefined) return;
    let live = true;
    const failed = showRejection(setErr, () => live);

    getBlueprint(id).then((loaded) => { if (live) setView(loaded); }).catch(failed);
    signedInEmail().then((who) => { if (live) setEmail(who); }).catch(failed);

    return () => { live = false; };
  }, [fixture, id]);

  const fork = () => {
    if (email === null) {
      const login = new URL("/login", location.origin);
      login.searchParams.set("return_to", location.pathname + location.search);
      location.assign(login.toString());

      return;
    }

    setForking(true);
  };

  return (
    <div className="min-h-screen p-bg p-text">
      <header className="flex h-14 items-center justify-between border-b p-border px-5">
        <a href="/" aria-label="Kinu home" className="flex items-center"><KinuLogo /></a>
        <span className="p-meta p-text-3">Shared blueprint</span>
      </header>
      <main className="mx-auto max-w-3xl space-y-6 px-6 py-8">
        {err && <div className="p-notice-danger rounded-md px-3 py-2 text-xs">{err}</div>}
        {view === null && err === null && <div className="flex justify-center py-16"><Loader size="base" /></div>}
        {view !== null && (
          <>
            <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
              <div className="min-w-0">
                <h1 className="p-display text-2xl">{view.title}</h1>
                {view.description && <p className="mt-1 text-sm p-text-2">{view.description}</p>}
                <p className="mt-2 p-meta p-text-3">
                  A committed version of a slate, with every binding unmapped. A fork runs in your workspace on your own connections. Nothing of the publisher's comes with it.
                </p>
              </div>
              <FilledButton onClick={fork} disabled={email === undefined} className="!h-9 shrink-0 !px-4 !text-sm">
                <GitBranchIcon size={15} /> Fork into Kinu
              </FilledButton>
            </div>
            <BlueprintBody view={view} />
          </>
        )}
      </main>
      {forking && view !== null && <ForkDialog blueprint={view.id} title={view.title} onClose={() => setForking(false)} workspaces={workspaces} />}
    </div>
  );
}
