/**
 * Create-agent dialog — the single creation flow, used by both the sidebar
 * "New agent" button and the home-screen CTA (replacing the old window.prompt).
 *
 * The mission is the agent's first task: it becomes the agent's purpose
 * server-side and is sent as the opening message once the run view connects.
 */
import { useCallback, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Loader, InputArea } from "@cloudflare/kumo";
import { PlusIcon } from "@phosphor-icons/react";
import { registerAgent } from "@/lib/user-api";
import { Modal } from "@/components/ui/Modal";

/** Derive a URL-safe slug from free-text mission (mirrors the server's naming). */
function slugify(mission: string): string {
  return mission.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 24);
}

export interface CreateAgentModalProps {
  onClose: () => void;
}

export function CreateAgentModal({ onClose }: CreateAgentModalProps) {
  const navigate = useNavigate();
  const [mission, setMission] = useState("");
  const [name, setName] = useState("");
  const [nameEdited, setNameEdited] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Name tracks the mission slug until the user types their own.
  const effectiveSlug = useMemo(
    () => (nameEdited ? name : slugify(mission)),
    [nameEdited, name, mission],
  );

  const submit = useCallback(async () => {
    const m = mission.trim();
    if (!m || busy) return;
    setBusy(true);
    setErr(null);
    const slug = (effectiveSlug || "agent").replace(/[^a-z0-9_-]/gi, "-").replace(/^-|-$/g, "") || "agent";
    const fullName = `${slug}-${crypto.randomUUID().slice(0, 6)}`;
    const displayName = m.split("\n")[0].slice(0, 60);
    try {
      await registerAgent(fullName, displayName, m);
      navigate(`/agent/${fullName}`, { state: { initialPrompt: m, displayName } });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }, [mission, busy, effectiveSlug, navigate]);

  return (
    <Modal
      title="New agent"
      icon={<PlusIcon size={18} className="p-accent" />}
      onClose={onClose}
      maxWidthClass="max-w-lg"
      footer={<>
        <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button size="sm" variant="primary" onClick={submit} disabled={busy || !mission.trim()}>
          {busy ? <><Loader size="sm" /><span className="ml-1">Creating…</span></> : "Create agent"}
        </Button>
      </>}
    >
      <div className="space-y-1.5">
        <label className="text-[11px] p-text-3 block">Mission — what should it do?</label>
        <InputArea
          value={mission}
          onValueChange={setMission}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit(); } }}
          placeholder="e.g. Research the top 3 Rust web frameworks and build a benchmark comparing them."
          rows={4}
          autoFocus
          disabled={busy}
        />
        <p className="text-[10px] p-text-3">Becomes the agent's purpose and its first message. ⌘/Ctrl+Enter to create.</p>
      </div>

      <div className="space-y-1.5">
        <label className="text-[11px] p-text-3 block">Name (optional)</label>
        <input
          type="text"
          value={effectiveSlug}
          onChange={(e) => { setNameEdited(true); setName(e.target.value); }}
          placeholder="auto-derived from the mission"
          disabled={busy}
          className="w-full px-3 py-1.5 rounded-md border p-border p-card text-sm font-mono focus:outline-none focus:ring-1 focus:ring-[var(--c-accent)]"
        />
        <p className="text-[10px] p-text-3">A short 6-char id is appended to keep it unique.</p>
      </div>

      {err && (
        <div className="text-xs text-red-400 border border-red-400/40 rounded-md px-3 py-2" style={{ background: "rgba(248,113,113,0.08)" }}>
          {err}
        </div>
      )}
    </Modal>
  );
}
