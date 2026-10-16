/** The viewer's own grants and decisions. The app's session gate runs before this family, including its CSRF check. */
import { Hono, type Context } from 'hono';
import * as v from 'valibot';
import { err, json, objectNamed, safeJson, type ObjectNamespace, type OwnerCapabilityEnv, type UserCaller } from '@kinu.run/core';
import { EffectDecisionSchema, SlateConsentSchema, SlateConsentsAnswerSchema } from '@kinu.run/core/slates';
import { ownerGate, type ApiVariables, type FamilyEnv } from '../api/context';
import type { UserDO } from '../user/user-do';

type ConsentAuthority = Pick<UserDO, 'slateConsents' | 'consentSlate' | 'withdrawSlateConsent' | 'decideSlateEffect'>;

export interface ConsentRoutesEnv<Id> extends OwnerCapabilityEnv {
  UserDO: ObjectNamespace<Id, ConsentAuthority>;
}

interface ConsentVariables extends ApiVariables {
  owner: UserCaller;
}

type ConsentEnv = FamilyEnv<ConsentRoutesEnv<unknown>, ConsentVariables>;

const RootQuerySchema = v.pipe(v.string(), v.parseJson(),
  v.check((root) => root !== null && typeof root === 'object' && !Array.isArray(root), 'A root is a JSON object'),
  v.record(v.string(), v.string()));

function account(c: Context<ConsentEnv>): ConsentAuthority {
  return objectNamed(c.env.UserDO, c.get('identity').userId);
}

export const consentRoutes = new Hono<ConsentEnv>();

consentRoutes.get('/api/slates/:workspace/:slate/consents', ownerGate(), async (c) => {
  const consents = await account(c).slateConsents(c.get('owner'), { workspace: c.req.param('workspace'), slate: c.req.param('slate') });

  return json({ body: v.parse(SlateConsentsAnswerSchema, { consents }) });
});

consentRoutes.post('/api/slates/:workspace/:slate/consents', ownerGate(), async (c) => {
  const consent = await safeJson(c.req.raw, SlateConsentSchema);

  if (!consent) return err(400, 'A slate consent must name its workspace, slate, connection, root, tools, effects and revision.');

  if (consent.workspace !== c.req.param('workspace') || consent.slate !== c.req.param('slate')) return err(400, 'The consent must name the workspace and slate in its path.');

  return json({ body: await account(c).consentSlate(c.get('owner'), consent) });
});

consentRoutes.delete('/api/slates/:workspace/:slate/consents', ownerGate(), async (c) => {
  const server = c.req.query('server');
  const root = v.safeParse(RootQuerySchema, c.req.query('root'));

  if (!server || !root.success) return err(400, 'Withdrawal needs server and a JSON object root with string values.');
  const withdrawn = await account(c).withdrawSlateConsent(c.get('owner'), { workspace: c.req.param('workspace'), slate: c.req.param('slate'), server, root: root.output });

  return json({ body: { withdrawn } });
});

consentRoutes.post('/api/slates/:workspace/:slate/approvals/:id', ownerGate(), async (c) => {
  const body = await safeJson(c.req.raw, EffectDecisionSchema);

  if (!body) return err(400, 'An effect decision must be approve or decline.');
  const decided = await account(c).decideSlateEffect(c.get('owner'), { id: c.req.param('id'), decision: body.decision });

  return json({ body: { decided } });
});
