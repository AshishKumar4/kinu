/** Shared agent-creation flow. The mission becomes the workspace's SOUL.md and title server-side, not a chat message. */
import { useCallback, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { FileUIPart } from "ai";
import { useWorkspaceRoster } from "@/hooks/use-workspace-roster";
import { useLimitRefusal } from "@/components/limits/LimitRefusal";
import { Cause, Effect } from 'effect';
import { renderThrownChain, settle } from '@kinu.run/core/obs';

export const MISSION_LABEL = "Mission";

export const MISSION_PLACEHOLDER = "What would you like help with?";

export function useCreateWorkspace() {
  const navigate = useNavigate();
  const roster = useWorkspaceRoster();
  const offerRefusal = useLimitRefusal();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  /** `onBeforeNavigate` lets a modal dismiss itself first. */
  const create = useCallback((mission: string, onBeforeNavigate?: () => void, attachments: readonly FileUIPart[] = []): Promise<void> => {
    const m = mission.trim();

    if (!m || busy) return Promise.resolve();
    setBusy(true);
    setErr(null);

    return settle(Effect.catchCause(Effect.gen(function* () {
      const created = yield* Effect.promise(() => roster.create(m));
      onBeforeNavigate?.();
      yield* Effect.promise(async () => navigate(`/workspace/${created.name}`, attachments.length === 0 ? undefined : { state: { attachments } }));
    }), (failed) => Effect.sync(() => {
      const failure = Cause.squash(failed);

      // A limit's refusal is its dialog, said once; the box keeps the mission for when there is room.
      if (!offerRefusal({ cause: failure })) setErr(renderThrownChain({ cause: failure }));
      setBusy(false);
    })));
  }, [busy, navigate, roster, offerRefusal]);

  return { busy, err, create };
}
