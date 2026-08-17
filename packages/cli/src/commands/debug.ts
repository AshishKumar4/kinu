/**
 * `proteus debug <name>` — the debugging control plane.
 *
 * The gap this closes: every datum a real investigation needs already has a
 * read model (getWorkspaceSnapshot, getRunTimeline, the run_events ledger,
 * getHeadRuns, getMctsTree, listBackgroundJobs, getActivitySnapshot, the
 * Evolution Changelog, scaffold lineage, crafted tools, memory, facts,
 * triggers) — but no single command assembles them, and two of the richest
 * ones (raw per-run `run_events` — the tool-call args/results, context
 * budget, steering, file-edit and head-merge telemetry — and the MCTS
 * search-run ledger) had NO remotely reachable read path for a cloud
 * workspace at all before this file. See rpc-gate.ts (`getRunEvents`,
 * `listRuns`, `getMctsSearchRuns`) and orchestrator.ts (`getMctsTree` now
 * carries `root_id`) for the RPCs this command needed and that did not
 * already exist.
 *
 * `proteus export` already gives a complete, portable, byte-for-byte dump of
 * a workspace (every table, schema + rows) — the right tool for backup and
 * restore. This is deliberately NOT another one: it does not touch the raw
 * archive at all, and instead calls the assembled READ MODELS the rest of
 * the CLI and the web UI already use, decodes them into one ordered,
 * human- or machine-readable narrative, and redacts anything credential-
 * shaped on the way out. Byte-complete and human-assembled are different
 * jobs; this is the second one, extending the inventory rather than
 * duplicating the first.
 *
 * One dispatch shape for both backends: `DebugSource` is the seam (mirrors
 * inspect.ts's `readTarget`, generalized to many calls instead of one) —
 * `cloudDebugSource` calls RPCs, `localDebugSource` reads the workspace's own
 * SQLite directly. `debugCommand` is the ONLY place that knows how to walk a
 * source, redact, page, and render; it does not know or care which backend
 * produced the source.
 */

import { appendFileSync } from 'node:fs';
import { writeSecretFile } from '@proteus/cli-backend';
import {
  addUsage, decodeJsonValue, JsonObjectSchema, JsonValueSchema, projectJsonValue,
  usageReported, UsageSchema,
  type JsonObject, type JsonValue, type Usage,
} from '@proteus/core';
import * as v from 'valibot';
import { resolveAgentTarget } from '../agent-target.js';
import { requireAuthConfig } from '../config.js';
import { callAgentRpc } from '../cloud-api.js';
import { ACCENT, DIM, ERR, OK, WARN } from '../display.js';
import {
  getLocalAgentInfo, getLocalChangelog, getLocalChatHistory, getLocalFacts,
  getLocalScaffoldVersions, listLocalGepaRuns, listLocalHeads, listLocalJobs,
  listLocalMcts, listLocalMctsSearchRuns, listLocalRunEvents, listLocalRuns,
  listLocalTriggers, readLocalMemory, getLocalReleaseBoard, getLocalToolSurface,
} from '../local-inspection.js';

export interface DebugOpts {
  json?: boolean;
  out?: string;
  runs?: string;
  limit?: string;
}

/** A single search's raw nodes, as `getMctsTree`/`listLocalMcts` return
 *  them — root_id may be null on legacy rows written before the column
 *  existed (see mcts/schemas.ts), which is why grouping keys on it verbatim
 *  rather than assuming every row belongs to a known search. */
interface RawMctsNode extends JsonObject {
  id: string; parent_id: string | null; root_id: string | null; depth: number;
  visits: number; value: number; status: string; action: string; created_at: number;
}

interface DebugRun extends JsonObject {
  runId: string;
}

/** One ledger event as a bundle row. `usage` is a domain value rather than a
 *  plain JSON object, so it is projected here — the one place the bundle's
 *  JSON boundary is crossed. Absent stays absent: no key is written for a turn
 *  whose provider reported nothing. */
function runEventRecord(event: DebugRunEvent): BundleRecord {
  const { usage, ...rest } = event;
  const record: BundleRecord = { t: 'run_event', ...rest };
  if (usage !== undefined) record.usage = projectJsonValue({ value: usage });
  return record;
}

interface DebugRunEvent {
  eventIndex: number;
  runId: string;
  type: string;
  timestamp: string;
  caused_by?: string;
  userMessage?: string;
  name?: string;
  args?: JsonValue;
  result?: JsonValue;
  error?: string;
  message?: string;
  usage?: Usage;
  reason?: string;
}

interface DebugHead extends JsonObject {
  status: string;
}

interface DebugHeadRun extends JsonObject {
  rootId: string;
  task: string;
  status: string;
  spawnedAt: number;
  heads: DebugHead[];
}

interface DebugMctsSearchRun extends JsonObject {
  rootId: string;
  task: string;
  status: string;
  iteration: number;
  budget: number;
  updatedAt: number;
}

interface DebugBackgroundJob extends JsonObject {
  id: string;
  kind: string;
  label: string | null;
  status: string;
  error: string | null;
  createdAt: number;
  settledAt: number | null;
}

interface DebugChangelogView {
  entries: JsonObject[];
  unseenCount: number;
  seenAt?: number;
}

const JsonRowsSchema = v.array(JsonObjectSchema);
const DebugRunSchema: v.GenericSchema<DebugRun> = v.objectWithRest({ runId: v.string() }, JsonValueSchema);
const DebugRunEventSchema: v.GenericSchema<DebugRunEvent> = v.objectWithRest({
  eventIndex: v.number(), runId: v.string(), type: v.string(), timestamp: v.string(),
  caused_by: v.optional(v.string()), userMessage: v.optional(v.string()), name: v.optional(v.string()),
  args: v.optional(JsonValueSchema), result: v.optional(JsonValueSchema), error: v.optional(v.string()),
  message: v.optional(v.string()),
  usage: v.optional(UsageSchema),
  reason: v.optional(v.string()),
}, JsonValueSchema);
const DebugHeadSchema: v.GenericSchema<DebugHead> = v.objectWithRest({ status: v.string() }, JsonValueSchema);
const DebugHeadRunSchema: v.GenericSchema<DebugHeadRun> = v.objectWithRest({
  rootId: v.string(), task: v.string(), status: v.string(), spawnedAt: v.number(), heads: v.array(DebugHeadSchema),
}, JsonValueSchema);
const DebugMctsSearchRunSchema: v.GenericSchema<DebugMctsSearchRun> = v.objectWithRest({
  rootId: v.string(), task: v.string(), status: v.string(), iteration: v.number(), budget: v.number(), updatedAt: v.number(),
}, JsonValueSchema);
const RawMctsNodeSchema: v.GenericSchema<RawMctsNode> = v.objectWithRest({
  id: v.string(), parent_id: v.nullable(v.string()), root_id: v.nullable(v.string()), depth: v.number(),
  visits: v.number(), value: v.number(), status: v.string(), action: v.string(), created_at: v.number(),
}, JsonValueSchema);
const DebugBackgroundJobSchema: v.GenericSchema<DebugBackgroundJob> = v.objectWithRest({
  id: v.string(), kind: v.string(), label: v.nullable(v.string()), status: v.string(),
  error: v.nullable(v.string()), createdAt: v.number(), settledAt: v.nullable(v.number()),
}, JsonValueSchema);
const DebugChangelogViewSchema: v.GenericSchema<DebugChangelogView> = v.object({
  entries: JsonRowsSchema, unseenCount: v.number(), seenAt: v.optional(v.number()),
});
const WorkspaceSnapshotSchema = v.object({ status: JsonObjectSchema });

/** The one fetch surface `writeBundle` walks — implemented once per backend,
 *  never duplicated by the writer itself. Every method already exists as a
 *  read model somewhere in the codebase; this interface just names the width
 *  a full debug bundle needs from it. */
interface DebugSource {
  identity(): Promise<JsonObject>;
  messages(limit: number): Promise<JsonObject[]>;
  runs(limit: number): Promise<DebugRun[]>;
  runEvents(runId: string, since: number, limit: number): Promise<DebugRunEvent[]>;
  headRuns(limit: number): Promise<DebugHeadRun[]>;
  mctsSearchRuns(limit: number): Promise<DebugMctsSearchRun[]>;
  mctsNodes(): Promise<RawMctsNode[]>;
  backgroundJobs(limit: number): Promise<DebugBackgroundJob[]>;
  changelog(limit: number): Promise<DebugChangelogView>;
  scaffoldVersions(limit: number): Promise<JsonObject[]>;
  gepaRuns(limit: number): Promise<JsonObject[]>;
  releaseBoard(limit: number): Promise<JsonValue>;
  triggers(): Promise<JsonValue>;
  toolDescriptions(): Promise<JsonValue>;
  facts(limit: number): Promise<JsonObject[]>;
  memoryContent(): Promise<string>;
  /** Best-effort telemetry rollup (percentiles, remaining budgets, the
   *  activity log). Cloud-only today — `getActivitySnapshot` has no local
   *  peer; local sources return null and the section is omitted rather than
   *  faked. `run_events`' own `context_budget`/`turn_steering` rows (fetched
   *  per-run above) carry the same telemetry at full fidelity either way. */
  activitySnapshot(): Promise<JsonObject | null>;
}

function cloudDebugSource(cloudName: string, auth: { origin: string; token: string }): DebugSource {
  const rpc = <T>(method: string, schema: v.GenericSchema<T>, args: JsonValue[] = []) =>
    callAgentRpc(auth.origin, auth.token, cloudName, method, schema, args);
  return {
    identity: () => rpc('getWorkspaceSnapshot', WorkspaceSnapshotSchema).then((snapshot) => snapshot.status),
    messages: (limit) => rpc('getChatHistory', JsonRowsSchema, [limit]),
    runs: (limit) => rpc('listRuns', v.array(DebugRunSchema), [limit]),
    runEvents: (runId, since, limit) => rpc('getRunEvents', v.array(DebugRunEventSchema), [runId, { since, limit }]),
    headRuns: (limit) => rpc('getHeadRuns', v.array(DebugHeadRunSchema), [limit]),
    mctsSearchRuns: (limit) => rpc('getMctsSearchRuns', v.array(DebugMctsSearchRunSchema), [limit]),
    mctsNodes: () => rpc('getMctsTree', v.array(RawMctsNodeSchema)),
    backgroundJobs: (limit) => rpc('listBackgroundJobs', v.array(DebugBackgroundJobSchema), [limit]),
    changelog: (limit) => rpc('getEvolutionChangelog', DebugChangelogViewSchema, [{ limit }]),
    scaffoldVersions: (limit) => rpc('listScaffoldVersions', JsonRowsSchema, [limit]),
    gepaRuns: (limit) => rpc('getGepaRuns', JsonRowsSchema, [limit]),
    releaseBoard: (limit) => rpc('getReleaseBoard', JsonValueSchema, [limit]),
    triggers: () => rpc('listTriggers', JsonValueSchema),
    toolDescriptions: () => rpc('getToolDescriptions', JsonValueSchema),
    facts: (limit) => rpc('getFacts', JsonRowsSchema, [limit]),
    memoryContent: () => rpc('getMemoryContent', v.string()),
    activitySnapshot: () => rpc('getActivitySnapshot', v.nullable(JsonObjectSchema), [{}]),
  };
}

function localDebugSource(localName: string): DebugSource {
  return {
    identity: async () => parseLocal(JsonObjectSchema, { value: getLocalAgentInfo(localName) }),
    messages: async (limit) => parseLocal(JsonRowsSchema, { value: getLocalChatHistory(localName, limit) }),
    runs: async (limit) => parseLocal(v.array(DebugRunSchema), { value: listLocalRuns(localName, limit) }),
    runEvents: async (runId, since, limit) => parseLocal(
      v.array(DebugRunEventSchema), { value: listLocalRunEvents(localName, runId, { since, limit }) },
    ),
    headRuns: async (limit) => parseLocal(v.array(DebugHeadRunSchema), { value: listLocalHeads(localName, limit) }),
    mctsSearchRuns: async (limit) => parseLocal(
      v.array(DebugMctsSearchRunSchema), { value: listLocalMctsSearchRuns(localName, limit) },
    ),
    mctsNodes: async () => parseLocal(v.array(RawMctsNodeSchema), { value: listLocalMcts(localName) }),
    backgroundJobs: async (limit) => parseLocal(v.array(DebugBackgroundJobSchema), { value: listLocalJobs(localName, limit) }),
    changelog: async (limit) => parseLocal(DebugChangelogViewSchema, { value: getLocalChangelog(localName, limit) }),
    scaffoldVersions: async (limit) => parseLocal(JsonRowsSchema, { value: getLocalScaffoldVersions(localName, limit) }),
    gepaRuns: async (limit) => parseLocal(JsonRowsSchema, { value: listLocalGepaRuns(localName, limit) }),
    releaseBoard: async (limit) => decodeJsonValue({ value: getLocalReleaseBoard(localName, limit) }),
    triggers: async () => decodeJsonValue({ value: listLocalTriggers(localName) }),
    toolDescriptions: async () => decodeJsonValue({ value: getLocalToolSurface(localName) }),
    facts: async (limit) => parseLocal(JsonRowsSchema, { value: getLocalFacts(localName, limit) }),
    memoryContent: async () => readLocalMemory(localName),
    activitySnapshot: async () => null,
  };
}

function parseLocal<T>(schema: v.GenericSchema<T>, input: { value: unknown }): T {
  return v.parse(schema, decodeJsonValue(input));
}

// ── Redaction ────────────────────────────────────────────────────

/** Proteus's own bearer-token shapes (pta_ access, ptc_ session, pdt_
 *  device — cli/access-token-store.ts, auth-store.ts, user-do.ts) plus the
 *  common provider-key and generic key=secret shapes. One function, applied
 *  to every string leaf written into the bundle — not a per-table allowlist,
 *  because a secret can land in free text (a tool result, a pasted token in
 *  chat) that no schema marks as sensitive. */
const SECRET_PATTERNS: RegExp[] = [
  /\bpt[a-z]_[A-Za-z0-9_-]{16,}\b/g, // Proteus session/access/device tokens
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, // Anthropic
  /\bsk-[A-Za-z0-9]{20,}\b/g, // OpenAI-shaped
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bBearer\s+[A-Za-z0-9._-]{15,}\b/gi,
  /("(?:token|secret|password|api[_-]?key|credential|access[_-]?token|refresh[_-]?token)"\s*:\s*")[^"]{4,}(")/gi,
];

export function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) {
    out = pattern.source.includes('token|secret')
      ? out.replace(pattern, '$1[REDACTED]$2')
      : out.replace(pattern, '[REDACTED]');
  }
  return out;
}

/** Deep-walk a value, redacting every string leaf. Applied once, at the
 *  serialization boundary, so no fetch path can forget it. */
function redactDeep(value: JsonValue): JsonValue {
  const string = v.safeParse(v.string(), value);
  if (string.success) return redactSecrets(string.output);
  const array = v.safeParse(v.array(JsonValueSchema), value);
  if (array.success) return array.output.map(redactDeep);
  const object = v.safeParse(JsonObjectSchema, value);
  if (!object.success) return value;
  const redacted: JsonObject = {};
  for (const [key, child] of Object.entries(object.output)) redacted[key] = redactDeep(child);
  return redacted;
}

// ── Bundle records ──────────────────────────────────────────────

interface BundleRecord extends JsonObject {
  t: string;
}

interface BundleWriter {
  write(record: BundleRecord): void;
  close(): void;
}

/** Appends NDJSON to `path`, one record at a time — never holds the bundle
 *  in memory, matching the append-per-page pattern `proteus export` uses.
 *  Owner-only permissions: the bundle carries chat transcripts, tool-call
 *  results and memory content, redacted for known secret shapes but not
 *  guaranteed secret-free (see redactSecrets) — it should not default to
 *  the umask's usual group/world-readable file. */
function fileWriter(path: string): BundleWriter {
  writeSecretFile(path, '');
  let buffered: string[] = [];
  const flush = () => {
    if (buffered.length === 0) return;
    appendFileSync(path, buffered.join(''));
    buffered = [];
  };
  return {
    write(record) {
      buffered.push(`${JSON.stringify(redactDeep(record))}\n`);
      if (buffered.length >= 200) flush();
    },
    close: flush,
  };
}

// ── Investigation summary ──────────────────────────────────────────

interface RunStats {
  runId: string;
  eventCount: number;
  toolCalls: number;
  errors: string[];
  causedBy: string | null;
  userMessage: string | null;
  startedAt: number | null;
  endedAt: number | null;
  endReason: string | null;
  /** What the run's turns reported, absence preserved — a field no turn
   *  mentioned stays absent instead of reading as a metered zero. */
  usage: Usage;
  /** Turns whose provider reported nothing at all. The denominator that stops
   *  a silent run from reading as a free one. */
  turnsWithoutUsage: number;
  backgroundHandles: string[];
  jobPollsAfterHandle: number;
}

interface MctsSearchSummary {
  rootId: string;
  task: string;
  status: string;
  iteration: number;
  budget: number;
  updatedAt: number;
  nodeCount: number;
  maxDepth: number;
}

interface DebugSummary {
  identity: JsonObject;
  messageCount: number;
  runs: RunStats[];
  headRuns: DebugHeadRun[];
  mctsSearches: MctsSearchSummary[];
  backgroundJobs: DebugBackgroundJob[];
  changelogUnseen: number;
  scaffoldVersionCount: number;
  gepaRunCount: number;
  factCount: number;
  errors: Array<{ runId: string; message: string }>;
}

/** Fold one run's raw events into the stats a debugging read actually wants:
 *  who/what caused it, what it cost, and — the direct answer to "did the
 *  agent poll a background job instead of ending its turn" — every
 *  `agent.jobResult` tool call that happened AFTER this run's own events
 *  already contain a `background: true` handle for that job.
 *
 *  Both counters read `tool_call_end`, which is the row production writes. They
 *  were written against `tool_call_start` and no producer has ever emitted it,
 *  so `toolCalls` and `jobPollsAfterHandle` reported 0 on every run ever
 *  debugged — a silent zero in the surface whose job is to explain a run. The
 *  args are read before the result on each row so "after the handle" still
 *  means after: a row cannot be a poll of the handle it is itself announcing. */
function summarizeRun(runId: string, events: DebugRunEvent[]): RunStats {
  const stats: RunStats = {
    runId, eventCount: events.length, toolCalls: 0, errors: [], causedBy: null, userMessage: null,
    startedAt: null, endedAt: null, endReason: null, usage: {}, turnsWithoutUsage: 0,
    backgroundHandles: [], jobPollsAfterHandle: 0,
  };
  const handledJobIds = new Set<string>();
  for (const e of events) {
    const ts = Date.parse(e.timestamp) || null;
    if (e.type === 'run_start') {
      stats.causedBy = e.caused_by ?? 'chat';
      stats.userMessage = e.userMessage ?? null;
      stats.startedAt = ts;
    } else if (e.type === 'tool_call_end') {
      stats.toolCalls++;
      const args = v.safeParse(JsonObjectSchema, e.args);
      if (e.name === 'agent' && args.success && args.output.jobResult !== undefined) {
        if (handledJobIds.has(String(args.output.jobResult))) stats.jobPollsAfterHandle++;
      }
      const result = v.safeParse(JsonObjectSchema, e.result);
      const jobId = result.success ? v.safeParse(v.string(), result.output.jobId) : null;
      if (result.success && result.output.background === true && jobId?.success) {
        stats.backgroundHandles.push(jobId.output);
        handledJobIds.add(jobId.output);
      }
      if (e.error) stats.errors.push(`tool_call_end(${e.name ?? 'tool'}): ${e.error}`);
    } else if (e.type === 'error') {
      if (e.message) stats.errors.push(e.message);
    } else if (e.type === 'turn_end') {
      if (e.usage && usageReported(e.usage)) stats.usage = addUsage(stats.usage, e.usage);
      else stats.turnsWithoutUsage++;
    } else if (e.type === 'run_end') {
      stats.endedAt = ts;
      stats.endReason = e.reason ?? null;
      if (e.error) stats.errors.push(`run_end: ${e.error}`);
    }
  }
  return stats;
}

/** Group the flat, unscoped node list `getMctsTree` returns into one summary
 *  per root_id — the fix for the client bug in use-proteus.ts's `buildTree`,
 *  which picks whichever depth-0 node sorts first (oldest by created_at) and
 *  silently drops every node not reachable from it. Nodes with a null
 *  root_id (legacy rows) are grouped under the sentinel key so they are
 *  reported rather than dropped. */
function summarizeMctsSearches(nodes: RawMctsNode[], searches: DebugMctsSearchRun[]): MctsSearchSummary[] {
  const byRoot = new Map<string, RawMctsNode[]>();
  for (const n of nodes) {
    const key = n.root_id ?? '(legacy: no root_id)';
    const list = byRoot.get(key);
    if (list) list.push(n); else byRoot.set(key, [n]);
  }
  const bySearchMeta = new Map(searches.map((s) => [s.rootId, s]));
  const out: MctsSearchSummary[] = [];
  for (const [rootId, group] of byRoot) {
    const meta = bySearchMeta.get(rootId);
    out.push({
      rootId,
      task: meta?.task ?? group[0]?.action ?? '',
      status: meta?.status ?? '(no mcts_search_runs row)',
      iteration: meta?.iteration ?? 0,
      budget: meta?.budget ?? 0,
      updatedAt: meta?.updatedAt ?? Math.max(...group.map((n) => n.created_at)),
      nodeCount: group.length,
      maxDepth: Math.max(...group.map((n) => n.depth)),
    });
  }
  // Search runs with a ledger row but zero nodes (a search that began and
  // never wrote a single node) must still appear — a write-side failure is
  // exactly what a debugging read has to be able to see.
  for (const s of searches) {
    if (!byRoot.has(s.rootId)) {
      out.push({
        rootId: s.rootId, task: s.task, status: s.status, iteration: s.iteration,
        budget: s.budget, updatedAt: s.updatedAt, nodeCount: 0, maxDepth: 0,
      });
    }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

// ── The command ──────────────────────────────────────────────────

const DEFAULT_RUNS = 20;
const DEFAULT_EVENT_PAGE = 500;

export async function debugCommand(name: string, opts: DebugOpts = {}): Promise<void> {
  const target = resolveAgentTarget(name);
  const source = target.mode === 'cloud'
    ? cloudDebugSource(target.cloudName, requireAuthConfig())
    : localDebugSource(target.localName);

  const outPath = opts.out ?? `${target.name}.debug.jsonl`;
  const runLimit = opts.runs ? parsePositiveInt(opts.runs, 'runs') : DEFAULT_RUNS;
  const sectionLimit = opts.limit ? parsePositiveInt(opts.limit, 'limit') : 100;

  const writer = fileWriter(outPath);
  const summary: DebugSummary = {
    identity: {}, messageCount: 0, runs: [], headRuns: [], mctsSearches: [],
    backgroundJobs: [], changelogUnseen: 0, scaffoldVersionCount: 0, gepaRunCount: 0,
    factCount: 0, errors: [],
  };

  try {
    const identity = await safe(source.identity(), {});
    summary.identity = identity;
    writer.write({ t: 'identity', workspace: target.name, mode: target.mode, ...identity });

    const messages = await safe(source.messages(sectionLimit), []);
    summary.messageCount = messages.length;
    for (const m of messages) writer.write({ t: 'message', ...m });

    // Runs + their full event ledger — paginated per run via `since`, so a
    // run with thousands of events never sits fully in memory at once.
    const runs = await safe(source.runs(runLimit), []);
    for (const run of runs) {
      writer.write({ t: 'run', ...run });
      const events: DebugRunEvent[] = [];
      let since = 0;
      for (;;) {
        const page = await safe(source.runEvents(run.runId, since, DEFAULT_EVENT_PAGE), []);
        if (page.length === 0) break;
        for (const e of page) writer.write(runEventRecord(e));
        events.push(...page);
        if (page.length < DEFAULT_EVENT_PAGE) break;
        since = page[page.length - 1]!.eventIndex + 1;
      }
      const stats = summarizeRun(run.runId, events);
      summary.runs.push(stats);
      for (const message of stats.errors) summary.errors.push({ runId: run.runId, message });
    }

    const headRuns = await safe(source.headRuns(runLimit), []);
    summary.headRuns = headRuns;
    for (const run of headRuns) writer.write({ t: 'head_run', ...run });

    const [mctsSearches, mctsNodes] = await Promise.all([
      safe(source.mctsSearchRuns(runLimit), []),
      safe(source.mctsNodes(), []),
    ]);
    for (const s of mctsSearches) writer.write({ t: 'mcts_search_run', ...s });
    for (const n of mctsNodes) writer.write({ t: 'mcts_node', ...n });
    summary.mctsSearches = summarizeMctsSearches(mctsNodes, mctsSearches);

    const jobs = await safe(source.backgroundJobs(sectionLimit), []);
    summary.backgroundJobs = jobs;
    for (const j of jobs) writer.write({ t: 'background_job', ...j });

    const changelog = await safe(source.changelog(sectionLimit), { entries: [], unseenCount: 0, seenAt: 0 });
    summary.changelogUnseen = changelog.unseenCount;
    for (const entry of changelog.entries) writer.write({ t: 'changelog_entry', ...entry });

    const scaffoldVersions = await safe(source.scaffoldVersions(sectionLimit), []);
    summary.scaffoldVersionCount = scaffoldVersions.length;
    for (const v of scaffoldVersions) writer.write({ t: 'scaffold_version', ...v });

    const gepaRuns = await safe(source.gepaRuns(sectionLimit), []);
    summary.gepaRunCount = gepaRuns.length;
    for (const g of gepaRuns) writer.write({ t: 'gepa_run', ...g });

    const releaseBoard = await safe(source.releaseBoard(sectionLimit), null);
    if (releaseBoard) writer.write({ t: 'release_board', ...asRecord({ value: releaseBoard }) });

    const triggers = await safe(source.triggers(), null);
    if (triggers) writer.write({ t: 'triggers', ...asRecord({ value: triggers }) });

    const tools = await safe(source.toolDescriptions(), null);
    if (tools) writer.write({ t: 'tools', ...asRecord({ value: tools }) });

    const facts = await safe(source.facts(sectionLimit), []);
    summary.factCount = facts.length;
    for (const f of facts) writer.write({ t: 'fact', ...f });

    const memory = await safe(source.memoryContent(), '');
    if (memory) writer.write({ t: 'memory', content: memory });

    const activity = await safe(source.activitySnapshot(), null);
    if (activity) writer.write({ t: 'activity_snapshot', ...activity });

    writer.write({ t: 'end', workspace: target.name, mode: target.mode, generatedAt: Date.now() });
  } finally {
    writer.close();
  }

  if (opts.json) {
    printJsonSummary(summary, outPath);
  } else {
    printHumanSummary(target.name, target.mode, summary, outPath);
  }
}

async function safe<T>(p: Promise<T>, fallback: T): Promise<T> {
  try { return await p; } catch { return fallback; }
}

function asRecord(input: { value: JsonValue }): JsonObject {
  const parsed = v.safeParse(JsonObjectSchema, input.value);
  return parsed.success ? parsed.output : { value: input.value };
}

/** Human-readable elapsed duration ("45s", "12m", "3h 4m", "2d 1h") — the
 *  unit an operator reads at a glance, not raw milliseconds or a timestamp
 *  they have to subtract themselves. Negative/NaN inputs (a clock skew, a
 *  malformed row) render as "0s" rather than a confusing negative duration. */
function formatElapsed(ms: number): string {
  const totalSec = Math.max(0, Math.floor((Number.isFinite(ms) ? ms : 0) / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin < 60) return `${totalMin}m`;
  const totalHours = Math.floor(totalMin / 60);
  const remMin = totalMin % 60;
  if (totalHours < 24) return remMin > 0 ? `${totalHours}h ${remMin}m` : `${totalHours}h`;
  const days = Math.floor(totalHours / 24);
  const remHours = totalHours % 24;
  return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`;
}

function parsePositiveInt(value: string, label: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

function printJsonSummary(summary: DebugSummary, outPath: string): void {
  console.log(JSON.stringify(redactDeep(decodeJsonValue({ value: { bundle: outPath, ...summary } })), null, 2));
}

function stringField(record: JsonObject, key: string): string | undefined {
  const parsed = v.safeParse(v.string(), record[key]);
  return parsed.success ? parsed.output : undefined;
}

function numberField(record: JsonObject, key: string): number | undefined {
  const parsed = v.safeParse(v.number(), record[key]);
  return parsed.success ? parsed.output : undefined;
}

function printHumanSummary(name: string, mode: string, summary: DebugSummary, outPath: string): void {
  console.log(`\n${ACCENT(name)} ${DIM(`(${mode})`)} — bundle: ${DIM(outPath)}\n`);

  const displayName = stringField(summary.identity, 'displayName');
  const purpose = stringField(summary.identity, 'purpose');
  const scaffoldVersion = numberField(summary.identity, 'scaffoldVersion');
  const model = stringField(summary.identity, 'model');
  if (displayName || purpose) {
    console.log(`${DIM('identity')}  ${displayName ?? name} — ${DIM((purpose ?? '').slice(0, 80))}`);
    console.log(`${DIM('scaffold')}  v${scaffoldVersion ?? 0}  ${DIM(model ?? '')}`);
  }
  console.log(`${DIM('messages')} ${summary.messageCount}`);

  console.log(`\n${ACCENT('Runs')} (${summary.runs.length})`);
  for (const r of summary.runs.slice(0, 10)) {
    const when = r.startedAt ? new Date(r.startedAt).toLocaleString() : '?';
    const status = r.endReason ? OK(r.endReason) : r.endedAt ? OK('ended') : WARN('no run_end');
    const errTag = r.errors.length ? ERR(` ${r.errors.length} error(s)`) : '';
    const pollTag = r.jobPollsAfterHandle > 0 ? WARN(` polled job ${r.jobPollsAfterHandle}x after backgrounding`) : '';
    console.log(`  ${DIM(when)} ${ACCENT(r.runId.slice(0, 8))} ${r.causedBy ?? '?'} — ${r.eventCount} events, ${r.toolCalls} tool calls, ${status}${errTag}${pollTag}`);
  }

  if (summary.headRuns.length > 0) {
    console.log(`\n${ACCENT('Head/fork runs')} (${summary.headRuns.length}, newest first)`);
    for (const h of summary.headRuns.slice(0, 5)) {
      const done = h.heads.filter((head) => head.status !== 'running').length;
      const progressTag = h.status === 'running' ? ` (${done}/${h.heads.length} settled)` : '';
      console.log(`  ${DIM(new Date(h.spawnedAt).toLocaleString())} ${ACCENT(h.rootId.slice(0, 8))} ${h.status} — ${h.heads.length} head(s)${progressTag}: ${DIM(h.task.slice(0, 60))}`);
    }
  }

  if (summary.mctsSearches.length > 0) {
    console.log(`\n${ACCENT('MCTS searches')} (${summary.mctsSearches.length}, newest first)`);
    for (const s of summary.mctsSearches.slice(0, 5)) {
      const depthTag = s.nodeCount <= 1 ? WARN('single node, no depth') : `${s.nodeCount} nodes, depth ${s.maxDepth}`;
      // `s.budget` is REMAINING budget (mcts/search-store.ts checkpoints it down
      // every iteration) — iteration + budget is the search's true total, an
      // invariant held by construction (mcts/engine.ts increments one and
      // decrements the other together). Showing iter=N/budget as a fraction
      // reads as an overrun (34/26) when it is really "34 of 60 done, 26 left".
      const total = s.iteration + s.budget;
      // `updatedAt` is written by the SAME per-iteration checkpoint — the one
      // heartbeat this backend actually has. For a still-running search this
      // is the direct answer to "is it hung or working": fresh means it
      // checkpointed recently; stale means nothing has landed in a while.
      const heartbeat = s.status === 'running' ? ` — checkpointed ${formatElapsed(Date.now() - s.updatedAt)} ago` : '';
      console.log(`  ${DIM(new Date(s.updatedAt).toLocaleString())} ${ACCENT(s.rootId.slice(0, 8))} ${s.status} iter=${s.iteration}/${total} (${s.budget} left) — ${depthTag}${heartbeat}`);
    }
    if (summary.mctsSearches.length > 1) {
      const [latest, previous] = summary.mctsSearches;
      console.log(DIM(`  latest vs previous: ${latest!.nodeCount} vs ${previous!.nodeCount} nodes, depth ${latest!.maxDepth} vs ${previous!.maxDepth}`));
    }
  }

  if (summary.backgroundJobs.length > 0) {
    console.log(`\n${ACCENT('Background jobs')} (${summary.backgroundJobs.length})`);
    for (const j of summary.backgroundJobs.slice(0, 10)) {
      const labelTag = j.label ? ` — ${DIM(j.label)}` : '';
      // Running jobs carry no heartbeat of their own (background_jobs has only
      // created_at/settled_at) — this is the honest answer to "how long has
      // this actually been running", computed rather than left for the
      // operator to do the timestamp math that hid the 12-hour job.
      const durationTag = j.status === 'running'
        ? WARN(` — running ${formatElapsed(Date.now() - j.createdAt)}`)
        : j.settledAt ? ` — took ${formatElapsed(j.settledAt - j.createdAt)}` : '';
      console.log(`  ${DIM(new Date(j.createdAt ?? 0).toLocaleString())} ${ACCENT(j.id.slice(0, 8))} ${j.kind} ${j.status}${durationTag}${labelTag}${j.error ? ERR(` — ${j.error}`) : ''}`);
    }
  }

  console.log(`\n${DIM(`evolution: ${summary.changelogUnseen} unseen changelog entries, ${summary.scaffoldVersionCount} scaffold version(s), ${summary.gepaRunCount} GEPA run(s), ${summary.factCount} fact(s)`)}`);

  if (summary.errors.length > 0) {
    console.log(`\n${ERR('Errors')} (${summary.errors.length})`);
    for (const e of summary.errors.slice(0, 20)) console.log(`  ${DIM(e.runId.slice(0, 8))} ${e.message.slice(0, 140)}`);
  }
  console.log('');
}
