// Issue #34: a model request takes its route from the provider settings the account holds when it is made, never from
// a profile handed out once. The flow edits the account between two rounds and reads what each request asked for:
// the root's own turn and a child hired before the edit.
import { expect, test } from 'bun:test';
import * as v from 'valibot';
import { activeOperationProfile } from '@kinu.run/core';
import { catalogTurn, gatewayWorkspace, hostedSubordinateHarness, runDelegatedTask } from './helpers/actor-harness';
import { chatCompletion, GATEWAY_MODEL, stubAiBinding } from './helpers/platform-gateway';

const EDITED = 'ai-gateway/workers-ai/@cf/harness/edited-model';

/** The model a request named upstream, read at the binding: the spec without the gateway's own prefix. */
const AskedSchema = v.looseObject({ model: v.string() });

test('after an account edit, the root\'s next request and an existing child\'s both ask for the new model', async () => {
  const seen: { actor: string | undefined; model: string; revision: string | undefined }[] = [];

  const gateway = stubAiBinding((run) => {
    const operation = activeOperationProfile();

    seen.push({ actor: operation?.actor.actorId, model: v.parse(AskedSchema, run.query).model, revision: operation?.profile.providerRevision });

    return chatCompletion(run, 'done');
  });

  const workspace = gatewayWorkspace(gateway);

  const child = await hostedSubordinateHarness(workspace, {
    name: 'edit-child', displayName: 'Edit Child', nameOrigin: 'user', mission: 'answer once',
  });

  const childId = child.actor.handle.actorId;

  const round = async (label: string) => {
    seen.length = 0;
    await catalogTurn(workspace.agent, `root ${label}`);
    await runDelegatedTask(workspace, childId, `child ${label}`);

    const of = (hired: boolean) => seen.filter((call) => (call.actor === childId) === hired).map((call) => `${call.model} @ ${call.revision ?? '?'}`);

    return { root: [...new Set(of(false))], child: [...new Set(of(true))] };
  };

  workspace.agent.harnessProviderRevision('settings-before');
  const before = await round('before');

  // The owner moves every tier to another model, as Settings saves it; the account's provider revision moves with it.
  workspace.agent.harnessInstallCatalog({
    tiers: { default: { model: EDITED }, deep: { model: EDITED }, fast: { model: EDITED } },
    availableModels: [GATEWAY_MODEL, EDITED],
  });
  workspace.agent.harnessProviderRevision('settings-edited');

  const after = await round('after');
  const upstream = (spec: string) => spec.slice('ai-gateway/'.length);

  // The revision is the profile the request was resolved under; the model is what it asked for under it.
  expect({ before, after }).toEqual({
    before: { root: [`${upstream(GATEWAY_MODEL)} @ settings-before`], child: [`${upstream(GATEWAY_MODEL)} @ settings-before`] },
    after: { root: [`${upstream(EDITED)} @ settings-edited`], child: [`${upstream(EDITED)} @ settings-edited`] },
  });
});
