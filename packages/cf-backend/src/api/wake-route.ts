/**
 * `POST /api/workspaces/<name>/wake`: a workspace readied ahead of its open, as the app shell loads or a pointer rests
 * on it. The gate's claim wakes its object; main's isolate is loaded here, which the open's chat is seeded from. An open
 * after 6-7 idle minutes reached a ready chat in 2.27 s median, against 1.32 s once both were awake (production, 2026-10-29).
 */
import { Hono } from 'hono';
import type { FamilyEnv } from './context';
import type { OrchestratorAgent } from '../orchestrator';
import type { WorkspaceVariables } from './workspace';

export const wakeRoutes = new Hono<FamilyEnv<object, WorkspaceVariables<Pick<OrchestratorAgent, 'openMainIsolate'>>>>();

wakeRoutes.post('/api/workspaces/:name/wake', async (c) => {
  await c.get('workspace').agent.openMainIsolate();

  return new Response(null, { status: 204 });
});
