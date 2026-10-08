/**
 * `GET /api/workspaces/<name>/activations`: the workspace's kept activations (`core/src/identity/activations.ts`), oldest
 * first, for its owner. A reader counting how often the workspace woke reads the ordinals here or in telemetry, never
 * startup rows.
 */
import { Hono } from 'hono';
import type { FamilyEnv } from './context';
import type { WorkspaceVariables } from './workspace';

const ACTIVATIONS = '/api/workspaces/:name/activations';

export const activationRoutes = new Hono<FamilyEnv<object, WorkspaceVariables>>();

activationRoutes.get(ACTIVATIONS, async (c) => Response.json({ activations: await c.get('workspace').agent.activations() }));
