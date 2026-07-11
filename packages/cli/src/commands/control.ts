import {
  requireAuthConfig,
} from '../config.js';
import { resolveAgentTarget } from '../agent-target.js';
import {
  cancelLocalJob,
  cancelLocalTrigger,
  createLocalTimerTrigger,
  getLocalStoredModel,
  getLocalToolSurface,
  listLocalJobs,
  listLocalTriggers,
  setLocalStoredModel,
} from '../local-inspection.js';
import {
  callAgentRpc,
  createCloudWebhookTrigger,
  type CloudBackgroundJob,
  type CloudToolDescriptions,
  type CloudTriggerList,
} from '../cloud-api.js';
import { ACCENT, DIM, OK } from '../display.js';

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

export async function modelCommand(name: string, spec: string | undefined, opts: ControlOpts): Promise<void> {
  const target = resolveAgentTarget(name);
  if (target.mode === 'cloud') {
    const auth = requireAuthConfig();
    const result = spec
      ? await callAgentRpc<{ ok: true; spec: string }>(auth.origin, auth.token, target.cloudName, 'setModel', [spec])
      : await callAgentRpc<{ spec: string | null }>(auth.origin, auth.token, target.cloudName, 'getStoredModelSpec');
    console.log(spec ? `${OK('set')} ${result.spec}` : `${DIM('model')} ${result.spec ?? '(default)'}`);
    return;
  }

  const result = spec ? setLocalStoredModel(target.localName, spec) : getLocalStoredModel(target.localName);
  console.log(spec ? `${OK('set')} ${result.spec}` : `${DIM('model')} ${result.spec ?? '(default)'}`);
}

export async function toolsCommand(name: string, opts: ControlOpts): Promise<void> {
  const target = resolveAgentTarget(name);
  if (target.mode === 'cloud') {
    const auth = requireAuthConfig();
    const tools = await callAgentRpc<CloudToolDescriptions>(auth.origin, auth.token, target.cloudName, 'getToolDescriptions');
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
      printTriggers((await callAgentRpc<CloudTriggerList>(auth.origin, auth.token, target.cloudName, 'listTriggers')).triggers);
      return;
    }
    if (normalized === 'cancel') {
      if (!value) throw new Error('trigger id required');
      const cancelled = await callAgentRpc<{ ok: true; changed: boolean }>(auth.origin, auth.token, target.cloudName, 'cancelTrigger', [value]);
      console.log(`${OK('cancelled')} ${cancelled.changed ? value : `${value} (already inactive)`}`);
      return;
    }
    if (normalized === 'webhook') {
      if (!value) throw new Error('webhook label required');
      const created = await createCloudWebhookTrigger(auth.origin, auth.token, target.cloudName, {
        label: value,
        auth_mode: normalizeWebhookAuthMode(opts.authMode),
        ...(opts.secret ? { secret: opts.secret } : {}),
        ...(opts.contentType ? { accepted_content_type: opts.contentType } : {}),
        ...(opts.rateLimit ? { rate_limit_per_min: parsePositiveInt(opts.rateLimit, 'rate limit') } : {}),
      });
      if (opts.json) console.log(JSON.stringify(created, null, 2));
      else printCreatedWebhook(created);
      return;
    }
    const input = timerInput(normalized, value);
    // trust:'owner' — an interactive session token IS the owner (the old
    // per-route matcher stamped the same value server-side).
    const created = await callAgentRpc<{ id: string; kind: 'timer_cron' | 'timer_oneshot'; nextFireAt: number | null }>(
      auth.origin, auth.token, target.cloudName, 'createTimerTrigger', [{ ...input, trust: 'owner' }],
    );
    console.log(`${OK('scheduled')} ${created.id} ${DIM(created.kind)} ${formatTime(created.nextFireAt)}`);
    return;
  }

  if (normalized === 'webhook') throw new Error('Webhook triggers require a cloud workspace.');

  if (normalized === 'list') {
    printTriggers(listLocalTriggers(target.localName).triggers as Parameters<typeof printTriggers>[0]);
    return;
  }
  if (normalized === 'cancel') {
    if (!value) throw new Error('trigger id required');
    console.log(`${OK('cancelled')} ${cancelLocalTrigger(target.localName, value).changed ? value : `${value} (already inactive)`}`);
    return;
  }
  const created = createLocalTimerTrigger(target.localName, timerInput(normalized, value)) as { id?: string; kind?: string; nextFireAt?: number; next_fire_at?: number };
  console.log(`${OK('scheduled')} ${created.id ?? '(trigger)'} ${DIM(created.kind ?? '')} ${formatTime(created.nextFireAt ?? created.next_fire_at ?? null)}`);
}

export async function jobsCommand(name: string, action: string | undefined, id: string | undefined, opts: ControlOpts): Promise<void> {
  const target = resolveAgentTarget(name);
  const normalized = action ?? 'list';
  if (target.mode === 'cloud') {
    const auth = requireAuthConfig();
    if (normalized === 'cancel') {
      if (!id) throw new Error('job id required');
      const cancelled = await callAgentRpc<{ ok: boolean }>(auth.origin, auth.token, target.cloudName, 'cancelBackgroundJob', [id]);
      console.log(`${OK('cancelled')} ${cancelled.ok ? id : `${id} (not running)`}`);
      return;
    }
    printJobs(await callAgentRpc<CloudBackgroundJob[]>(auth.origin, auth.token, target.cloudName, 'listBackgroundJobs', [20]));
    return;
  }

  if (normalized === 'cancel') {
    if (!id) throw new Error('job id required');
    console.log(`${OK('cancelled')} ${cancelLocalJob(target.localName, id).ok ? id : `${id} (not running)`}`);
    return;
  }
  printJobs(listLocalJobs(target.localName) as Parameters<typeof printJobs>[0]);
}

function timerInput(action: string, value: string | undefined): { cron?: string; atMs?: number; label?: string } {
  if (action === 'every') {
    if (!value) throw new Error('cron expression required');
    return { cron: value };
  }
  if (action === 'at') {
    if (!value) throw new Error('time required');
    return { atMs: parseTime(value) };
  }
  throw new Error('trigger action must be list, every, at, webhook, or cancel');
}

function normalizeWebhookAuthMode(value: string | undefined): 'hmac' | 'bearer' | 'mtls' {
  const raw = (value ?? 'hmac').toLowerCase();
  if (raw === 'hmac' || raw === 'bearer' || raw === 'mtls') return raw;
  throw new Error('--auth-mode must be hmac, bearer, or mtls');
}

function parsePositiveInt(value: string, label: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function parseTime(value: string): number {
  if (/^\d+$/.test(value)) return Number(value);
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error(`Invalid time: ${value}`);
  return parsed;
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

function printTriggers(triggers: Array<{ id: string; kind: string; state?: string; next_fire_at?: number | null; fire_count?: number }>): void {
  if (triggers.length === 0) {
    console.log(DIM('No triggers.'));
    return;
  }
  for (const trigger of triggers) {
    console.log(`${ACCENT(trigger.id)} ${trigger.kind} ${DIM(trigger.state ?? '')} ${formatTime(trigger.next_fire_at ?? null)} ${DIM(`fires=${trigger.fire_count ?? 0}`)}`);
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

function printCreatedWebhook(created: unknown): void {
  if (typeof created !== 'object' || created === null) {
    console.log(`${OK('created')} ${String(created)}`);
    return;
  }
  const record = created as Record<string, unknown>;
  console.log(`${OK('created')} ${String(record.id ?? 'webhook')}`);
  const url = record.url ?? record.endpoint ?? record.webhookUrl;
  if (url) console.log(`${DIM('url')} ${ACCENT(String(url))}`);
  const secret = record.secret;
  if (secret) console.log(`${DIM('secret')} ${String(secret)}`);
}

function formatTime(value: number | null | undefined): string {
  return value ? DIM(new Date(value).toLocaleString()) : DIM('(not scheduled)');
}
