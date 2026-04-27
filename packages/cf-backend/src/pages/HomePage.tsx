import { useState, useCallback, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { InputArea, Loader } from "@cloudflare/kumo";
import { BrainIcon, ClockIcon, PlusIcon, TrashIcon, PaperPlaneRightIcon } from "@phosphor-icons/react";
import { getKnownAgents, registerAgent, removeAgent, type AgentEntry } from "@/lib/agent-registry";

function AgentCard({ entry, onClick, onDelete }: {
  entry: AgentEntry; onClick: () => void; onDelete: () => void;
}) {
  return (
    <div className="p-card rounded-xl p-4 cursor-pointer animate-fade-in relative group" onClick={onClick}>
      <div className="flex items-center justify-between mb-2">
        <span className="font-medium text-sm p-text">{entry.name}</span>
        <span className="flex items-center gap-1.5 text-[11px] p-text-3">
          <ClockIcon size={11} />
          {new Date(entry.lastVisited).toLocaleDateString()}
        </span>
      </div>
      <p className="text-xs p-text-2 line-clamp-2 leading-relaxed">{entry.purpose || "No purpose set"}</p>
      <button
        onClick={(e) => { e.stopPropagation(); onDelete(); }}
        className="absolute top-3 right-3 opacity-0 group-hover:opacity-100 p-1 rounded p-text-3 hover:p-danger transition-all"
        title="Remove"
      >
        <TrashIcon size={12} />
      </button>
    </div>
  );
}

export default function HomePage() {
  const navigate = useNavigate();
  const [agents, setAgents] = useState<AgentEntry[]>([]);
  const [creating, setCreating] = useState(false);
  const [input, setInput] = useState("");

  useEffect(() => { setAgents(getKnownAgents()); }, []);

  const handleCreate = useCallback(async () => {
    const task = input.trim();
    if (!task) return;
    setCreating(true);
    const slug = task.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "agent";
    const suffix = crypto.randomUUID().slice(0, 6);
    const agentId = `${slug}-${suffix}`;
    registerAgent(agentId, task.slice(0, 60), task);
    navigate(`/agent/${agentId}`, { state: { initialPrompt: task, displayName: task.slice(0, 60) } });
  }, [input, navigate]);

  return (
    <div className="h-full overflow-y-auto">
      <div className="min-h-full flex flex-col">
        {/* Hero — clean, no gradient */}
        <div className="flex flex-col items-center justify-center px-6 pt-24 pb-14">
          <div className="flex flex-col items-center w-full max-w-2xl space-y-5">
            <BrainIcon size={44} weight="duotone" className="p-accent" />
            <div className="text-center space-y-1.5">
              <h1 className="text-4xl font-bold tracking-tight p-text">Proteus</h1>
              <p className="text-[13px] p-text-2">Self-evolving AI agents with MCTS-guided exploration</p>
            </div>

            {/* Input */}
            <div className="w-full max-w-xl p-card rounded-xl p-3 p-focus transition-all">
              <div className="flex items-end gap-3">
                <InputArea
                  value={input}
                  onValueChange={setInput}
                  onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); handleCreate(); } }}
                  placeholder="Describe your agent's mission..."
                  disabled={creating}
                  rows={2}
                  className="flex-1 !ring-0 focus:!ring-0 !shadow-none !bg-transparent !outline-none"
                />
                {creating ? (
                  <Loader size="sm" className="mb-1" />
                ) : (
                  <button onClick={handleCreate} disabled={!input.trim()} className="p-btn rounded-lg p-2 mb-0.5 cursor-pointer" aria-label="Create agent">
                    <PaperPlaneRightIcon size={16} />
                  </button>
                )}
              </div>
            </div>

            {creating && (
              <div className="flex items-center gap-2 text-xs p-accent"><Loader size="sm" /><span>Creating agent...</span></div>
            )}
          </div>
        </div>

        {/* Agent list */}
        <div className="flex-1 px-6 pb-12">
          <div className="max-w-4xl mx-auto">
            {agents.length > 0 && (
              <>
                <h2 className="text-[11px] font-medium p-text-3 mb-3 uppercase tracking-wider">Recent Agents</h2>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                  {agents.map(entry => (
                    <AgentCard key={entry.id} entry={entry}
                      onClick={() => { registerAgent(entry.id); navigate(`/agent/${entry.id}`); }}
                      onDelete={() => { removeAgent(entry.id); setAgents(getKnownAgents()); }}
                    />
                  ))}
                </div>
              </>
            )}
            {agents.length === 0 && (
              <div className="flex flex-col items-center justify-center py-20 text-center">
                <PlusIcon size={28} className="p-text-3 mb-3" />
                <p className="text-sm p-text-2 mb-1">No agents yet</p>
                <p className="text-xs p-text-3">Describe a mission above to create your first agent</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
