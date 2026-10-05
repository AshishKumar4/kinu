import { Effect } from 'effect';
import { settle } from '@kinu.run/core/obs';
import {
  decodeJsonValue, JsonArraySchema, JsonValueSchema,
  QualityDaySchema, renderQualitySeries, SPEND_SOURCE_LABEL, usageTotal,
  type ProposerOutcome, type JsonObject, type JsonValue,
  type MissionBudgetLimits, type SearchNode, type Usage, type WorkspaceSpend,
  type AgentRpcMethod,
} from '@kinu.run/core';
import * as v from 'valibot';
import { resolveAgentTarget, type AgentTarget } from '../agent-target';
import { runLocalOptimization } from '../local-agent-client';
import { requireAuthConfig } from '../config';
import {
  ActivitySpendSchema, callAgentRpc, createCloudWebhookTrigger,
  type CloudWebhookTriggerInput,
} from '../cloud-api';
import { ACCENT, DIM, ERR, OK, plural, printJson, printSearchTree, renderAccountSpendLines, WARN } from '../display';
import { asRecord, normalizeWebhookAuthMode, parsePositiveInt, parseTime, stringField } from '../options';
import {
  executeLocalExecutor,
  getLocalAgentState,
  getLocalWorkspaceSpend,
  getLocalQuality,
  getLocalGepaRun,
  getLocalMctsNode,
  getLocalActorInfo,
  listLocalActors,
  listLocalEvents,
  listLocalExecutors,
  listLocalGepaRuns,
  listLocalHeads,
  listLocalMcts,
  listLocalTimeline,
  readLocalMemory,
  searchLocalMemory,
} from '../local-inspection';

interface InspectOpts {
  json?: boolean;
  limit?: string;
  variant?: string;
  since?: string;
}

interface GepaOpts extends InspectOpts {
  run?: boolean;
}

const ProposerOutcomeSchema: v.GenericSchema<ProposerOutcome> = v.variant('kind', [
  v.object({ kind: v.literal('idle') }),
  v.object({ kind: v.literal('searched'), artifactId: v.string(), version: v.nullable(v.number()), detail: v.string() }),
]);

const SearchNodeSchema: v.GenericSchema<SearchNode> = v.object({
  id: v.string(), parent_id: v.nullable(v.string()), root_id: v.string(),
  task: v.string(), action: v.string(), observation: v.string(),
  visits: v.number(), value: v.number(), depth: v.number(),
  status: v.picklist(['open', 'terminal', 'failed', 'pruned']),
  created_at: v.number(),
});

const ExecutorOutputSchema = v.object({
  stdout: v.optional(v.string()), stderr: v.optional(v.string()), exitCode: v.optional(v.number()), error: v.optional(v.string()),
});

export async function stopCommand(name: string, opts: InspectOpts = {}): Promise<void> {
  const target = resolveAgentTarget(name);

  if (target.mode === 'cloud') {
    const auth = requireAuthConfig();

    const result = await callAgentRpc({
      origin: auth.origin,
      token: auth.token,
      name: target.cloudName,
      method: 'cancelCurrentWork',
      schema: JsonValueSchema,
    });

    if (opts.json) printJson(result);
    else console.log(`${OK('stopped')} ${target.name}`);

    return;
  }

  if (opts.json) {
    printJson({ ok: true, note: 'Foreground local turns can only be interrupted from their owning terminal session.' });

    return;
  }

  console.log(`${WARN('!')} A running local turn can only be stopped from its own terminal: press Ctrl+C there.`);
}

/**
 * Every actor in the workspace (retired ones flagged), and optionally one actor's activity.
 * Reads go through the directory row and `actor_id`, never a handle, so retired actors stay inspectable.
 * Local only: no deployment RPC returns the actor directory.
 */
// `async` only for `wrapAction`; both reads are synchronous.
export function actorsCommand(name: string, actorId?: string, opts: InspectOpts = {}): Promise<void> {
  return settle(Effect.gen(function* () {
    const target = resolveAgentTarget(name);

    if (target.mode === 'cloud') {
      return yield* Effect.die(new Error(
        'kinu actors reads the local workspace database directly; the deployment exposes no actor-directory RPC. '
        + 'Use the web workspace view for a cloud agent.',
      ));
    }

    if (actorId !== undefined) {
      const info = getLocalActorInfo(target.localName, actorId);

      if (!info) return yield* Effect.die(new Error(`No actor ${actorId} was ever issued in workspace ${target.name}.`));
      printData(decodeJsonValue({ value: info }), opts);

      return;
    }

    printData(decodeJsonValue({ value: listLocalActors(target.localName) }), opts);
  }));
}

export async function stateCommand(name: string, opts: InspectOpts = {}): Promise<void> {
  const target = resolveAgentTarget(name);

  const data = await readTarget(target, {
    cloud: (auth) => cloudRead(auth, target, 'getWorkspaceSnapshot'),
    local: async () => decodeJsonValue({ value: await getLocalAgentState(target.localName) }),
  });

  printData(data, opts);
}

/**
 * Whole-workspace spend by kind of work and by mission. No window: `workspaceSpend` sums the whole log,
 * and the cloud arm sends no `steps` because the deployment clamps it to a smaller bound.
 */
export async function spendCommand(name: string, opts: InspectOpts = {}): Promise<void> {
  const target = resolveAgentTarget(name);

  const spend = await readTarget<WorkspaceSpend>(target, {
    cloud: async (auth) => (await callAgentRpc({
      origin: auth.origin,
      token: auth.token,
      name: target.cloudName,
      method: 'getActivitySnapshot',
      schema: ActivitySpendSchema,
    })).spend,
    local: () => getLocalWorkspaceSpend(target.localName),
  });

  if (opts.json) {
    printJson(decodeJsonValue({ value: spend }));

    return;
  }

  printSpend(spend);
}

function capSuffix(limits: MissionBudgetLimits): string {
  if (limits.usd !== undefined) return ` / $${limits.usd.toFixed(2)}`;

  if (limits.tokens !== undefined) return ` / ${limits.tokens.toLocaleString()} tokens`;

  return '';
}

function printSpend(spend: WorkspaceSpend): void {
  const measured = usageTotal(spend.total.usage);
  console.log(`${ACCENT('Workspace spend')} ${DIM(`${plural(spend.coverage.calls, 'call')} · whole log`)}`);

  if (spend.coverage.calls === 0) {
    console.log(DIM('No model call has been attributed yet.'));

    return;
  }

  console.log(DIM('By producer'));

  for (const p of spend.producers) {
    console.log(`  ${ACCENT(SPEND_SOURCE_LABEL[p.source].padEnd(18))} ${spendCells(p.usage, p.usd, p.calls)}`);
  }

  console.log(`  ${ACCENT('Total'.padEnd(18))} ${spendCells(spend.total.usage, spend.total.usd, spend.total.calls)}`);

  if (spend.missions.length > 0) {
    // Never add the axes: a call sits in one producer row and in every mission label above it.
    console.log(DIM('By mission (a call appears under every label above it)'));

    for (const m of spend.missions) {
      const cap = capSuffix(m.limits);
      const state = m.exhausted ? ` ${ERR('spent')}` : '';
      console.log(`  ${ACCENT(m.label.padEnd(18))} ${m.spent.tokens.toLocaleString()} tokens  `
        + `$${m.spent.usd.toFixed(4)}${cap}  ${DIM(`${plural(m.calls, 'call')} · ${m.pricing.source}`)}${state}`);
    }
  }

  const [accountsHeading, ...accountLines] = renderAccountSpendLines(spend.accounts, Date.now());
  console.log(DIM(accountsHeading ?? ''));

  for (const line of accountLines) console.log(line);

  const reported = spend.coverage.reported;

  if (reported !== null) {
    console.log(DIM(`${(reported * 100).toFixed(reported === 1 ? 0 : 1)}% of ${spend.coverage.calls} known calls reported usage`
      + (spend.coverage.silent.length > 0
        ? `; nothing at all was measured from ${spend.coverage.silent.map((s) => SPEND_SOURCE_LABEL[s]).join(', ')}`
        : '')));
  }

  if (spend.offTurnShare !== null) {
    console.log(DIM(`${(spend.offTurnShare * 100).toFixed(1)}% of the ${(measured ?? 0).toLocaleString()} measured `
      + 'tokens went on work no turn of this agent ran'));
  }

  // In the same words as ActivitySurface `spendCaveat`.
  if (spend.total.unpricedCalls > 0) {
    console.log(DIM(`The dollar total is a floor: ${plural(spend.total.unpricedCalls, 'measured call')} carried no models.dev rate`));
  }
}

/** An absent count prints as an em dash, never 0. */
function spendCells(usage: Usage, usd: number | undefined, calls: number): string {
  const tokens = usageTotal(usage);

  return `${tokens === undefined ? DIM('unmeasured') : `${tokens.toLocaleString()} tokens`}  `
    + `${usd === undefined ? DIM('unpriced') : `$${usd.toFixed(4)}`}  ${DIM(plural(calls, 'call'))}`;
}

export async function memoryCommand(name: string, queryParts: string[] = [], opts: InspectOpts = {}): Promise<void> {
  const target = resolveAgentTarget(name);
  const query = queryParts.join(' ').trim();
  const limit = parseLimit(opts.limit, 10);

  const data = await readTarget(target, {
    cloud: async (auth) => query
      ? callAgentRpc({
        origin: auth.origin,
        token: auth.token,
        name: target.cloudName,
        method: 'searchMemoryHybrid',
        schema: JsonValueSchema,
        args: [query, limit],
      })
      : { content: await callAgentRpc({
        origin: auth.origin,
        token: auth.token,
        name: target.cloudName,
        method: 'getMemoryContent',
        schema: v.string(),
      }) },
    local: async () => query
      ? decodeJsonValue({ value: searchLocalMemory(target.localName, query, limit) })
      : { content: await readLocalMemory(target.localName) },
  });

  if (opts.json || query) {
    printData(data, opts);

    return;
  }

  const memory = v.safeParse(v.object({ content: v.string() }), data);
  const content = memory.success ? memory.output.content : '';
  console.log(content || DIM('(memory is empty)'));
}

export function eventsCommand(name: string, opts: InspectOpts = {}): Promise<void> {
  return settle(Effect.gen(function* () {
    const target = resolveAgentTarget(name);
    const limit = parseLimit(opts.limit, 50);
    const since = opts.since ? parseTime(opts.since, 'time') : undefined;
    const filter: JsonObject = { limit };

    if (opts.variant) filter.variant = opts.variant;

    if (since !== undefined) filter.since = since;

    const data = yield* Effect.promise(async () => readTarget(target, {
      cloud: (auth) => cloudRead(auth, target, 'listRecentEvents', [filter]),
      local: () => decodeJsonValue({ value: listLocalEvents(target.localName, { variant: opts.variant, since, limit }) }),
    }));

    yield* printRows(data, opts, formatEventRow);
  }));
}

export function timelineCommand(name: string, opts: InspectOpts = {}): Promise<void> {
  return settle(Effect.gen(function* () {
    const target = resolveAgentTarget(name);
    const limit = parseLimit(opts.limit, 100);

    const data = yield* Effect.promise(async () => readTarget(target, {
      cloud: (auth) => cloudRead(auth, target, 'getRunTimeline', [{ limit }]),
      local: () => listLocalTimeline(target.localName, limit),
    }));

    yield* printRows(data, opts, formatTimelineRow);
  }));
}

export async function swarmCommand(name: string, nodeId: string | undefined, opts: InspectOpts = {}): Promise<void> {
  const target = resolveAgentTarget(name);

  const data = await readTarget(target, {
    cloud: (auth) => nodeId
      ? cloudRead(auth, target, 'getMctsNodeDetail', [nodeId])
      : cloudRead(auth, target, 'getMctsTree'),
    local: () => decodeJsonValue({ value: nodeId ? getLocalMctsNode(target.localName, nodeId) : listLocalMcts(target.localName) }),
  });

  const tree = v.safeParse(v.array(SearchNodeSchema), data);

  if (!nodeId && !opts.json && tree.success) {
    printSearchTree(tree.output);

    return;
  }

  printData(data, opts);
}

export function headsCommand(name: string, opts: InspectOpts = {}): Promise<void> {
  return settle(Effect.gen(function* () {
    const target = resolveAgentTarget(name);
    const limit = parseLimit(opts.limit, 20);

    const data = yield* Effect.promise(async () => readTarget(target, {
      cloud: (auth) => cloudRead(auth, target, 'getHeadRuns', [limit]),
      local: () => decodeJsonValue({ value: listLocalHeads(target.localName, limit) }),
    }));

    yield* printRows(data, opts, (item) => formatRunRow(item, HEAD_RUN_ROW));
  }));
}

export function gepaCommand(name: string, runId: string | undefined, opts: GepaOpts = {}): Promise<void> {
  return settle(Effect.gen(function* () {
    const target = resolveAgentTarget(name);

    if (opts.run) return yield* Effect.promise(async () => runGepaPass(name, opts));
    const limit = parseLimit(opts.limit, 20);

    // One run is a record, so `printRows` keeps exactly one legal input shape.
    if (runId) {
      const detail = yield* Effect.promise(async () => readTarget(target, {
        cloud: (auth) => cloudRead(auth, target, 'getGepaRun', [runId]),
        local: () => decodeJsonValue({ value: getLocalGepaRun(target.localName, runId) }),
      }));

      printData(detail, opts);

      return;
    }

    const data = yield* Effect.promise(async () => readTarget(target, {
      cloud: (auth) => cloudRead(auth, target, 'getGepaRuns', [limit]),
      local: () => decodeJsonValue({ value: listLocalGepaRuns(target.localName, limit) }),
    }));

    yield* printRows(data, opts, (item) => formatRunRow(item, GEPA_RUN_ROW));
  }));
}

async function runGepaPass(name: string, opts: GepaOpts): Promise<void> {
  const target = resolveAgentTarget(name);

  const result = await readTarget(target, {
    cloud: (auth) => callAgentRpc({
      origin: auth.origin, token: auth.token, name: target.cloudName,
      method: 'runOptimization', schema: ProposerOutcomeSchema, args: [],
    }),
    local: () => runLocalOptimization(target.localName),
  });

  if (opts.json) return printJson(decodeJsonValue({ value: result }));

  if (result.kind === 'idle') {
    console.log(DIM('  nothing to search: no low-rated turns in the last 14 days'));

    return;
  }

  console.log(result.version === null
    ? `${WARN('no edit passed')} ${result.artifactId}: ${result.detail}`
    : `${OK('proposed')} ${result.artifactId} v${String(result.version)} (${result.detail}), waiting for your decision`);
}

export function executorsCommand(
  name: string,
  executor: string | undefined,
  commandParts: string[] = [],
  opts: InspectOpts = {},
): Promise<void> {
  return settle(Effect.gen(function* () {
    if (executor) {
      yield* runExecutorCommand(name, executor, commandParts, opts);

      return;
    }

    const target = resolveAgentTarget(name);

    const data = yield* Effect.promise(async () => readTarget(target, {
      cloud: (auth) => cloudRead(auth, target, 'getExecutors'),
      local: () => decodeJsonValue({ value: listLocalExecutors() }),
    }));

    yield* printRows(data, opts, formatExecutorRow);
  }));
}

function runExecutorCommand(name: string, executor: string, commandParts: string[] = [], opts: InspectOpts = {}): Effect.Effect<void> {
  return Effect.gen(function* () {
    const command = commandParts.join(' ').trim();

    if (!command) return yield* Effect.die(new Error('command required'));
    const target = resolveAgentTarget(name);

    const data = yield* Effect.promise(async () => readTarget(target, {
      cloud: (auth) => callAgentRpc({
        origin: auth.origin,
        token: auth.token,
        name: target.cloudName,
        method: 'executeInExecutor',
        schema: ExecutorOutputSchema,
        args: [executor, command],
      }),
      local: async () => v.parse(ExecutorOutputSchema, await executeLocalExecutor(target.localName, executor, command)),
    }));

    if (opts.json) {
      printJson(decodeJsonValue({ value: data }));

      return;
    }

    if (data.error) console.log(`${ERR('error')} ${data.error}`);

    if (data.stdout) process.stdout.write(data.stdout);

    if (data.stderr) process.stderr.write(data.stderr);

    if (data.exitCode !== undefined && data.exitCode !== 0) process.exitCode = data.exitCode;
  });
}

/** Satisfaction per day: the mean rating of the turns users answered, with its interval. */
export async function qualityCommand(name: string, opts: InspectOpts & { days?: string } = {}): Promise<void> {
  const target = resolveAgentTarget(name);
  const days = opts.days === undefined ? 30 : parsePositiveInt(opts.days, '--days');

  const data = await readTarget(target, {
    cloud: (auth) => callAgentRpc({
      origin: auth.origin,
      token: auth.token,
      name: target.cloudName,
      method: 'getQuality',
      args: [days],
      schema: v.array(QualityDaySchema),
    }),
    local: () => getLocalQuality(target.localName, days),
  });

  if (opts.json) {
    printJson(decodeJsonValue({ value: data }));

    return;
  }

  console.log(renderQualitySeries(data));
}

export function webhookCommand(name: string, label: string | undefined, opts: InspectOpts & {
  authMode?: string;
  secret?: string;
  contentType?: string;
  rateLimit?: string;
} = {}): Promise<void> {
  return settle(Effect.gen(function* () {
    if (!label) return yield* Effect.die(new Error('webhook label required'));
    const target = resolveAgentTarget(name);

    if (target.mode !== 'cloud') return yield* Effect.die(new Error('Webhook triggers require a cloud workspace.'));
    const auth = requireAuthConfig();
    const authMode = normalizeWebhookAuthMode(opts.authMode);

    const input: CloudWebhookTriggerInput = {
      label,
      auth_mode: authMode,
    };

    if (opts.secret) input.secret = opts.secret;

    if (opts.contentType) input.accepted_content_type = opts.contentType;

    if (opts.rateLimit) input.rate_limit_per_min = parsePositiveInt(opts.rateLimit, 'rate limit');
    const created = yield* Effect.promise(async () => createCloudWebhookTrigger(auth.origin, auth.token, target.cloudName, input));
    printData(decodeJsonValue({ value: created }), opts);
  }));
}

function cloudRead(
  auth: { origin: string; token: string }, target: AgentTarget, method: AgentRpcMethod, args: JsonValue[] = [],
): Promise<JsonValue> {
  return callAgentRpc({
    origin: auth.origin, token: auth.token, name: target.cloudName, method, schema: JsonValueSchema, args,
  });
}

async function readTarget<T>(target: { mode: 'cloud' | 'local' }, fns: {
  cloud(auth: { origin: string; token: string }): Promise<T> | T;
  local(): Promise<T> | T;
}): Promise<T> {
  if (target.mode === 'cloud') return fns.cloud(requireAuthConfig());

  return fns.local();
}

function parseLimit(value: string | undefined, fallback: number): number {
  if (!value) return fallback;

  return parsePositiveInt(value, 'limit');
}

function printData(data: JsonValue, opts: InspectOpts): void {
  if (opts.json) printJson(data);
  else printPretty(data);
}

/** Every producer answers a bare list of rows; any other shape is a backend/formatter mismatch and fails loudly. */
function printRows(data: JsonValue, opts: InspectOpts, format: (item: JsonValue) => string): Effect.Effect<void> {
  return Effect.gen(function* () {
    if (opts.json) {
      printJson(data);

      return;
    }

    const rows = v.safeParse(JsonArraySchema, data);

    if (!rows.success) {
      return yield* Effect.die(new Error('This read answered with something other than a list of rows; re-run with --json to see it.'));
    }

    if (rows.output.length === 0) {
      console.log(DIM('No records.'));

      return;
    }

    for (const item of rows.output) console.log(format(item));
  });
}

function printPretty(data: JsonValue): void {
  const text = v.safeParse(v.string(), data);

  if (text.success) console.log(text.output);
  else printJson(data);
}

function formatEventRow(item: JsonValue): string {
  const row = asRecord({ value: item }, 'value');

  return `${ACCENT(stringField(row, 'id') ?? 'event')} ${stringField(row, 'variant') ?? ''} ${DIM(stringField(row, 'ingress') ?? '')} ${formatDate(row.received_at ?? row.receivedAt)}`;
}

function formatTimelineRow(item: JsonValue): string {
  const row = asRecord({ value: item }, 'value');
  const label = stringField(row, 'label') ?? stringField(row, 'message') ?? stringField(row, 'kind') ?? stringField(row, 'id') ?? 'entry';

  return `${formatDate(row.ts ?? row.received_at ?? row.created_at)} ${ACCENT(stringField(row, 'kind') ?? stringField(row, 'type') ?? 'event')} ${DIM(label.slice(0, 120))}`;
}

/** Head runs and GEPA runs render the same row under different field names. */
interface RunRowFields {
  readonly id: string;
  readonly fallbackId: string;
  readonly purpose: readonly [string, string];
}

const HEAD_RUN_ROW: RunRowFields = { id: 'rootId', fallbackId: 'head', purpose: ['task', 'rationale'] };

const GEPA_RUN_ROW: RunRowFields = { id: 'runId', fallbackId: 'gepa', purpose: ['target', 'stopReason'] };

function formatRunRow(item: JsonValue, fields: RunRowFields): string {
  const row = asRecord({ value: item }, 'value');
  const id = stringField(row, fields.id) ?? stringField(row, 'id') ?? fields.fallbackId;
  const purpose = stringField(row, fields.purpose[0]) ?? stringField(row, fields.purpose[1]) ?? '';

  return `${ACCENT(id)} ${stringField(row, 'status') ?? ''} ${DIM(purpose.slice(0, 100))}`;
}

function formatExecutorRow(item: JsonValue): string {
  const row = asRecord({ value: item }, 'value');
  const capabilities = v.safeParse(v.array(v.string()), row.capabilities);
  const caps = capabilities.success ? capabilities.output.join(', ') : '';

  return `${ACCENT(stringField(row, 'name') ?? stringField(row, 'id') ?? 'executor')} ${DIM(stringField(row, 'kind') ?? '')} ${stringField(row, 'status') ?? ''} ${DIM(caps)}`;
}

function formatDate(value: JsonValue | undefined): string {
  const parsed = v.safeParse(v.pipe(v.number(), v.finite()), value);

  return parsed.success ? DIM(new Date(parsed.output).toLocaleString()) : DIM('');
}
