/**
 * Create-agent dialog — the single creation flow, used by both the sidebar
 * "New agent" button and the home-screen CTA (replacing the old window.prompt).
 *
 * One prompt box: the mission. It becomes the agent's purpose server-side and
 * its opening message. The display title is derived automatically — a
 * deterministic provisional from the mission, replaced by an AI-generated title
 * on the first turn — so there is no name field to fill in.
 */
import { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Button, Loader, InputArea } from "@cloudflare/kumo";
import { PlusIcon } from "@phosphor-icons/react";
import { registerAgent } from "@/lib/user-api";
import { slugifyName } from "@/lib/agent-naming";
import { Modal } from "@/components/ui/Modal";

export interface CreateAgentModalProps {
  onClose: () => void;
}

export function CreateAgentModal({ onClose }: CreateAgentModalProps) {
  const navigate = useNavigate();
  const [mission, setMission] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submit = useCallback(async () => {
    const m = mission.trim();
    if (!m || busy) return;
    setBusy(true);
    setErr(null);
    // The slug is the stable DO id (a short random suffix keeps it unique); the
    // display title is derived server-side from the mission, then AI-titled.
    const fullName = `${slugifyName(m) || "agent"}-${crypto.randomUUID().slice(0, 6)}`;
    try {
      await registerAgent(fullName, m);
      // Dismiss the modal BEFORE navigating: it's rendered by the persistent
      // Sidebar, so without this the "creating…" scrim stays up over the
      // freshly-opened agent page. Leave `busy` set — the modal unmounts.
      onClose();
      navigate(`/agent/${fullName}`, { state: { initialPrompt: m } });
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
      maxWidthClass="max-w-lg"
      footer={<>
        <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <Button size="sm" variant="primary" onClick={submit} disabled={busy || !mission.trim()}>
          {busy ? <><Loader size="sm" /><span className="ml-1">Creating…</span></> : "Create agent"}
        </Button>
      </>}
    >
      <div className="space-y-1.5">
        <label className="text-[11px] p-text-3 block">What should it do?</label>
        <InputArea
          value={mission}
          onValueChange={setMission}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void submit(); } }}
          placeholder="e.g. Research the top 3 Rust web frameworks and build a benchmark comparing them."
          rows={5}
          autoFocus
          disabled={busy}
        />
        <p className="text-[10px] p-text-3">Becomes the agent's purpose and its first message. It names itself from this. ⌘/Ctrl+Enter to create.</p>
      </div>

      {err && (
        <div className="text-xs text-red-400 border border-red-400/40 rounded-md px-3 py-2" style={{ background: "rgba(248,113,113,0.08)" }}>
          {err}
        </div>
      )}
    </Modal>
  );
}
