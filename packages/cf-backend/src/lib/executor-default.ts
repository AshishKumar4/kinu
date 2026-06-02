/**
 * Choose the executor the file-manager / diff should default to. Prefers where
 * the agent last actually worked (sticky, from agent_config.last_active_executor)
 * when that executor is still available; otherwise a static priority that favors
 * a real shell, falling back to the always-present VFS.
 */
export interface ExecutorAvailability { name: string; available: boolean }

const STATIC_PRIORITY = ["sandbox", "nimbus", "laptop"];

export function pickDefaultExecutor(executors: ExecutorAvailability[], lastActive?: string | null): string {
  const isAvailable = (name: string) => executors.some((e) => e.name === name && e.available);
  if (lastActive && isAvailable(lastActive)) return lastActive;
  for (const name of STATIC_PRIORITY) {
    if (isAvailable(name)) return name;
  }
  return "workspace";
}
