import { requireAuthConfig } from '../config';
import { isReasoningEffort, projectJsonValue, specOn, specProvider, WORKERS_AI_MODEL_ID_PREFIX, WORKERS_AI_PROVIDER_ID, REASONING_EFFORTS, ReasoningEffortSchema, type JsonValue, type ModelMenu, type ReasoningEffort, type TimerTrigger, type TimerTriggerOpts } from '@kinu.run/core';
import { resolveAgentTarget, type AgentTarget } from '../agent-target';
import {
  cancelLocalTrigger,
  createLocalTimerTrigger,
  getLocalToolSurface,
  listLocalJobs,
  listLocalTriggers,
  readLocalWorkspacePins,
  setLocalWorkspaceModel,
  setLocalWorkspaceReasoningEffort,
} from '../local-inspection';
import { readDefaultTier } from '../profiles';
import {
  callAgentRpc,
  CancelJobSchema,
  CloudAgentStatusSchema,
  CloudBackgroundJobSchema,
  CloudToolDescriptionsSchema,
  CloudTriggerListSchema,
  createCloudWebhookTrigger,
  listCloudAvailableModels,
  type CloudWebhookTrigger,
} from '../cloud-api';
import * as v from 'valibot';
import { ACCENT, DIM, effortRunsAs, OK, printJson, WARN } from '../display';
import { parsePositiveInt, parseTime, webhookTriggerInput } from '../options';
import { createConfiguredLocalModelResolver } from '../local-model-resolver';
import {
  normalizeModelMenu,
  specWithoutAccount,
  validateModelSpec,
  type AgentModelEntry,
  type AgentModelMenu,
} from '@kinu.run/core';
import { attempt, KinuError, renderCauseChain, settle } from '@kinu.run/core/obs';
import { Effect } from 'effect';
import { cancelLocalJob } from '../local-agent-client';
import { liveDaemonPid } from './daemon';

export interface ControlOpts {
  model?: string;
  baseUrl?: string;
  auth?: string;
  authMode?: string;
  secret?: string;
  contentType?: string;
  rateLimit?: string;
  json?: boolean;
}

const EffortSetResultSchema = v.object({ ok: v.literal(true), effort: ReasoningEffortSchema });

const StoredEffortSchema = v.object({ effort: v.nullable(ReasoningEffortSchema) });

const ModelSetResultSchema = v.object({ ok: v.literal(true), spec: v.string() });

const StoredModelSchema = v.object({ spec: v.nullable(v.string()) });

const CancelTriggerSchema = v.object({ ok: v.literal(true), changed: v.boolean() });

const TimerTriggerSchema = v.object({
  id: v.string(), kind: v.picklist(['timer_cron', 'timer_oneshot']), nextFireAt: v.nullable(v.number()),
});


export function modelCommand(name: string, spec: string | undefined, opts: ControlOpts): Promise<void> {
  return settle(Effect.gen(function* () {
    const target = resolveAgentTarget(name);
    let resolvedSpec = spec;

    if (spec) {
      if (target.mode === 'cloud') {
        const auth = requireAuthConfig();
        const catalog = yield* loadModelCatalog(() => listCloudAvailableModels(auth.origin, auth.token));
        resolvedSpec = catalogSpec(catalog, spec);
        yield* validateModelSelection(catalog, resolvedSpec, spec, name);
      } else {
        const configured = createConfiguredLocalModelResolver({
          model: opts.model,
          baseUrl: opts.baseUrl,
          auth: opts.auth,
        });

        const catalog = yield* loadModelCatalog(() => configured.resolver.listModels());
        resolvedSpec = configured.resolver.normalizeSpecSync(spec);
        yield* validateModelSelection(catalog, resolvedSpec, spec, name);
      }
    }

    const setting = resolvedSpec;
    let stored: string | null;

    if (target.mode === 'cloud') {
      const auth = requireAuthConfig();

      stored = setting
        ? (yield* Effect.promise(() => callAgentRpc({
          origin: auth.origin, token: auth.token, name: target.cloudName,
          method: 'setModel', schema: ModelSetResultSchema, args: [setting],
        }))).spec
        : yield* Effect.promise(() => storedCloudModel(auth, target.cloudName));
    } else {
      stored = setting
        ? (yield* Effect.promise(() => setLocalWorkspaceModel(target.localName, setting))).spec
        : (yield* Effect.promise(() => readLocalWorkspacePins(target.localName))).model;
    }

    if (spec) {
      console.log(`${OK('set')} ${stored}`);

      return;
    }

    const fallback = stored === null ? (yield* defaultTierOf(target)).model : null;

    console.log(`${DIM('model')} ${stored ?? `${fallback ?? 'none named'} (the default tier's)`}`);
  }));
}

/** A cancel that stopped nothing (no running job by that id) says so, and the command fails. */
function saidCancelled(job: string, ok: boolean): void {
  if (ok) {
    console.log(`${OK('cancelled')} ${job}`);

    return;
  }

  console.log(`${WARN('nothing cancelled')} ${job} is not a running job`);
  process.exitCode = 1;
}

/** What the default tier runs the workspace on: a cloud workspace's as it says itself (its account's tier), a local
 *  one's as this machine's profile reads it. */
function defaultTierOf(target: AgentTarget): Effect.Effect<{ readonly model: string | null; readonly effort: ReasoningEffort | null }> {
  if (target.mode !== 'cloud') {
    const tier = readDefaultTier();

    return Effect.succeed({ model: tier?.model ?? null, effort: tier?.reasoningEffort ?? null });
  }

  const auth = requireAuthConfig();

  return Effect.map(
    Effect.promise(() => callAgentRpc({ origin: auth.origin, token: auth.token, name: target.cloudName, method: 'getAgentStatus', schema: CloudAgentStatusSchema })),
    (status) => ({ model: status.model ?? null, effort: status.reasoningEffort ?? null }),
  );
}

/** The model a cloud workspace pins, or null where it runs the default tier's. */
async function storedCloudModel(auth: { readonly origin: string; readonly token: string }, cloudName: string): Promise<string | null> {
  return (await callAgentRpc({ origin: auth.origin, token: auth.token, name: cloudName, method: 'getStoredModelSpec', schema: StoredModelSchema })).spec;
}

interface EffortResult {
  readonly effort: ReasoningEffort | null;
}

export async function effortCommand(name: string, level: string | undefined): Promise<void> {
  const target = resolveAgentTarget(name);

  if (level !== undefined && !isReasoningEffort(level)) {
    return settle(Effect.fail(new KinuError('bad_input', `Reasoning effort must be one of ${REASONING_EFFORTS.join(', ')}.`)));
  }

  let result: EffortResult;

  if (target.mode === 'cloud') {
    const auth = requireAuthConfig();
    result = level
      ? await callAgentRpc({
        origin: auth.origin,
        token: auth.token,
        name: target.cloudName,
        method: 'setReasoningEffort',
        schema: EffortSetResultSchema,
        args: [level],
      })
      : await callAgentRpc({
        origin: auth.origin,
        token: auth.token,
        name: target.cloudName,
        method: 'getReasoningEffort',
        schema: StoredEffortSchema,
      });
  } else {
    result = level
      ? await setLocalWorkspaceReasoningEffort(target.localName, level)
      : { effort: (await readLocalWorkspacePins(target.localName)).reasoningEffort };
  }

  if (level) {
    console.log(`${OK('set')} ${result.effort}`);

    return;
  }

  return settle(Effect.gen(function* () {
    const shown = result.effort ?? (yield* defaultTierOf(target)).effort ?? 'medium';
    const runsAs = yield* runsAsOnItsModel(target, shown);

    console.log(`${DIM('reasoning effort')} ${shown}${result.effort === null ? ' (the default tier\'s)' : ''}${runsAs}`);
  }));
}

/** What the workspace's model, its own or the default tier's, is sent for `effort`; nothing where the catalog is unread. */
function runsAsOnItsModel(target: AgentTarget, effort: ReasoningEffort): Effect.Effect<string> {
  return Effect.gen(function* () {
    const auth = target.mode === 'cloud' ? requireAuthConfig() : null;

    const pinned = auth === null
      ? (yield* Effect.promise(() => readLocalWorkspacePins(target.localName))).model
      : yield* Effect.promise(() => storedCloudModel(auth, target.cloudName));

    const model = pinned ?? (yield* defaultTierOf(target)).model;

    if (model === null) return '';

    const catalog = auth === null
      ? yield* loadModelCatalog(() => createConfiguredLocalModelResolver().resolver.listModels())
      : yield* loadModelCatalog(() => listCloudAvailableModels(auth.origin, auth.token));

    if ('unreadable' in catalog) return '';

    return effortRunsAs(effort, catalog.models.find((entry) => entry.spec === specWithoutAccount(model))?.reasoningEfforts);
  });
}

/** Validation is advisory: an unreachable catalog must say why rather than read as an empty menu. */
type ModelCatalog = { readonly models: readonly AgentModelEntry[] } | { readonly unreadable: string };

function loadModelCatalog(load: () => Promise<ModelMenu | AgentModelMenu>): Effect.Effect<ModelCatalog> {
  return Effect.match(attempt({ doing: 'reading the model catalog', otherwise: 'unavailable' }, load), {
    onSuccess: (payload): ModelCatalog => ({ models: normalizeModelMenu({ payload }).models }),
    onFailure: (failure): ModelCatalog => ({ unreadable: renderCauseChain(failure) }),
  });
}

function validateModelSelection(
  catalog: ModelCatalog,
  resolvedSpec: string,
  rawSpec: string,
  workspace: string,
): Effect.Effect<void, KinuError> {
  return Effect.suspend(() => {
    const refused = advise(catalog, resolvedSpec, rawSpec, workspace);

    return refused === null ? Effect.void : Effect.fail(new KinuError('bad_input', refused));
  });
}

/** What setting `resolvedSpec` without the catalog's word on it means, said before it is set; why it is refused, if it is. */
function advise(
  catalog: ModelCatalog,
  resolvedSpec: string,
  rawSpec: string,
  workspace: string,
): string | null {
  if ('unreadable' in catalog) {
    console.log(`${WARN('!')} Could not read the model catalog (${catalog.unreadable}); setting ${resolvedSpec} without catalog validation.`);

    return null;
  }

  if (catalog.models.length === 0) {
    console.log(`${WARN('!')} The model catalog is empty; setting ${resolvedSpec} without catalog validation.`);

    return null;
  }

  const explicitProvider = providerPrefix(rawSpec);
  const validation = validateModelSpec(catalog.models, explicitProvider ? rawSpec.trim() : resolvedSpec);

  if (validation.status === 'known') return null;

  if (validation.status === 'unknown-provider') {
    if (explicitProvider) {
      return `Unknown model provider ${JSON.stringify(validation.provider)} in ${JSON.stringify(rawSpec)}. `
        + `Valid providers: ${validation.providers.join(', ')}.`;
    }

    console.log(`${WARN('!')} ${resolvedSpec} is not in the model catalog; setting it anyway.`);
    console.log(`  ${DIM('List models:')} run ${ACCENT(`kinu chat ${workspace}`)}, then enter ${ACCENT('/model')}.`);

    return null;
  }

  console.log(`${WARN('!')} ${resolvedSpec} is not in the model catalog for ${validation.provider}; setting it anyway.`);

  if (validation.suggestions.length > 0) {
    console.log(`  ${DIM('Close matches:')} ${validation.suggestions.join(', ')}`);
  }

  console.log(`  ${DIM('List models:')} run ${ACCENT(`kinu chat ${workspace}`)}, then enter ${ACCENT('/model')}.`);

  return null;
}

function providerPrefix(spec: string): string | null {
  const normalized = spec.trim();

  return normalized.startsWith(WORKERS_AI_MODEL_ID_PREFIX) ? null : specProvider(normalized);
}

function catalogSpec(catalog: ModelCatalog, spec: string): string {
  const normalized = spec.trim();

  if (normalized.startsWith(WORKERS_AI_MODEL_ID_PREFIX)) return specOn(WORKERS_AI_PROVIDER_ID, normalized);

  if (!('models' in catalog) || normalized.includes('/')) return normalized;
  const suffixMatches = catalog.models.filter((model) => model.spec.endsWith(`/${normalized}`));

  return suffixMatches.length === 1 ? suffixMatches[0].spec : normalized;
}

export async function toolsCommand(name: string, _opts: ControlOpts): Promise<void> {
  const target = resolveAgentTarget(name);

  if (target.mode === 'cloud') {
    const auth = requireAuthConfig();

    const tools = await callAgentRpc({
      origin: auth.origin,
      token: auth.token,
      name: target.cloudName,
      method: 'getToolDescriptions',
      schema: CloudToolDescriptionsSchema,
    });

    printTools([
      ...tools.builtIn.map((tool) => ({ ...tool, group: 'built-in' })),
      ...tools.crafted.map((tool) => ({ ...tool, group: 'crafted' })),
    ]);

    return;
  }

  const tools = getLocalToolSurface(target.localName);
  printTools([
    ...tools.builtIn.map((tool) => ({ ...tool, group: 'built-in' })),
    ...tools.crafted.map((tool) => ({ ...tool, group: 'crafted' })),
    ...tools.executors.map((executor) => ({ name: executor.name, description: executor.capabilities.join(', '), group: 'executor' })),
  ]);
}

export function triggersCommand(
  name: string,
  action: string | undefined,
  value: string | undefined,
  opts: ControlOpts,
): Promise<void> {
  return settle(Effect.gen(function* () {
    const target = resolveAgentTarget(name);
    const normalized = action ?? 'list';

    if (target.mode === 'cloud') {
      const auth = requireAuthConfig();

      if (normalized === 'list') {
        const { triggers } = yield* Effect.promise(() => callAgentRpc({
          origin: auth.origin,
          token: auth.token,
          name: target.cloudName,
          method: 'listTriggers',
          schema: CloudTriggerListSchema,
        }));

        present(triggers, opts, (rows) => printTriggers(rows, auth.origin));

        return;
      }

      if (normalized === 'cancel') {
        const id = yield* required(value, 'trigger id');
        // `'owner'`: a CLI token is the account holder's, so it may close an owner-created ingress; the model's
        // `agent.cancelSchedule` reaches the same RPC as `'self'` and may not.

        const cancelled = yield* Effect.promise(() => callAgentRpc({
          origin: auth.origin,
          token: auth.token,
          name: target.cloudName,
          method: 'cancelTrigger',
          schema: CancelTriggerSchema,
          args: [id, 'owner'],
        }));

        present({ id, ...cancelled }, opts, () =>
          console.log(`${OK('cancelled')} ${cancelled.changed ? id : `${id} (already inactive)`}`));

        return;
      }

      if (normalized === 'webhook') {
        const label = yield* required(value, 'webhook label');

        const webhookInput = webhookTriggerInput(label, {
          ...opts, rateLimit: opts.rateLimit === undefined ? undefined : parsePositiveInt(opts.rateLimit, 'rate limit'),
        });

        const created = yield* Effect.promise(() => createCloudWebhookTrigger(auth.origin, auth.token, target.cloudName, webhookInput));
        present(created, opts, (webhook) => printCreatedWebhook(webhook, auth.origin));

        return;
      }
    } else {
      if (normalized === 'webhook') return yield* new KinuError('unsupported', 'Webhook triggers require a cloud workspace.');

      if (normalized === 'list') {
        present(listLocalTriggers(target.localName).triggers, opts, printTriggers);

        return;
      }

      if (normalized === 'cancel') {
        const id = yield* required(value, 'trigger id');
        const cancelled = yield* Effect.promise(() => cancelLocalTrigger(target.localName, id));
        present({ id, ...cancelled }, opts, () =>
          console.log(`${OK('cancelled')} ${cancelled.changed ? id : `${id} (already inactive)`}`));

        return;
      }
    }

    const input = yield* timerInput(normalized, value);

    const created = target.mode === 'cloud'
      ? yield* Effect.promise(() => createCloudTimerTrigger(target.cloudName, input))
      : yield* Effect.promise(() => createLocalTimerTrigger(target.localName, input));

    present(created, opts, () => printScheduled(created));
  }));
}

function createCloudTimerTrigger(cloudName: string, input: Pick<TimerTriggerOpts, 'cron' | 'atMs' | 'label'>): Promise<TimerTrigger> {
  const auth = requireAuthConfig();

  // trust:'owner': an interactive session token is the owner.
  return callAgentRpc({
    origin: auth.origin,
    token: auth.token,
    name: cloudName,
    method: 'createTimerTrigger',
    schema: TimerTriggerSchema,
    args: [{ ...input, trust: 'owner' }],
  });
}

function printScheduled(trigger: { id: string; kind: string; nextFireAt: number | null }): void {
  console.log(`${OK('scheduled')} ${trigger.id} ${DIM(trigger.kind)} ${formatTime(trigger.nextFireAt)}`);
}

export function jobsCommand(name: string, action: string | undefined, id: string | undefined, opts: ControlOpts): Promise<void> {
  return settle(Effect.gen(function* () {
    const target = resolveAgentTarget(name);
    const cancelling = (action ?? 'list') === 'cancel';

    if (target.mode === 'cloud') {
      const auth = requireAuthConfig();

      if (cancelling) {
        const job = yield* required(id, 'job id');

        const cancelled = yield* Effect.promise(() => callAgentRpc({
          origin: auth.origin,
          token: auth.token,
          name: target.cloudName,
          method: 'cancelBackgroundJob',
          schema: CancelJobSchema,
          args: [job],
        }));

        present({ id: job, ...cancelled }, opts, () =>
          saidCancelled(job, cancelled.ok));

        return;
      }

      const jobs = yield* Effect.promise(() => callAgentRpc({
        origin: auth.origin,
        token: auth.token,
        name: target.cloudName,
        method: 'listBackgroundJobs',
        schema: v.array(CloudBackgroundJobSchema),
        args: [20],
      }));

      present(jobs, opts, printJobs);

      return;
    }

    if (cancelling) {
      const job = yield* required(id, 'job id');
      const cancelled = yield* Effect.promise(() => cancelLocalJob(target.localName, job, liveDaemonPid()));
      present({ id: job, ...cancelled }, opts, () =>
        saidCancelled(job, cancelled.ok));

      return;
    }

    present(listLocalJobs(target.localName), opts, printJobs);
  }));
}

/** A command argument its action needs, or the refusal naming it. */
function required(value: string | undefined, what: string): Effect.Effect<string, KinuError> {
  return value ? Effect.succeed(value) : Effect.fail(new KinuError('bad_input', `${what} required`));
}

/** Raw JSON under `--json`, human rendering otherwise; shared by every read/mutate command. */
function present<T extends JsonValue | object>(data: T, opts: ControlOpts, human: (data: T) => void): void {
  if (opts.json) printJson(projectJsonValue({ value: data }));
  else human(data);
}

function timerInput(action: string, value: string | undefined): Effect.Effect<Pick<TimerTriggerOpts, 'cron' | 'atMs' | 'label'>, KinuError> {
  if (action === 'every') return Effect.map(required(value, 'cron expression'), (cron) => ({ cron }));

  if (action === 'at') return Effect.map(required(value, 'time'), (time) => ({ atMs: parseTime(time, 'time') }));

  return Effect.fail(new KinuError('bad_input', 'trigger action must be list, every, at, webhook, or cancel'));
}

function printTools(tools: Array<{ name: string; description?: string; group: string }>): void {
  if (tools.length === 0) {
    console.log(DIM('No tools.'));

    return;
  }

  for (const tool of tools) {
    console.log(`${ACCENT(tool.name)} ${DIM(tool.group)}`);

    if (tool.description) console.log(`  ${DIM(tool.description)}`);
  }
}

/** A local workspace has no inbound transport, so no `origin` and no delivery URL. */
function printTriggers(
  triggers: Array<{
    id: string; kind: string; state?: string; next_fire_at?: number | null;
    fire_count?: number; url?: string;
  }>,
  origin?: string,
): void {
  if (triggers.length === 0) {
    console.log(DIM('No triggers.'));

    return;
  }

  for (const trigger of triggers) {
    console.log(`${ACCENT(trigger.id)} ${trigger.kind} ${DIM(trigger.state ?? '')} ${formatTime(trigger.next_fire_at ?? null)} ${DIM(`fires=${trigger.fire_count ?? 0}`)}`);

    if (trigger.url) console.log(`  ${DIM('url')} ${ACCENT(`${origin ?? ''}${trigger.url}`)}`);
  }
}

function printJobs(jobs: Array<{ id: string; kind?: string; status: string; error?: string | null }>): void {
  if (jobs.length === 0) {
    console.log(DIM('No background jobs.'));

    return;
  }

  for (const job of jobs) {
    console.log(`${ACCENT(job.id)} ${job.kind ?? ''} ${DIM(job.status)}${job.error ? ` ${job.error}` : ''}`);
  }
}

function printCreatedWebhook(created: CloudWebhookTrigger, origin: string): void {
  console.log(`${OK('created')} ${created.trigger_id}`);
  console.log(`${DIM('url')} ${ACCENT(`${origin}${created.url}`)}`);

  // hmac/bearer webhooks always carry one, and this is the only time it is shown.
  if (created.secret) {
    console.log(`${DIM('secret')} ${created.secret}`);
    console.log(DIM('Store it now: the secret is shown once and cannot be read again'));
  }
}

function formatTime(value: number | null | undefined): string {
  return value ? DIM(new Date(value).toLocaleString()) : DIM('(not scheduled)');
}
