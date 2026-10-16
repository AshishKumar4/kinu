/**
 * A collaborator's own `workspace.ai`, run in their own account: the tier their catalog names, the provider their
 * credentials reach, the spend theirs. A slate room calls it for a run holding that person's own AI grant
 * (`SlateRoom.transport`); the call itself is the one slate AI path (`slates/slate-ai.ts`) the owner's runs too.
 */
import {
  DEFAULT_ROLE_ID, loadProfileAuthorityInputs, resolveTurnProfile,
  type ModelCallReport, type ProfileCatalogEnvelope, type SlateSurfaceValue, type UserCaller,
} from '@kinu.run/core';
import { recordModelRow } from '@kinu.run/core/analytics';
import { OwnedModelServices, type OwnedModelEnv } from '../owned-model-services';
import { slateAiAnswer, type SlateAiRoute } from '@kinu.run/core/slates';

/** What of the account the call reads: its name, its catalog and its credentials' revision, as the caller may. */
export interface AccountSlateAiHost<Id> {
  readonly env: OwnedModelEnv<Id> & Parameters<typeof recordModelRow>[0];
  readonly accountId: string;
  readonly catalog: (caller: UserCaller) => Promise<ProfileCatalogEnvelope>;
  readonly credentialsRevision: (caller: UserCaller) => Promise<number>;
}

/** The account's model services for one call: its own registry, keyed to the room's workspace for prompt caching. */
function accountServices<Id>(host: AccountSlateAiHost<Id>, caller: UserCaller, workspace: string): OwnedModelServices<Id> {
  return new OwnedModelServices({
    env: host.env,
    agentName: () => `slate-ai:${host.accountId}`,
    workspaceId: () => workspace,
    workspaceName: () => workspace,
    appTitle: 'Kinu',
    ownerRequired: true,
    getOwnerUserId: () => host.accountId,
    getUserCaller: async () => caller,
    getCredentialsRevision: async () => host.credentialsRevision(caller),
    reportModelCall: (report) => { recordSlateAi(host, workspace, report); },
  });
}

/** A collaborator's slate AI call, counted where every model call is counted, under the workspace it was made in. */
function recordSlateAi<Id>(host: AccountSlateAiHost<Id>, workspace: string, report: ModelCallReport): void {
  const spec = report.spec ?? '';
  const cut = spec.indexOf('/');

  recordModelRow(host.env, {
    workspace, agentKind: '', provider: cut < 0 ? spec : spec.slice(0, cut), model: report.modelId ?? (cut < 0 ? '' : spec.slice(cut + 1)),
    source: report.source, usage: report.usage, usd: undefined,
  });
}

/** One `ai.run` or `ai.stream`, resolved and run as this account's own: no tier, model or key of the slate owner's. */
export async function accountSlateAi<Id>(host: AccountSlateAiHost<Id>, caller: UserCaller, request: { readonly workspace: string; readonly route: SlateAiRoute }): Promise<SlateSurfaceValue> {
  const services = accountServices(host, caller, request.workspace);
  const inputs = await loadProfileAuthorityInputs({ envelope: async () => host.catalog(caller), provider: async () => services.profileProviderSnapshot() });

  const profile = resolveTurnProfile({
    ...inputs, roleId: DEFAULT_ROLE_ID, explicitTier: request.route.tier, workMode: 'build', availableTools: [], activeSkills: [],
  });

  return slateAiAnswer(request.route, { spec: profile.tier.model, tier: profile.tier.id }, {
    resolveModel: (spec) => services.resolveModel(spec), report: (report) => { recordSlateAi(host, request.workspace, report); }, operations: () => {},
  });
}
