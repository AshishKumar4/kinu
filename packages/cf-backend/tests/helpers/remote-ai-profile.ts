import { JsonValueSchema, type UserCaller } from '@kinu.run/core';
import * as v from 'valibot';
import type { UserDO } from '../../src/user/user-do';
import { WORKERS_AI_FIXTURE_MODEL_SPEC } from '../../../test-utils/src/workers-ai-model-spec';

/** Account-owned catalog setup through the product's compare-and-swap write, before any turn resolves a provider snapshot. */
export async function configureRemoteAiFixture(user: Pick<UserDO, 'getProfileCatalog' | 'putProfileCatalog'>, caller: UserCaller): Promise<void> {
  const current = await user.getProfileCatalog(caller);
  const catalog = v.parse(JsonValueSchema, { ...current.catalog, tiers: { ...current.catalog.tiers, fast: { model: WORKERS_AI_FIXTURE_MODEL_SPEC } } });
  const written = await user.putProfileCatalog(caller, catalog, current.version);

  if (!written.ok) throw new Error(`The fixture's account catalog was refused: ${JSON.stringify(written)}`);
}
