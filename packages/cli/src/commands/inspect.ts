import { renderAlignmentConvergence, renderCalibrationReport, type AlignmentConvergence } from '@proteus/core';
import { resolveAgentTarget } from '../agent-target.js';
import { fetchReport } from './label.js';
import { requireAuthConfig } from '../config.js';
import { callAgentRpc, createCloudWebhookTrigger } from '../cloud-api.js';
import { ACCENT, DIM, ERR, OK, printSearchTree, WARN } from '../display.js';
import {
  executeLocalExecutor,
  getLocalAgentState,
  getLocalAlignment,
  getLocalGepaRun,
  getLocalMctsNode,
  getLocalProductBoard,
  listLocalEvents,
  listLocalExecutors,
  listLocalGepaRuns,
  listLocalHeads,
  listLocalMcts,
  listLocalTimeline,
  markLocalBackgroundJobsCancelled,
  readLocalMemory,
  searchLocalMemory,
  type LocalExecutorInfo,
} from '../local-inspection.js';

interface InspectOpts {
  json?: boolean;
  limit?: string;
  variant?: string;
  since?: string;
}

export async function stopCommand(name: string, opts: InspectOpts = {}): Promise<void> {
  const target = resolveAgentTarget(name);
  if (target.mode === 'cloud') {
    const auth = requireAuthConfig();
    const result = await callAgentRpc(auth.origin, auth.token, target.cloudName, 'cancelCurrentWork');
    if (opts.json) printJson(result);
    else console.log(`${OK('stopped')} ${target.name}`);
    return;
  }

  const cancelled = markLocalBackgroundJobsCancelled(target.localName);
  if (opts.json) {
    printJson({
      ok: true,
      cancelledBackgroundJobs: cancelled,
      note: 'Foreground local turns can only be interrupted from their owning terminal session.',
    });
    return;
  }
  if (cancelled.length > 0) console.log(`${OK('cancelled')} ${cancelled.length} background job${cancelled.length === 1 ? '' : 's'}`);
  console.log(`${WARN('local foreground turns are process-local')} use Ctrl+C in the terminal running that turn.`);
}

export async function stateCommand(name: string, opts: InspectOpts = {}): Promise<void> {
  const target = resolveAgentTarget(name);
  const data = await readTarget(target, {
    cloud: (auth) => callAgentRpc(auth.origin, auth.token, target.cloudName, 'getWorkspaceSnapshot'),
    local: () => getLocalAgentState(target.localName),
  });
  printData(data, opts);
}

export async function memoryCommand(name: string, queryParts: string[] = [], opts: InspectOpts = {}): Promise<void> {
  const target = resolveAgentTarget(name);
  const query = queryParts.join(' ').trim();
  const limit = parseLimit(opts.limit, 10);
  const data = await readTarget(target, {
    cloud: async (auth) => query
      ? callAgentRpc(auth.origin, auth.token, target.cloudName, 'searchMemoryHybrid', [query, limit])
      : { content: await callAgentRpc<string>(auth.origin, auth.token, target.cloudName, 'getMemoryContent') },
    local: () => query
      ? searchLocalMemory(target.localName, query, limit)
      : { content: readLocalMemory(target.localName) },
  });
  if (opts.json || query) {
    printData(data, opts);
    return;
  }
  const content = typeof data === 'object' && data !== null && 'content' in data ? String(data.content ?? '') : '';
  console.log(content || DIM('(memory is empty)'));
}

export async function eventsCommand(name: string, opts: InspectOpts = {}): Promise<void> {
  const target = resolveAgentTarget(name);
  const limit = parseLimit(opts.limit, 50);
  const since = opts.since ? parseTime(opts.since) : undefined;
  const data = await readTarget(target, {
    cloud: (auth) => callAgentRpc(auth.origin, auth.token, target.cloudName, 'listRecentEvents', [{ variant: opts.variant, since, limit }]),
    local: () => listLocalEvents(target.localName, { variant: opts.variant, since, limit }),
  });
  printRows(data, opts, formatEventRow);
}

export async function timelineCommand(name: string, opts: InspectOpts = {}): Promise<void> {
  const target = resolveAgentTarget(name);
  const limit = parseLimit(opts.limit, 100);
  const data = await readTarget(target, {
    cloud: (auth) => callAgentRpc(auth.origin, auth.token, target.cloudName, 'getRunTimeline', [{ limit }]),
    local: () => listLocalTimeline(target.localName, limit),
  });
  printRows(data, opts, formatTimelineRow);
}

export async function mctsCommand(name: string, nodeId: string | undefined, opts: InspectOpts = {}): Promise<void> {
  const target = resolveAgentTarget(name);
  const data = await readTarget(target, {
    cloud: (auth) => nodeId
      ? callAgentRpc(auth.origin, auth.token, target.cloudName, 'getMctsNodeDetail', [nodeId])
      : callAgentRpc(auth.origin, auth.token, target.cloudName, 'getMctsTree'),
    local: () => nodeId ? getLocalMctsNode(target.localName, nodeId) : listLocalMcts(target.localName),
  });
  if (!nodeId && !opts.json && Array.isArray(data)) {
    printSearchTree(data as Parameters<typeof printSearchTree>[0]);
    return;
  }
  printData(data, opts);
}

export async function headsCommand(name: string, opts: InspectOpts = {}): Promise<void> {
  const target = resolveAgentTarget(name);
  const limit = parseLimit(opts.limit, 20);
  const data = await readTarget(target, {
    cloud: (auth) => callAgentRpc(auth.origin, auth.token, target.cloudName, 'getHeadRuns', [limit]),
    local: () => listLocalHeads(target.localName, limit),
  });
  printRows(data, opts, formatHeadRow);
}

export async function gepaCommand(name: string, runId: string | undefined, opts: InspectOpts = {}): Promise<void> {
  const target = resolveAgentTarget(name);
  const limit = parseLimit(opts.limit, 20);
  const data = await readTarget(target, {
    cloud: (auth) => runId
      ? callAgentRpc(auth.origin, auth.token, target.cloudName, 'getGepaRun', [runId])
      : callAgentRpc(auth.origin, auth.token, target.cloudName, 'getGepaRuns', [limit]),
    local: () => runId ? getLocalGepaRun(target.localName, runId) : listLocalGepaRuns(target.localName, limit),
  });
  printRows(data, opts, formatGepaRow);
}

export async function executorsCommand(
  name: string,
  executor: string | undefined,
  commandParts: string[] = [],
  opts: InspectOpts = {},
): Promise<void> {
  if (executor) {
    await runExecutorCommand(name, executor, commandParts, opts);
    return;
  }
  const target = resolveAgentTarget(name);
  const data = await readTarget(target, {
    cloud: (auth) => callAgentRpc(auth.origin, auth.token, target.cloudName, 'getExecutors'),
    local: () => listLocalExecutors(),
  });
  printRows(data, opts, formatExecutorRow);
}

async function runExecutorCommand(name: string, executor: string, commandParts: string[] = [], opts: InspectOpts = {}): Promise<void> {
  const command = commandParts.join(' ').trim();
  if (!command) throw new Error('command required');
  const target = resolveAgentTarget(name);
  const data = await readTarget(target, {
    cloud: (auth) => callAgentRpc(auth.origin, auth.token, target.cloudName, 'executeInExecutor', [executor, command]),
    local: () => executeLocalExecutor(target.localName, executor, command),
  });
  if (opts.json) {
    printJson(data);
    return;
  }
  if (typeof data === 'object' && data !== null && 'stdout' in data) {
    const result = data as { stdout?: unknown; stderr?: unknown; exitCode?: unknown; error?: unknown };
    if (result.error) console.log(`${ERR('error')} ${String(result.error)}`);
    if (result.stdout) process.stdout.write(String(result.stdout));
    if (result.stderr) process.stderr.write(String(result.stderr));
    if (typeof result.exitCode === 'number' && result.exitCode !== 0) process.exitCode = result.exitCode;
    return;
  }
  printData(data, opts);
}

/** K_align — how often the user had to correct this agent, per 100 graded
 *  turns, split by the scaffold version that served them.
 *
 *  Always printed with the calibration block underneath it: the rate above is
 *  the CLASSIFIER's count of corrections, and how far that is from the real
 *  one is a measurement, not an assumption. Without hand labels the block says
 *  "uncalibrated" rather than leaving the reader to assume the two agree. */
export async function alignmentCommand(name: string, opts: InspectOpts = {}): Promise<void> {
  const target = resolveAgentTarget(name);
  const data = await readTarget(target, {
    cloud: (auth) => callAgentRpc(auth.origin, auth.token, target.cloudName, 'getAlignmentConvergence'),
    local: () => getLocalAlignment(target.localName),
  });
  const calibration = await fetchReport(target);
  if (opts.json) {
    printJson({ alignment: data, calibration });
    return;
  }
  console.log(renderAlignmentConvergence(data as AlignmentConvergence));
  console.log('');
  console.log(renderCalibrationReport(calibration));
}

export async function productCommand(name: string, opts: InspectOpts = {}): Promise<void> {
  const target = resolveAgentTarget(name);
  const limit = parseLimit(opts.limit, 20);
  const data = await readTarget(target, {
    cloud: (auth) => callAgentRpc(auth.origin, auth.token, target.cloudName, 'getProductChangeBoard', [limit]),
    local: () => getLocalProductBoard(target.localName, limit),
  });
  printData(data, opts);
}

export async function webhookCommand(name: string, label: string | undefined, opts: InspectOpts & {
  authMode?: string;
  secret?: string;
  contentType?: string;
  rateLimit?: string;
} = {}): Promise<void> {
  if (!label) throw new Error('webhook label required');
  const target = resolveAgentTarget(name);
  if (target.mode !== 'cloud') throw new Error('Webhook triggers require a cloud workspace.');
  const auth = requireAuthConfig();
  const authMode = normalizeWebhookAuthMode(opts.authMode);
  const created = await createCloudWebhookTrigger(auth.origin, auth.token, target.cloudName, {
    label,
    auth_mode: authMode,
    ...(opts.secret ? { secret: opts.secret } : {}),
    ...(opts.contentType ? { accepted_content_type: opts.contentType } : {}),
    ...(opts.rateLimit ? { rate_limit_per_min: parsePositiveInt(opts.rateLimit, 'rate limit') } : {}),
  });
  printData(created, opts);
}

async function readTarget(target: { mode: 'cloud' | 'local' }, fns: {
  cloud(auth: { origin: string; token: string }): Promise<unknown> | unknown;
  local(): Promise<unknown> | unknown;
}): Promise<unknown> {
  if (target.mode === 'cloud') return fns.cloud(requireAuthConfig());
  return fns.local();
}

function parseLimit(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  return parsePositiveInt(value, 'limit');
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

function normalizeWebhookAuthMode(value: string | undefined): 'hmac' | 'bearer' | 'mtls' {
  const raw = (value ?? 'hmac').toLowerCase();
  if (raw === 'hmac' || raw === 'bearer' || raw === 'mtls') return raw;
  throw new Error('--auth-mode must be hmac, bearer, or mtls');
}

function printData(data: unknown, opts: InspectOpts): void {
  if (opts.json) printJson(data);
  else printPretty(data);
}

function printRows(data: unknown, opts: InspectOpts, format: (item: unknown) => string): void {
  if (opts.json || !Array.isArray(data)) {
    printData(data, opts);
    return;
  }
  if (data.length === 0) {
    console.log(DIM('No records.'));
    return;
  }
  for (const item of data) console.log(format(item));
}

function printJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

function printPretty(data: unknown): void {
  if (typeof data === 'string') console.log(data);
  else console.log(JSON.stringify(data, null, 2));
}

function formatEventRow(item: unknown): string {
  const row = asRecord(item);
  return `${ACCENT(String(row.id ?? 'event'))} ${String(row.variant ?? '')} ${DIM(String(row.ingress ?? ''))} ${formatDate(row.received_at ?? row.receivedAt)}`;
}

function formatTimelineRow(item: unknown): string {
  const row = asRecord(item);
  const label = row.label ?? row.message ?? row.kind ?? row.id ?? 'entry';
  return `${formatDate(row.ts ?? row.received_at ?? row.created_at)} ${ACCENT(String(row.kind ?? row.type ?? 'event'))} ${DIM(String(label).slice(0, 120))}`;
}

function formatHeadRow(item: unknown): string {
  const row = asRecord(item);
  return `${ACCENT(String(row.rootId ?? row.id ?? 'head'))} ${String(row.status ?? '')} ${DIM(String(row.task ?? row.rationale ?? '').slice(0, 100))}`;
}

function formatGepaRow(item: unknown): string {
  const row = asRecord(item);
  return `${ACCENT(String(row.runId ?? row.id ?? 'gepa'))} ${String(row.status ?? '')} ${DIM(String(row.target ?? row.stopReason ?? '').slice(0, 100))}`;
}

function formatExecutorRow(item: unknown): string {
  const row = asRecord(item) as Partial<LocalExecutorInfo> & Record<string, unknown>;
  const caps = Array.isArray(row.capabilities) ? row.capabilities.join(', ') : '';
  return `${ACCENT(String(row.name ?? row.id ?? 'executor'))} ${DIM(String(row.kind ?? ''))} ${String(row.status ?? '')} ${DIM(caps)}`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? value as Record<string, unknown> : {};
}

function formatDate(value: unknown): string {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DIM('');
  return DIM(new Date(value).toLocaleString());
}
