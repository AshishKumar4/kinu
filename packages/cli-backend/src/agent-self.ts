/**
 * Local `agent.*` codemode namespace.
 *
 * The CF backend exposes this through @cloudflare/codemode. The CLI backend's
 * Node execute fallback gets the same namespace shape here, with calls routed
 * back into LocalAgentSession so the EventsHub trigger registry and background
 * job store remain the source of truth.
 */

import type { CodemodeProvider } from '@proteus/core';

type CurriculumStatus = 'pending' | 'accepted' | 'rejected' | 'completed';

export interface LocalAgentSelfHost {
  proposeCurriculumTasks(count?: number): Promise<unknown>;
  listCurriculumTasks(status?: CurriculumStatus): Promise<unknown>;
  setCurriculumTaskStatus(id: string, status: CurriculumStatus): Promise<unknown>;
  proposeScaffold(rationale: string, code: string, baseVersion?: number): Promise<unknown>;
  listScaffoldVersions(limit?: number): unknown;
  createTimerTrigger(opts: {
    cron?: string;
    atMs?: number;
    label?: string;
    payload?: Record<string, unknown>;
    trust?: 'authenticated' | 'owner';
  }): { id: string; kind: string; nextFireAt: number | null };
  cancelTrigger(id: string): Promise<unknown> | unknown;
  jobResult(jobId: string): Promise<unknown>;
  listBackgroundJobs(limit?: number): Promise<unknown>;
  getReplayEvals(limit?: number): Promise<unknown>;
}

const TYPES = `export declare const agent: {
  /** Propose N self-curriculum tasks (Voyager-style); returns the proposals. */
  proposeCurriculum(count?: number): Promise<unknown>;
  /** List your proposed curriculum tasks, optionally filtered by status. */
  listCurriculum(status?: 'pending' | 'accepted' | 'rejected' | 'completed'): Promise<unknown>;
  /** Accept a proposed task by id (it becomes runnable). */
  acceptCurriculumTask(id: string): Promise<unknown>;
  /** Propose a new version of your own scaffold (the agentic loop). Routed
   *  through the existing 4-gate validation + the fixed misevolution gate; an
   *  accepted proposal becomes the pending version, is scored by shadow
   *  evaluation against the live scaffold, and only goes live after winning
   *  the promotion gate. The code must export \`async function* run(rt, task)\`
   *  and reach the host only via the \`host.*\` bridge; rationale must be
   *  ≥ 50 chars. Pass \`baseVersion\` to branch from an archived variant
   *  (see scaffoldVersions) instead of the live current. */
  proposeScaffold(rationale: string, code: string, baseVersion?: number):
    Promise<{ ok: boolean; version?: number; error?: string; stage?: number }>;
  /** Read-only scaffold archive: your versions with status (current/pending/
   *  historical/rolled_back), lineage (parent_version) and shadow-eval record
   *  (wins/losses/ties/win_rate). Stepping stones for proposeScaffold. */
  scaffoldVersions(limit?: number): Promise<unknown>;
  /** Schedule a future autonomous turn. Pass { cron } for recurring OR
   *  { atMs } (epoch ms) for one-shot; optional label + payload. The reactor
   *  wakes you when it fires. */
  schedule(opts: { cron?: string; atMs?: number; label?: string; payload?: object }):
    Promise<{ id: string; kind: string; nextFireAt: number | null }>;
  /** Cancel a previously-scheduled trigger by id. */
  cancelSchedule(id: string): Promise<{ ok: boolean; changed?: boolean }>;
  /** Read a background job's status + result. */
  jobResult(jobId: string): Promise<unknown>;
  /** List recent background jobs (newest first). */
  backgroundJobs(limit?: number): Promise<unknown>;
  /** Read-only loss curve: replay-eval entries (newest first) — outcome-
   *  labeled past turns re-run against your CURRENT config and scored
   *  against how they originally landed. loss = 1 − mean score, and every
   *  entry carries an 'interval' field — the 95% CI on that mean. Read them
   *  together. */
  replayEvals(limit?: number): Promise<unknown>;
};
`;

export function createLocalAgentSelfProvider(host: LocalAgentSelfHost): CodemodeProvider {
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
        description: 'List your proposed curriculum tasks, optionally filtered by status.',
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
      proposeScaffold: {
        description: 'Propose a new version of your own agentic-loop scaffold. Routed through the 4-gate validation + misevolution gate + shadow evaluation; only goes live after winning the promotion gate. rationale ≥ 50 chars; code must export async function* run(rt, task) and use the host.* bridge. Optional baseVersion branches from an archived variant.',
        execute: async (...args: unknown[]) => {
          const [rationale, code, baseVersion] = args;
          if (typeof rationale !== 'string' || !rationale) return { error: 'agent.proposeScaffold: rationale must be a non-empty string' };
          if (typeof code !== 'string' || !code) return { error: 'agent.proposeScaffold: code must be a non-empty string' };
          if (baseVersion !== undefined && (typeof baseVersion !== 'number' || !Number.isInteger(baseVersion) || baseVersion < 0)) {
            return { error: 'agent.proposeScaffold: baseVersion must be a non-negative integer when given' };
          }
          try { return await host.proposeScaffold(rationale, code, baseVersion); }
          catch (err) { return { error: `agent.proposeScaffold: ${(err as Error).message}` }; }
        },
      },
      scaffoldVersions: {
        description: 'Read-only scaffold archive: versions with status, lineage (parent_version) and shadow-eval record — the stepping stones proposeScaffold can branch from.',
        execute: async (...args: unknown[]) => {
          const limit = typeof args[0] === 'number' ? args[0] : undefined;
          try { return host.listScaffoldVersions(limit); }
          catch (err) { return { error: `agent.scaffoldVersions: ${(err as Error).message}` }; }
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
              cron,
              atMs,
              label: typeof opts.label === 'string' ? opts.label : undefined,
              payload: opts.payload && typeof opts.payload === 'object' ? opts.payload as Record<string, unknown> : undefined,
            });
          } catch (err) {
            return { error: `agent.schedule: ${(err as Error).message}` };
          }
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
      jobResult: {
        description: 'Read a background job status and result.',
        execute: async (...args: unknown[]) => {
          const id = args[0];
          if (typeof id !== 'string' || !id) return { error: 'agent.jobResult: jobId must be a non-empty string' };
          try { return await host.jobResult(id); }
          catch (err) { return { error: `agent.jobResult: ${(err as Error).message}` }; }
        },
      },
      backgroundJobs: {
        description: 'List recent background jobs (newest first) with their status.',
        execute: async (...args: unknown[]) => {
          const limit = typeof args[0] === 'number' ? args[0] : undefined;
          try { return await host.listBackgroundJobs(limit); }
          catch (err) { return { error: `agent.backgroundJobs: ${(err as Error).message}` }; }
        },
      },
      replayEvals: {
        description: 'Read your replay-eval loss curve (newest first): past outcome-labeled turns re-run against the current config, scored against how they originally landed. Each entry carries the 95% confidence interval on its mean score — a move inside the interval is noise, not progress.',
        execute: async (...args: unknown[]) => {
          const limit = typeof args[0] === 'number' ? args[0] : undefined;
          try { return await host.getReplayEvals(limit); }
          catch (err) { return { error: `agent.replayEvals: ${(err as Error).message}` }; }
        },
      },
    },
  };
}
