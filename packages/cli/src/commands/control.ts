import { requireAuthConfig } from '../config';
import { isReasoningEffort, projectJsonValue, REASONING_EFFORTS, type JsonValue, type ModelMenu, type ReasoningEffort, type TimerTrigger, type TimerTriggerOpts } from '@kinu.run/core';
import { resolveAgentTarget } from '../agent-target';
import {
  cancelLocalJob,
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
  CloudBackgroundJobSchema,
  CloudToolDescriptionsSchema,
  CloudTriggerListSchema,
  createCloudWebhookTrigger,
  listCloudAvailableModels,
  type CloudModelMenu,
  type CloudWebhookTrigger,
  type CloudWebhookTriggerInput,
} from '../cloud-api';
import * as v from 'valibot';
import { ACCENT, DIM, OK, printJson, WARN } from '../display';
import { normalizeWebhookAuthMode, parsePositiveInt, parseTime } from '../options';
import { createConfiguredLocalModelResolver } from '../local-model-resolver';
import {
  normalizeModelMenu,
  validateModelSpec,
  type AgentModelEntry,
} from '@kinu.run/core';
import { renderThrownChain } from '@kinu.run/core/obs';

interface ControlOpts {
  model?: string;
  baseUrl?: string;
  auth?: string;
  authMode?: string;
  secret?: string;
  contentType?: string;
  rateLimit?: string;
  json?: boolean;
}

const EffortSetResultSchema = v.object({ ok: v.literal(true), effort: v.picklist(['low', 'medium', 'high']) });

const StoredEffortSchema = v.object({ effort: v.nullable(v.picklist(['low', 'medium', 'high'])) });

const ModelSetResultSchema = v.object({ ok: v.literal(true), spec: v.string() });

const StoredModelSchema = v.object({ spec: v.nullable(v.string()) });

const CancelTriggerSchema = v.object({ ok: v.literal(true), changed: v.boolean() });

const TimerTriggerSchema = v.object({
  id: v.string(), kind: v.picklist(['timer_cron', 'timer_oneshot']), nextFireAt: v.nullable(v.number()),
});

const CancelJobSchema = v.object({ ok: v.boolean() });

export async function modelCommand(name: string, spec: string | undefined, opts: ControlOpts): Promise<void> {
  const target = resolveAgentTarget(name);
  let resolvedSpec = spec;

  if (spec) {
    if (target.mode === 'cloud') {
      const auth = requireAuthConfig();
      const catalog = await loadModelCatalog(() => listCloudAvailableModels(auth.origin, auth.token));
      resolvedSpec = catalogSpec(catalog, spec);
      validateModelSelection(catalog, resolvedSpec, spec, name);
    } else {
      const configured = createConfiguredLocalModelResolver({
        model: opts.model,
        baseUrl: opts.baseUrl,
        auth: opts.auth,
        agentName: target.localName,
      });

      const catalog = await loadModelCatalog(() => configured.resolver.listModels());
      resolvedSpec = configured.resolver.normalizeSpecSync(spec);
      validateModelSelection(catalog, resolvedSpec, spec, name);
    }
  }

  let stored: string | null;

  if (target.mode === 'cloud') {
    const auth = requireAuthConfig();

    stored = resolvedSpec
      ? (await callAgentRpc({
        origin: auth.origin, token: auth.token, name: target.cloudName,
        method: 'setModel', schema: ModelSetResultSchema, args: [resolvedSpec],
      })).spec
      : (await callAgentRpc({
        origin: auth.origin, token: auth.token, name: target.cloudName,
        method: 'getStoredModelSpec', schema: StoredModelSchema,
      })).spec;
  } else {
    stored = resolvedSpec
      ? (await setLocalWorkspaceModel(target.localName, resolvedSpec)).spec
      : (await readLocalWorkspacePins(target.localName)).model;
  }

  if (spec) {
    console.log(`${OK('set')} ${stored}`);

    return;
  }

  console.log(`${DIM('model')} ${stored ?? `${readDefaultTier()?.model ?? 'none named'} (the default tier's)`}`);
}

interface EffortResult {
  readonly effort: ReasoningEffort | null;
}

export async function effortCommand(name: string, level: string | undefined): Promise<void> {
  const target = resolveAgentTarget(name);

  if (level !== undefined && !isReasoningEffort(level)) {
    throw new Error(`Reasoning effort must be one of ${REASONING_EFFORTS.join(', ')}.`);
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

  console.log(`${DIM('reasoning effort')} ${result.effort ?? `${readDefaultTier()?.reasoningEffort ?? 'medium'} (the default tier's)`}`);
}

/** Validation is advisory: an unreachable catalog must say why rather than read as an empty menu. */
type ModelCatalog = { readonly models: readonly AgentModelEntry[] } | { readonly unreadable: string };

async function loadModelCatalog(load: () => Promise<ModelMenu | CloudModelMenu>): Promise<ModelCatalog> {
  try {
    return { models: normalizeModelMenu({ payload: await load() }).models };
  } catch (error) {
    return { unreadable: renderThrownChain({ cause: error }) };
  }
}

function validateModelSelection(
  catalog: ModelCatalog,
  resolvedSpec: string,
  rawSpec: string,
  workspace: string,
): void {
  if ('unreadable' in catalog) {
    console.log(`${WARN('!')} Could not read the model catalog (${catalog.unreadable}); setting ${resolvedSpec} without catalog validation.`);

    return;
  }

  if (catalog.models.length === 0) {
    console.log(`${WARN('!')} The model catalog is empty; setting ${resolvedSpec} without catalog validation.`);

    return;
  }

  const explicitProvider = providerPrefix(rawSpec);
  const validation = validateModelSpec(catalog.models, explicitProvider ? rawSpec.trim() : resolvedSpec);

  if (validation.status === 'known') return;

  if (validation.status === 'unknown-provider') {
    if (!explicitProvider) {
      console.log(`${WARN('!')} ${resolvedSpec} is not in the model catalog; setting it anyway.`);
      console.log(`  ${DIM('List models:')} run ${ACCENT(`kinu chat ${workspace}`)}, then enter ${ACCENT('/model')}.`);

      return;
    }

    throw new Error(
      `Unknown model provider ${JSON.stringify(validation.provider)} in ${JSON.stringify(rawSpec)}. `
      + `Valid providers: ${validation.providers.join(', ')}.`,
    );
  }

  console.log(`${WARN('!')} ${resolvedSpec} is not in the model catalog for ${validation.provider}; setting it anyway.`);

  if (validation.suggestions.length > 0) {
    console.log(`  ${DIM('Close matches:')} ${validation.suggestions.join(', ')}`);
  }

  console.log(`  ${DIM('List models:')} run ${ACCENT(`kinu chat ${workspace}`)}, then enter ${ACCENT('/model')}.`);
}

function providerPrefix(spec: string): string | null {
  const normalized = spec.trim();

  if (!normalized || normalized.startsWith('@cf/')) return null;
  const slash = normalized.indexOf('/');

  return slash > 0 ? normalized.slice(0, slash) : null;
}

function catalogSpec(catalog: ModelCatalog, spec: string): string {
  const normalized = spec.trim();

  if (normalized.startsWith('@cf/')) return `workers-ai/${normalized}`;

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

export async function triggersCommand(
  name: string,
  action: string | undefined,
  value: string | undefined,
  opts: ControlOpts,
): Promise<void> {
  const target = resolveAgentTarget(name);
  const normalized = action ?? 'list';

  if (target.mode === 'cloud') {
    const auth = requireAuthConfig();

    if (normalized === 'list') {
      const { triggers } = await callAgentRpc({
        origin: auth.origin,
        token: auth.token,
        name: target.cloudName,
        method: 'listTriggers',
        schema: CloudTriggerListSchema,
      });

      present(triggers, opts, (rows) => printTriggers(rows, auth.origin));

      return;
    }

    if (normalized === 'cancel') {
      if (!value) throw new Error('trigger id required');
      // `'owner'`: a CLI token is the account holder's, so it may close an owner-created ingress; the model's
      // `agent.cancelSchedule` reaches the same RPC as `'self'` and may not.

      const cancelled = await callAgentRpc({
        origin: auth.origin,
        token: auth.token,
        name: target.cloudName,
        method: 'cancelTrigger',
        schema: CancelTriggerSchema,
        args: [value, 'owner'],
      });

      present({ id: value, ...cancelled }, opts, () =>
        console.log(`${OK('cancelled')} ${cancelled.changed ? value : `${value} (already inactive)`}`));

      return;
    }

    if (normalized === 'webhook') {
      if (!value) throw new Error('webhook label required');

      const webhookInput: CloudWebhookTriggerInput = {
        label: value,
        auth_mode: normalizeWebhookAuthMode(opts.authMode),
      };

      if (opts.secret) webhookInput.secret = opts.secret;

      if (opts.contentType) webhookInput.accepted_content_type = opts.contentType;

      if (opts.rateLimit) webhookInput.rate_limit_per_min = parsePositiveInt(opts.rateLimit, 'rate limit');
      const created = await createCloudWebhookTrigger(auth.origin, auth.token, target.cloudName, webhookInput);
      present(created, opts, (webhook) => printCreatedWebhook(webhook, auth.origin));

      return;
    }
  } else {
    if (normalized === 'webhook') throw new Error('Webhook triggers require a cloud workspace.');

    if (normalized === 'list') {
      present(listLocalTriggers(target.localName).triggers, opts, printTriggers);

      return;
    }

    if (normalized === 'cancel') {
      if (!value) throw new Error('trigger id required');
      const cancelled = await cancelLocalTrigger(target.localName, value);
      present({ id: value, ...cancelled }, opts, () =>
        console.log(`${OK('cancelled')} ${cancelled.changed ? value : `${value} (already inactive)`}`));

      return;
    }
  }

  const created = target.mode === 'cloud'
    ? await createCloudTimerTrigger(target.cloudName, normalized, value)
    : await createLocalTimerTrigger(target.localName, timerInput(normalized, value));

  present(created, opts, () => printScheduled(created));
}

async function createCloudTimerTrigger(cloudName: string, action: string, value: string | undefined): Promise<TimerTrigger> {
  const auth = requireAuthConfig();
  const input = timerInput(action, value);

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

export async function jobsCommand(name: string, action: string | undefined, id: string | undefined, opts: ControlOpts): Promise<void> {
  const target = resolveAgentTarget(name);
  const normalized = action ?? 'list';

  if (target.mode === 'cloud') {
    const auth = requireAuthConfig();

    if (normalized === 'cancel') {
      if (!id) throw new Error('job id required');

      const cancelled = await callAgentRpc({
        origin: auth.origin,
        token: auth.token,
        name: target.cloudName,
        method: 'cancelBackgroundJob',
        schema: CancelJobSchema,
        args: [id],
      });

      present({ id, ...cancelled }, opts, () =>
        console.log(`${OK('cancelled')} ${cancelled.ok ? id : `${id} (not running)`}`));

      return;
    }

    const jobs = await callAgentRpc({
      origin: auth.origin,
      token: auth.token,
      name: target.cloudName,
      method: 'listBackgroundJobs',
      schema: v.array(CloudBackgroundJobSchema),
      args: [20],
    });

    present(jobs, opts, printJobs);

    return;
  }

  if (normalized === 'cancel') {
    if (!id) throw new Error('job id required');
    const cancelled = await cancelLocalJob(target.localName, id);
    present({ id, ...cancelled }, opts, () =>
      console.log(`${OK('cancelled')} ${cancelled.ok ? id : `${id} (not running)`}`));

    return;
  }

  present(listLocalJobs(target.localName), opts, printJobs);
}

/** Raw JSON under `--json`, human rendering otherwise; shared by every read/mutate command. */
function present<T extends JsonValue | object>(data: T, opts: ControlOpts, human: (data: T) => void): void {
  if (opts.json) printJson(projectJsonValue({ value: data }));
  else human(data);
}

function timerInput(action: string, value: string | undefined): Pick<TimerTriggerOpts, 'cron' | 'atMs' | 'label'> {
  if (action === 'every') {
    if (!value) throw new Error('cron expression required');

    return { cron: value };
  }

  if (action === 'at') {
    if (!value) throw new Error('time required');

    return { atMs: parseTime(value, 'time') };
  }

  throw new Error('trigger action must be list, every, at, webhook, or cancel');
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
