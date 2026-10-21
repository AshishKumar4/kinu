/** What a forked slate reaches on its forker's surface, before its preview first runs: each namespace it calls, as the
 *  forker, and where to connect what it needs. */
import { useState } from "react";
import { Button, buttonClass } from "@/components/ui/Button";
import { Link } from "react-router-dom";
import { ArrowSquareOutIcon, PlugsConnectedIcon } from "@phosphor-icons/react";
import { APP_ROUTES } from "@kinu.run/core";
import { settingsPath } from "@/components/SettingsRail";

interface ReachConnection {
  readonly text: string;
  readonly to?: string;
  readonly label?: string;
}

/** The namespaces of a slate's surface a person is told of: the workspace's crafted tools are its agent's own concern
 *  (the owner, W0919-09), so they ask nothing of the person. */
export function personReaches(reaches: readonly string[]): string[] {
  return reaches.filter((namespace) => namespace.split(".")[0] !== "tools");
}

/** One namespace of a slate's surface, as a person reads what it asks of them. */
export function reachConnection(namespace: string): ReachConnection {
  // The head is the first name; the rest, dots and all, is the server or slate it names.
  const [head = "", ...rest] = namespace.split(".");
  const name = rest.join(".");

  switch (head) {
    case "mcp": return { text: `Connect an MCP server named "${name}" to your account.`, to: APP_ROUTES.userMcp, label: "MCP servers" };
    case "slates": return { text: `Calls another slate with id "${name}"; fork or author it in this workspace.` };
    case "device": return { text: "Runs on one of your machines: link a device and grant this workspace access.", to: settingsPath("devices"), label: "Devices" };
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
  const shown = personReaches(reaches);

  return (
    <div className="h-full overflow-y-auto px-[18px] py-[18px]" data-fork-reach>
      <div className="mx-auto max-w-xl space-y-4">
        <header className="flex items-start gap-3">
          <PlugsConnectedIcon size={20} className="mt-px shrink-0 p-accent" />
          <div>
            <h2 className="t-title p-text">{title} runs as you here</h2>
            <p className="t-meta mt-px p-text-3">This slate was forked. It calls your own workspace, as you, and nothing has run yet.</p>
          </div>
        </header>
        <ul className="space-y-2">
          {shown.length === 0 && <li className="t-meta p-card px-4 py-3 p-text-3">It was published calling nothing of its publisher&apos;s. It runs on its own.</li>}
          {shown.map((namespace) => {
            const connection = reachConnection(namespace);

            return (
              <li key={namespace} className="p-card flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-start sm:gap-4">
                <div className="min-w-0 flex-1">
                  <span className="t-body t-mono p-text">{namespace}</span>
                  <p className="t-meta mt-px p-text-2">{connection.text}</p>
                </div>
                {connection.to !== undefined && (
                  <Link to={connection.to} className={buttonClass({ size: "sm" })}>
                    <ArrowSquareOutIcon size={12} /> {connection.label}
                  </Link>
                )}
              </li>
            );
          })}
        </ul>
        <div className="flex justify-end pt-1">
          <Button variant="primary" size="sm" onClick={() => { setOpening(true); onOpen(); }} disabled={opening}>Open the preview</Button>
        </div>
      </div>
    </div>
  );
}
