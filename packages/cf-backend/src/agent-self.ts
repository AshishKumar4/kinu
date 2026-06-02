/**
 * `agent.*` — the agent's self-direction codemode namespace.
 *
 * Lets the LLM steer ITSELF from inside execute_tools: propose + accept its own
 * Voyager-style curriculum, and schedule future autonomous turns (delivered by
 * the event→turn reactor). Registered exactly like the RLM provider — zero new
 * top-level builtins, so it respects the 6-tool surface.
 *
 * Deliberately NOT here: fork (forkAgent rejects while a turn is in flight, so
 * it can't run mid-codemode) and spawn/join (think({strategy:'heads'}) already
 * is the imperative parallel spawn+join facade over the sole sub-agent path —
 * a second one would be a drift-prone shadow system).
 */
import type { CodemodeProvider } from './rlm.js';

type CurriculumStatus = 'pending' | 'accepted' | 'rejected' | 'completed';

/** The narrow slice of the orchestrator the `agent.*` tools call through to —
 *  all existing methods, so there's no duplicated logic. */
export interface AgentSelfHost {
  proposeCurriculumTasks(count?: number): Promise<unknown>;
  listCurriculumTasks(status?: CurriculumStatus): Promise<unknown>;
  setCurriculumTaskStatus(id: string, status: CurriculumStatus): Promise<unknown>;
  createTimerTrigger(opts: {
    cron?: string; atMs?: number; label?: string; payload?: Record<string, unknown>;
  }): { id: string; kind: string; nextFireAt: number | null };
  cancelTrigger(id: string): Promise<unknown> | unknown;
}

const TYPES = `export declare const agent: {
  /** Propose N self-curriculum tasks (Voyager-style); returns the proposals. */
  proposeCurriculum(count?: number): Promise<unknown>;
  /** List your proposed curriculum tasks, optionally filtered by status. */
  listCurriculum(status?: 'pending' | 'accepted' | 'rejected' | 'completed'): Promise<unknown>;
  /** Accept a proposed task by id (it becomes runnable). */
  acceptCurriculumTask(id: string): Promise<unknown>;
  /** Schedule a future autonomous turn. Pass { cron } for recurring OR
   *  { atMs } (epoch ms) for one-shot; optional label + payload. The reactor
   *  wakes you when it fires. */
  schedule(opts: { cron?: string; atMs?: number; label?: string; payload?: object }):
    Promise<{ id: string; kind: string; nextFireAt: number | null }>;
  /** Cancel a previously-scheduled trigger by id. */
  cancelSchedule(id: string): Promise<{ ok: boolean }>;
};
`;

export function createAgentSelfProvider(host: AgentSelfHost): CodemodeProvider {
  return {
    name: 'agent',
    types: TYPES,
    positionalArgs: true,
    tools: {
      proposeCurriculum: {
        description: 'Propose N self-curriculum tasks (Voyager-style) for your own improvement; returns the proposals.',
        execute: async (...args: unknown[]) => {
          const count = typeof args[0] === 'number' ? args[0] : undefined;
          try { return await host.proposeCurriculumTasks(count); }
          catch (err) { return { error: `agent.proposeCurriculum: ${(err as Error).message}` }; }
        },
      },
      listCurriculum: {
        description: 'List your proposed curriculum tasks, optionally filtered by status (pending/accepted/rejected/completed).',
        execute: async (...args: unknown[]) => {
          const status = args[0] as CurriculumStatus | undefined;
          try { return await host.listCurriculumTasks(status); }
          catch (err) { return { error: `agent.listCurriculum: ${(err as Error).message}` }; }
        },
      },
      acceptCurriculumTask: {
        description: 'Accept a proposed curriculum task by id so it becomes runnable.',
        execute: async (...args: unknown[]) => {
          const id = args[0];
          if (typeof id !== 'string' || !id) return { error: 'agent.acceptCurriculumTask: id must be a non-empty string' };
          try { return await host.setCurriculumTaskStatus(id, 'accepted'); }
          catch (err) { return { error: `agent.acceptCurriculumTask: ${(err as Error).message}` }; }
        },
      },
      schedule: {
        description: 'Schedule a future autonomous turn: { cron } recurring OR { atMs } one-shot (epoch ms), with optional label/payload. The reactor wakes you when it fires.',
        execute: async (...args: unknown[]) => {
          const opts = (args[0] ?? {}) as { cron?: unknown; atMs?: unknown; label?: unknown; payload?: unknown };
          const cron = typeof opts.cron === 'string' && opts.cron ? opts.cron : undefined;
          const atMs = typeof opts.atMs === 'number' && Number.isFinite(opts.atMs) ? opts.atMs : undefined;
          if (!cron && atMs === undefined) return { error: 'agent.schedule: provide { cron } or { atMs }' };
          if (atMs !== undefined && atMs <= Date.now()) return { error: 'agent.schedule: atMs must be in the future' };
          try {
            return host.createTimerTrigger({
              cron, atMs,
              label: typeof opts.label === 'string' ? opts.label : undefined,
              payload: opts.payload && typeof opts.payload === 'object' ? opts.payload as Record<string, unknown> : undefined,
            });
          } catch (err) { return { error: `agent.schedule: ${(err as Error).message}` }; }
        },
      },
      cancelSchedule: {
        description: 'Cancel a previously-scheduled trigger by id (idempotent).',
        execute: async (...args: unknown[]) => {
          const id = args[0];
          if (typeof id !== 'string' || !id) return { error: 'agent.cancelSchedule: id must be a non-empty string' };
          try { return await host.cancelTrigger(id); }
          catch (err) { return { error: `agent.cancelSchedule: ${(err as Error).message}` }; }
        },
      },
    },
  };
}
