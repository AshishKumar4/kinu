/**
 * Home / welcome screen — shown at "/". The agent list lives in the
 * Sidebar; here we just give a hint about creating an agent and link
 * to user settings.
 */
import { Link } from "react-router-dom";
import { BrainIcon, PlusIcon, KeyIcon } from "@phosphor-icons/react";

export default function HomePage() {
  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-2xl mx-auto px-6 pt-24 pb-12 flex flex-col items-center text-center space-y-5">
        <BrainIcon size={56} weight="duotone" className="p-accent" />
        <div className="space-y-1.5">
          <h1 className="text-3xl font-bold tracking-tight">Welcome to Proteus</h1>
          <p className="text-sm p-text-2">Self-evolving AI agents with MCTS-guided exploration, mutable scaffold, and a per-user credential store.</p>
        </div>
        <div className="flex flex-col gap-3 max-w-md w-full pt-2">
          <div className="p-card rounded-xl p-5 text-left space-y-2">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <PlusIcon size={14} className="p-accent" /> Create your first agent
            </div>
            <p className="text-xs p-text-2">
              Click "New agent" in the sidebar, give it a mission, and start chatting.
              The agent will choose its tools, propose its own follow-up tasks, and even rewrite its own scaffold.
            </p>
          </div>
          <Link to="/user/settings" className="p-card rounded-xl p-5 text-left space-y-2 hover:p-card-hover transition-colors">
            <div className="flex items-center gap-2 text-sm font-semibold">
              <KeyIcon size={14} className="p-accent" /> Connect a model provider
            </div>
            <p className="text-xs p-text-2">
              Connect your ChatGPT subscription (Codex) or paste an API key for OpenAI / Anthropic / OpenRouter — and every agent you create can use it.
            </p>
          </Link>
        </div>
      </div>
    </div>
  );
}
