import { useEffect, useRef, useState } from 'react';
import type { ShellApprovalOutcome, ShellApprovalRequest } from '@kinu.run/core';
import type { AgentClient } from '../agent-client';

interface PendingShellApproval {
  request: ShellApprovalRequest;
  resolve(outcome: ShellApprovalOutcome | null): void;
}

/** Each parallel tool call keeps its own answer; leaving declines so the backend applies its unattended policy. */
export function useShellApproval(client: AgentClient) {
  const queue = useRef<PendingShellApproval[]>([]);
  const [pending, setPending] = useState<ShellApprovalRequest | null>(null);

  useEffect(() => {
    const dispose = client.localControls?.setShellApprovalHandler((request) => new Promise((resolve) => {
      queue.current.push({ request, resolve });
      setPending(queue.current[0]?.request ?? null);
    }));

    return () => {
      dispose?.();

      for (const item of queue.current.splice(0)) item.resolve(null);
      setPending(null);
    };
  }, [client]);

  return {
    pending,
    decide(outcome: ShellApprovalOutcome) {
      const item = queue.current.shift();
      setPending(queue.current[0]?.request ?? null);
      item?.resolve(outcome);
    },
  };
}
