/**
 * What each alarm the code arms logs when it does work of its own: work no call into its object, and no model call it
 * opens, shows. The idle-wake rule (`scripts/prod-logs.ts`) counts such a line within its distance as the alarm's work,
 * and reads no other list. Keyed by every class that arms an alarm (one that overrides `alarm()`, or a Lifecycle
 * capability with jobs); the DO-init gate (`scripts/do-init-gate.ts` `auditAlarmWork`) holds the keys equal to those
 * classes and every named event to a site that logs it, so a new alarm names its work here or fails that gate. An empty list names none: the alarm's work is a
 * call or a model call of its own object, or it is watching, and an idle-wake finding of it is a wake that did nothing.
 */
import type { LogEventName } from './log';

export const ALARM_WORK = {
  // Tears down an eval workspace a lease after its run's last mark (cf-backend `user/eval-leases.ts`).
  EvalLeaseJobs: ['workspace.destroyed'],
  // Runs again a workspace's deletion that has not landed, a lap after it began (cf-backend `user/workspace-deletions.ts`).
  WorkspaceDeletionJobs: ['workspace.destroyed'],
  // Drops or expires a deploy run nobody finished, an hour after its last call (cf-backend `deploy/deploy-do.ts`).
  DeployRunDO: ['deploy.run_dropped', 'deploy.run_expired'],
  // Retries an account's queued sends and empties its Trash 30 days on (cf-backend `mail/mailbox-do.ts`).
  MailboxDO: ['email.outbox_send_failed', 'mail.trash_emptied'],
  // Sends a share's card to a recipient's account: a call into that account, none into this one.
  ShareCardJobs: ['share.card_sent'],
  // Writes the box's checkpoint, or restarts a box whose disk stalled; its heartbeat otherwise watches.
  Devbox: ['devbox.checkpoint.bytes', 'devbox.disk.stall.restart'],
  // The workspace timer's pass and the terminal-effect retries, which run turns and calls of the workspace.
  WakeJobs: [],
  // Wakes an agent's isolate for what it owes; what the isolate runs is read by its tail.
  AgentWakes: [],
  // Nimbus's hosted-runtime tasks, each re-armed from the activity it watches.
  NimbusTasks: [],
  // Dispatch their capabilities' jobs above, and the fibers that hold running work.
  ActorAgent: [],
  OrchestratorAgent: [],
} as const satisfies Readonly<Record<string, readonly LogEventName[]>>;

/**
 * The alarms of libraries the Worker hosts, vendored under `third_party/`, by library and class: not this code's, so the
 * test finds no class of theirs. Mossaic's UserDO sweeps its ShardDOs and says so in one line (AshishKumar4/Mossaic#6).
 */
export const HOSTED_ALARM_WORK = {
  'mossaic UserDO': ['maintenance_swept'],
} as const satisfies Readonly<Record<string, readonly string[]>>;
