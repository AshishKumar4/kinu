/**
 * `/api/slates/:workspace/:slate/parts/:part/*`: a personal part's run and what its viewer chose to show everyone
 * (docs/SLATE-SHARING-NIMBUS.md §3). Behind the session gate, as the app's own page calls them: the viewer is the
 * signed-in person, named here at the edge and never by the request, and the slate's owner decides the rest.
 */
import { Hono } from 'hono';
import { err, ERROR_STATUS, json, safeJson } from '@kinu.run/core';
import * as v from 'valibot';
import { PartReleaseRequestSchema, PartRunAnswerSchema, PartRunRequestSchema, PartShowRequestSchema } from '@kinu.run/core/slates';
import { workspaceOwner } from '../workspace-owner-rpc';
import { rawParam, type FamilyEnv } from '../api/context';
import type { AuthIdentity } from '../auth/session';
import type { PartViewer } from './part-runs';

export const partRoutes = new Hono<FamilyEnv<Env>>();

function viewerOf(identity: AuthIdentity): PartViewer {
  const email = identity.email.trim().toLowerCase();

  return { userId: identity.userId, email, name: identity.displayName ?? email.slice(0, email.indexOf('@')) };
}

function addressOf(c: Parameters<typeof rawParam>[0]) {
  return {
    workspace: decodeURIComponent(rawParam(c, 'workspace')), slate: decodeURIComponent(rawParam(c, 'slate')), part: decodeURIComponent(rawParam(c, 'part')),
  };
}

const NO_STORE = { 'cache-control': 'no-store' };

partRoutes.post('/api/slates/:workspace/:slate/parts/:part/run', async (c) => {
  const { workspace, slate, part } = addressOf(c);
  const body = await safeJson(c.req.raw, PartRunRequestSchema);

  if (body === null) return err(400, 'A part run is { args: JSON[], action: { id, input } | null, approval: string | null }');
  const answer = await workspaceOwner(c.env, workspace).runSlatePart(viewerOf(c.get('identity')), slate, part, body);

  // Not shared with this person: the same answer as no slate at all.
  if (answer === null) return err(404, 'No such slate');

  // Held to the answer's contract as the part frame parses it: a malformed one is the host's fault, never drawn.
  return json({ body: v.parse(PartRunAnswerSchema, answer) }, { headers: NO_STORE });
});

partRoutes.post('/api/slates/:workspace/:slate/parts/:part/release', async (c) => {
  const { workspace } = addressOf(c);
  const body = await safeJson(c.req.raw, PartReleaseRequestSchema);

  if (body === null) return err(400, 'A release is { continuation }');

  return json({ body: { released: await workspaceOwner(c.env, workspace).releaseSlatePart(viewerOf(c.get('identity')), body.continuation) } }, { headers: NO_STORE });
});

partRoutes.post('/api/slates/:workspace/:slate/parts/:part/show', async (c) => {
  const { workspace, slate, part } = addressOf(c);
  const body = await safeJson(c.req.raw, PartShowRequestSchema);

  if (body === null) return err(400, 'A show is { revision, label, value }');
  const shown = await workspaceOwner(c.env, workspace).showSlatePart(viewerOf(c.get('identity')), slate, part, body);

  if (!shown.ok) return err(ERROR_STATUS[shown.reason], shown.error);

  return json({ body: { shown: true } }, { headers: NO_STORE });
});
