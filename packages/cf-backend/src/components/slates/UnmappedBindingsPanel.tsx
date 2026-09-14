/**
 * A forked slate's landing panel: every binding `package.json` declares and
 * what the forker must connect for it, before the preview is opened. The
 * manifest is read from the admitted tree, so the list is what the slate will
 * actually resolve — as the forker, in this workspace.
 */
import { useCallback, useState } from "react";
import { Link } from "react-router-dom";
import { Loader } from "@cloudflare/kumo";
import { ArrowSquareOutIcon, PlugsConnectedIcon } from "@phosphor-icons/react";
import * as v from "valibot";
import { APP_ROUTES, PLANE, describeBindings, parseSlateProject, type Rpc, type SlateBindingDeclaration } from "@kinu.run/core";
import { useAsyncResource } from "@/hooks/use-async-resource";
import { FilledButton } from "@/components/ui/FilledButton";
import { BINDING_KIND_LABEL } from "@/pages/BlueprintPage";

const FileTextSchema = v.object({ content: v.optional(v.string()), error: v.optional(v.string()) });

/** What connecting one binding means in this workspace, and where to do it. */
interface BindingConnection {
  readonly text: string;
  /** The app route where the connection is made, when there is one. */
  readonly to?: string;
  readonly label?: string;
}

function connectionFor(binding: SlateBindingDeclaration): BindingConnection {
  switch (binding.kind) {
    case "mcp": return { text: `Connect an MCP server named "${binding.target}" to your account.`, to: APP_ROUTES.userMcp, label: "MCP servers" };
    case "tool": return { text: `Needs a tool named "${binding.target}": a native tool, or one crafted in this workspace.` };
    case "namespace": return binding.target === "laptop"
      ? { text: "Runs on one of your machines: link a device and grant this workspace access.", to: APP_ROUTES.userSettings, label: "Account settings" }
      : { text: `Runs on the ${binding.target} executor of this workspace.` };
    case "app": return { text: `Calls another slate with id "${binding.target}"; fork or author it in this workspace.` };
    case "web": return { text: "Uses this workspace's web access, as you." };
    case "memory": return { text: "Reads and writes this workspace's memory, as you." };
    case "tasks": return { text: "Reads and writes this workspace's tasks, as you." };
    case "rpc": return { text: `Reads this workspace's ${binding.target}.` };
    case "agent": return { text: "Sends messages to this workspace's agent, as you." };
    case "ai": return { text: `Runs model inference on your ${binding.target} tier, as you.`, to: APP_ROUTES.userSettings, label: "Models" };
  }
}

export function UnmappedBindingsPanel({ slate, title, rpc, onOpen, fixture }: {
  slate: string;
  title: string;
  rpc: Rpc;
  /** Open the preview: the forker has connected what they need. */
  onOpen: () => void;
  fixture?: SlateBindingDeclaration[];
}) {
  const [opening, setOpening] = useState(false);

  const load = useCallback(async (): Promise<SlateBindingDeclaration[]> => {
    if (fixture !== undefined) return fixture;
    const file = v.parse(FileTextSchema, await rpc("readExecutorFile", [PLANE, `/home/user/slates/${slate}/package.json`]));

    if (file.content === undefined) throw new Error(file.error ?? "package.json could not be read");

    return describeBindings(parseSlateProject(JSON.parse(file.content)));
  }, [fixture, rpc, slate]);

  const { resource, reload } = useAsyncResource(load, undefined, slate);

  return (
    <div className="h-full overflow-y-auto px-[18px] py-[18px]" data-unmapped-bindings>
      <div className="mx-auto max-w-xl space-y-4">
        <header className="flex items-start gap-3">
          <PlugsConnectedIcon size={20} className="mt-0.5 shrink-0 p-accent" />
          <div>
            <h2 className="p-title p-text">{title} needs its bindings connected</h2>
            <p className="mt-0.5 p-meta p-text-3">This slate was forked from a blueprint. Every binding below resolves as you, in this workspace; nothing has run yet.</p>
          </div>
        </header>
        {resource.status === "loading" && <div className="flex justify-center py-8"><Loader size="sm" /></div>}
        {resource.status === "error" && (
          <div className="p-notice-danger flex items-center justify-between gap-3 rounded-md px-3 py-2 text-xs">
            <span className="min-w-0 truncate">{resource.message}</span>
            <button type="button" onClick={reload} className="shrink-0 underline">retry</button>
          </div>
        )}
        {resource.status === "ready" && (
          <ul className="space-y-2">
            {resource.value.length === 0 && <li className="p-card px-4 py-3 text-xs p-text-3">No bindings declared. This slate runs on its own.</li>}
            {resource.value.map((binding) => {
              const connection = connectionFor(binding);

              return (
                <li key={binding.name} className="p-card flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start sm:gap-4">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="font-mono text-sm p-text">{binding.name}</span>
                      <span className="p-meta p-text-3">{BINDING_KIND_LABEL[binding.kind]}{binding.target ? ` · ${binding.target}` : ""}</span>
                    </div>
                    <p className="mt-0.5 text-xs p-text-2">{connection.text}</p>
                  </div>
                  {connection.to !== undefined && (
                    <Link to={connection.to} className="p-btn-quiet inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2.5 text-xs">
                      <ArrowSquareOutIcon size={12} /> {connection.label}
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        <div className="flex justify-end pt-1">
          <FilledButton onClick={() => { setOpening(true); onOpen(); }} disabled={opening || resource.status !== "ready"}>Open the preview</FilledButton>
        </div>
      </div>
    </div>
  );
}
