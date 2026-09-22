import { Link } from "react-router-dom";
import { ArrowLeftIcon } from "@phosphor-icons/react";
import { McpServersPanel } from "@/components/account/McpServersPanel";

export default function UserMcpPage() {
  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-4xl mx-auto px-6 py-8 space-y-6">
        <header>
          <Link to="/user/settings" className="text-xs p-text-3 flex items-center gap-1 hover:p-text mb-2">
            <ArrowLeftIcon size={12} /> Back to account settings
          </Link>
          <h1 className="p-display text-2xl">MCP servers</h1>
          <p className="text-xs p-text-3 mt-1">
            Connect an MCP server once. Every agent you own can use its hosted tools.
          </p>
        </header>

        <McpServersPanel />
      </div>
    </div>
  );
}
