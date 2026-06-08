/**
 * Create-agent dialog — the single creation flow, used by both the sidebar
 * "New agent" button and the home-screen CTA (replacing the old window.prompt).
 *
 * One prompt box: the mission. It seeds SOUL.md server-side and becomes
 * the opening message. The display title is derived automatically — a
 * deterministic provisional from the mission, replaced by an AI-generated title
 * on the first turn — so there is no name field to fill in.
 */
import { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Loader } from "@cloudflare/kumo";
import { PlusIcon } from "@phosphor-icons/react";
import { Modal } from "@/components/ui/Modal";
import { createAgentFromMission } from "@/lib/create-agent";

export interface CreateAgentModalProps {
  onClose: () => void;
  initialMission?: string;
}

export function CreateAgentModal({ onClose, initialMission = "" }: CreateAgentModalProps) {
  const navigate = useNavigate();
  const [mission, setMission] = useState(initialMission);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = useCallback(async () => {
    const m = mission.trim();
    if (!m || busy) return;
    setBusy(true);
    setErr(null);
    try {
      const created = await createAgentFromMission(m);
      // Dismiss the modal BEFORE navigating: it's rendered by the persistent
      // Sidebar, so without this the "creating…" scrim stays up over the
      // freshly-opened agent page. Leave `busy` set — the modal unmounts.
      onClose();
      navigate(`/agent/${created.name}`, { state: { initialPrompt: created.mission } });
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }, [mission, busy, navigate, onClose]);

  return (
    <Modal
      title="New agent"
      icon={<PlusIcon size={18} className="p-accent" />}
      onClose={onClose}
      maxWidthClass="max-w-2xl"
      footer={<>
        <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button size="sm" variant="primary" onClick={submit} disabled={busy || !mission.trim()}>
          {busy ? <><Loader size="sm" /><span className="ml-1">Creating…</span></> : "Create agent"}
        </Button>
      </>}
    >
      <div className="space-y-1">
        <label htmlFor="agent-mission" className="text-xs font-medium p-text-2 block">Mission</label>
        <textarea
          id="agent-mission"
          value={mission}
          onChange={(e) => setMission(e.currentTarget.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit(); } }}
          placeholder="Ask the agent to investigate, build, automate, audit, or improve something."
          rows={7}
          autoFocus
          disabled={busy}
          className="w-full min-h-40 resize-y rounded-lg border p-border p-bg px-3 py-2.5 text-sm leading-relaxed p-text outline-none placeholder:p-text-3 transition-all focus:border-[var(--c-accent)] focus:ring-2 focus:ring-[var(--c-accent-subtle)] disabled:opacity-60"
        />
        <p className="text-[11px] p-text-3">This seeds SOUL.md and is sent as the first message.</p>
      </div>

      {err && (
        <div className="text-xs text-red-400 border border-red-400/40 rounded-md px-3 py-2" style={{ background: "rgba(248,113,113,0.08)" }}>
          {err}
        </div>
      )}
    </Modal>
  );
}
