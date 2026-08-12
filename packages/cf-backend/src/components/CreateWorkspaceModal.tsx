/**
 * Create-workspace dialog — opened by the sidebar "New workspace" button. Shares the
 * creation pipeline (useCreateWorkspace) with the home-screen mission composer.
 *
 * One prompt box: the mission. It seeds SOUL.md server-side and becomes
 * the opening message. The display title is derived automatically — a
 * deterministic provisional from the mission, replaced by an AI-generated title
 * on the first turn — so there is no name field to fill in.
 */
import { useCallback, useState } from "react";
import { Button, Loader } from "@cloudflare/kumo";
import { btnSmCls } from "@/components/ui/form";
import { PlusIcon } from "@phosphor-icons/react";
import { Modal } from "@/components/ui/Modal";
import { CloudflareAIConnectNotice } from "@/components/CloudflareAIConnectNotice";
import { useCreateWorkspace } from "@/hooks/use-create-workspace";

export interface CreateWorkspaceModalProps {
  onClose: () => void;
}

export function CreateWorkspaceModal({ onClose }: CreateWorkspaceModalProps) {
  const [mission, setMission] = useState("");
  const { hasModels, busy, err, create } = useCreateWorkspace();

  // Dismiss the modal BEFORE navigating: it's rendered by the persistent
  // Sidebar, so without this the "creating…" scrim stays up over the
  // freshly-opened workspace page.
  const submit = useCallback(() => { void create(mission, onClose); }, [create, mission, onClose]);

  return (
    <Modal
      title="New workspace"
      icon={<PlusIcon size={18} className="p-accent" />}
      onClose={onClose}
      busy={busy}
      maxWidthClass="max-w-2xl"
      footer={<>
        <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
        <button className={`p-btn ${btnSmCls}`} onClick={submit} disabled={busy || !mission.trim() || hasModels === false}>
          {busy ? <><Loader size="sm" /><span className="ml-1">Creating…</span></> : "Create workspace"}
        </button>
      </>}
    >
      {hasModels === false && (
        <CloudflareAIConnectNotice
          returnTo={window.location.pathname}
          message="Connect Cloudflare Workers AI before creating a workspace."
        />
      )}

      <div className="space-y-1">
        <label htmlFor="workspace-mission" className="text-xs font-medium p-text-2 block">Mission</label>
        <textarea
          id="workspace-mission"
          value={mission}
          onChange={(e) => setMission(e.currentTarget.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); } }}
          placeholder="Ask the workspace's agent to investigate, build, automate, audit, or improve something."
          rows={7}
          autoFocus
          disabled={busy}
          className="w-full min-h-40 resize-y rounded-lg border p-border p-bg px-3 py-2.5 text-sm leading-relaxed p-text outline-none placeholder:p-text-3 transition-all focus:border-[var(--c-accent)] focus:ring-2 focus:ring-[var(--c-accent-subtle)] disabled:opacity-60"
        />
        <p className="text-[11px] p-text-3">This seeds SOUL.md and is sent as the first message.</p>
      </div>

      {err && (
        <div className="text-xs rounded-md px-3 py-2 p-notice-danger">
          {err}
        </div>
      )}
    </Modal>
  );
}
