/** What a forked slate reaches on its forker's surface, before its preview first runs: each namespace it calls, as the
 *  forker, and where to connect what it needs. */
import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowSquareOutIcon, PlugsConnectedIcon } from "@phosphor-icons/react";
import { APP_ROUTES } from "@kinu.run/core";
import { FilledButton } from "@/components/ui/FilledButton";

interface ReachConnection {
  readonly text: string;
  readonly to?: string;
  readonly label?: string;
}

/** One namespace of a slate's surface, as a person reads what it asks of them. */
export function reachConnection(namespace: string): ReachConnection {
  const [head = "", name = ""] = namespace.split(".");

  switch (head) {
    case "mcp": return { text: `Connect an MCP server named "${name}" to your account.`, to: APP_ROUTES.userMcp, label: "MCP servers" };
    case "tools": return { text: "Calls tools crafted in this workspace." };
    case "slates": return { text: `Calls another slate with id "${name}"; fork or author it in this workspace.` };
    case "device": return { text: "Runs on one of your machines: link a device and grant this workspace access.", to: APP_ROUTES.devices, label: "Devices" };
    case "web": return { text: "Uses this workspace's web access, as you." };
    case "memory": return { text: "Reads and writes this workspace's memory, as you." };
    case "tasks": return { text: "Reads and writes this workspace's tasks, as you." };
    case "file": return { text: "Reads and writes this workspace's files, as you." };
    case "db": return { text: "Reads and writes this workspace's tables, as you." };
    case "reads": return { text: "Reads this workspace's activity." };
    case "agent": return { text: "Sends messages to this workspace's agent, as you." };
    case "ai": return { text: "Runs model inference on your models, as you.", to: APP_ROUTES.userSettings, label: "Models" };
    default: return { text: `Runs on the ${head} executor of this workspace, as you.` };
  }
}

export function ForkReachPanel({ title, reaches, onOpen }: {
  title: string;
  /** The fork's requirements: the namespaces the slate was seen calling when it was published. */
  reaches: readonly string[];
  onOpen: () => void;
}) {
  const [opening, setOpening] = useState(false);

  return (
    <div className="h-full overflow-y-auto px-[18px] py-[18px]" data-fork-reach>
      <div className="mx-auto max-w-xl space-y-4">
        <header className="flex items-start gap-3">
          <PlugsConnectedIcon size={20} className="mt-0.5 shrink-0 p-accent" />
          <div>
            <h2 className="p-title p-text">{title} runs as you here</h2>
            <p className="mt-0.5 p-meta p-text-3">This slate was forked. It calls your own workspace, as you, and nothing has run yet.</p>
          </div>
        </header>
        <ul className="space-y-2">
          {reaches.length === 0 && <li className="p-card px-4 py-3 text-xs p-text-3">It was published calling nothing of its publisher&apos;s. It runs on its own.</li>}
          {reaches.map((namespace) => {
            const connection = reachConnection(namespace);

            return (
              <li key={namespace} className="p-card flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start sm:gap-4">
                <div className="min-w-0 flex-1">
                  <span className="font-mono text-sm p-text">{namespace}</span>
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
        <div className="flex justify-end pt-1">
          <FilledButton onClick={() => { setOpening(true); onOpen(); }} disabled={opening}>Open the preview</FilledButton>
        </div>
      </div>
    </div>
  );
}
