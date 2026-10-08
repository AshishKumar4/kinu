import { useCallback, useEffect, useState } from "react";

const seenKey = (planId: string): string => `kinu.plan-replies-seen.${planId}`;

function readSeen(planId: string | null): number {
  if (planId === null) return 0;
  const stored = Number(localStorage.getItem(seenKey(planId)));

  return Number.isFinite(stored) ? stored : 0;
}

export interface PlanRepliesSeen {
  /** The agent's replies after this are unread: the comments control marks them. */
  readonly seenAt: number;
  /** Replies after this read as new in the open threads: when the owner last looked before this one. */
  readonly since: number;
  /** The owner opened the threads: everything to now is read. */
  readonly markSeen: () => void;
}

/** When the owner last read a plan's comment threads, kept per plan in this browser. */
export function usePlanRepliesSeen(planId: string | null): PlanRepliesSeen {
  const [seenAt, setSeenAt] = useState(() => readSeen(planId));
  const [since, setSince] = useState(seenAt);

  useEffect(() => {
    const at = readSeen(planId);
    setSeenAt(at);
    setSince(at);
  }, [planId]);

  const markSeen = useCallback(() => {
    if (planId === null) return;
    const now = Date.now();
    setSince(readSeen(planId));
    localStorage.setItem(seenKey(planId), String(now));
    setSeenAt(now);
  }, [planId]);

  return { seenAt, since, markSeen };
}
