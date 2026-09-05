/**
 * `kinu debug <name>` — the debugging control plane.
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
 * `kinu export` already gives a complete, portable, byte-for-byte dump of
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
import { writeSecretFile } from '@kinu.run/cli-backend';
import { renderThrownChain } from '@kinu.run/core/obs';
import {
  addUsage, decodeJsonValue, JsonObjectSchema, JsonValueSchema, pageSchema, projectJsonValue,
  usageReported, UsageSchema,
  type ExplorationRecord, type JsonObject, type JsonValue, type Page,
  type RecordCellHandle, type RecordCellSummary, type RecordObjectiveHandle,
  type RecordObjectiveSummary, type SeekCursor, type Usage,
} from '@kinu.run/core';
import * as v from 'valibot';
import { resolveAgentTarget } from '../agent-target';
import { requireAuthConfig } from '../config';
import { callAgentRpc } from '../cloud-api';
import { ACCENT, DIM, ERR, OK, printJson, WARN } from '../display';
import { asRecord, numberField, parsePositiveInt, stringField } from '../options';
import {
  getLocalAgentInfo, getLocalChangelog, getLocalChatHistory, getLocalFacts,
  getLocalScaffoldVersions, listLocalGepaRuns, listLocalHeads, listLocalJobs,
  listLocalMcts, listLocalMctsSearchRuns, listLocalRecordCells, listLocalRecordObjectives,
  listLocalRunEvents, listLocalRuns, listLocalTriggers, readLocalMemory, readLocalRecordCell,
  getLocalReleaseBoard, getLocalToolSurface,
} from '../local-inspection';

export interface DebugOpts {
  json?: boolean;
  out?: string;
  runs?: string;
  limit?: string;
}

/** A single search's raw nodes, as `getMctsTree`/`listLocalMcts` return
 *  them — grouped by run rather than assumed to belong to one known search. */
interface RawMctsNode extends JsonObject {
  id: string; parent_id: string | null; root_id: string; depth: number;
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

/**
 * One comparable set as a bundle row. Projected field by field rather than
 * spread, so what the bundle carries is a decision here rather than whatever the
 * summary happens to hold — and `best` becomes its artifact digest, because the
 * best row is itself written as a `record` below and a nested copy would be a
 * second version of it that could disagree.
 */
function recordObjectiveRecord(objective: RecordObjectiveSummary): BundleRecord {
  return {
    t: 'record_objective',
    objectiveId: objective.objectiveId,
    floorDigest: objective.floorDigest,
    metric: objective.metric,
    unit: objective.unit,
    direction: objective.direction,
    scale: objective.scale,
    cells: objective.cells,
    rows: objective.rows,
    best: objective.best?.artifactDigest ?? null,
    bestValue: objective.best?.value ?? null,
    lastRecordedAt: objective.lastRecordedAt,
  };
}

/** One leaderboard row. `value` is RAW in the objective's unit — the
 *  `record_objective` row above carries that unit and the direction it is read
 *  in, which is what stops a reader taking a delta for a level. */
function explorationRecordRecord(record: ExplorationRecord): BundleRecord {
  return {
    t: 'record',
    objectiveId: record.objectiveId,
    floorDigest: record.floorDigest,
    descriptor: record.descriptor,
    artifactDigest: record.artifactDigest,
    artifact: record.artifact,
    value: record.value,
    detail: record.detail,
    measured: record.measured === null ? null : { ...record.measured },
    preset: record.preset,
    label: record.label,
    rootId: record.rootId,
    configDigest: record.configDigest,
    depth: record.depth,
    branches: record.branches,
    floorValue: record.floorValue,
    floorProof: record.floorProof,
    costUsd: record.costUsd,
    costTokens: record.costTokens,
    firstRecordedAt: record.firstRecordedAt,
    displacements: record.displacements,
  };
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
  id: v.string(), parent_id: v.nullable(v.string()), root_id: v.string(), depth: v.number(),
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

/**
 * The exploration LEADERBOARD's three reads, typed against core's own summaries
 * rather than re-declared.
 *
 * `v.GenericSchema<RecordObjectiveSummary>` is the point: this is a parse at the
 * CLI's wire boundary, and annotating it with core's type means the schema
 * cannot drift from what the read model returns — it stops compiling instead.
 * The two nullable keys are `v.nullable`, never optional: `floorDigest: null` is
 * "declared no floor" and `descriptor: null` is "no descriptor partition", and an
 * absent field would be a third meaning neither read has.
 */
const ExplorationRecordSchema: v.GenericSchema<ExplorationRecord> = v.object({
  objectiveId: v.string(), descriptor: v.nullable(v.string()), artifactDigest: v.string(),
  artifact: v.string(), value: v.number(), detail: v.string(),
  measured: v.nullable(v.record(v.string(), v.number())),
  preset: v.string(), label: v.nullable(v.string()), rootId: v.string(),
  configDigest: v.string(), depth: v.number(), branches: v.number(),
  floorDigest: v.nullable(v.string()), floorValue: v.nullable(v.number()),
  floorProof: v.nullable(v.string()), costUsd: v.nullable(v.number()),
  costTokens: v.nullable(v.number()), firstRecordedAt: v.number(), displacements: v.number(),
});
const RecordObjectiveSummarySchema: v.GenericSchema<RecordObjectiveSummary> = v.object({
  objectiveId: v.string(), floorDigest: v.nullable(v.string()), metric: v.string(),
  unit: v.string(), direction: v.picklist(['minimise', 'maximise']),
  scale: v.picklist(['linear', 'log']), cells: v.number(), rows: v.number(),
  best: v.nullable(ExplorationRecordSchema), lastRecordedAt: v.number(),
});
const RecordCellSummarySchema: v.GenericSchema<RecordCellSummary> = v.object({
  descriptor: v.nullable(v.string()), occupants: v.number(),
  elite: v.nullable(ExplorationRecordSchema),
});

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
  /**
   * The records store — the CUMULATIVE half of exploration, and the one read
   * model a debug bundle had no path to on either backend.
   *
   * Three calls rather than one because the store is a grid the caller walks:
   * which comparable sets exist, which cells each spans, and then a cell's
   * population A PAGE AT A TIME. That last one is not a style choice — a cell's
   * population is provably unbounded (`ArchiveAdmission.lean —
   * separated_cells_are_unboundedly_large`), so a bundle that read a cell whole
   * would hold an unbounded set in memory to write it out row by row.
   */
  recordObjectives(limit: number): Promise<RecordObjectiveSummary[]>;
  recordCells(handle: RecordObjectiveHandle, limit: number): Promise<RecordCellSummary[]>;
  recordOccupants(
    handle: RecordCellHandle, cursor: SeekCursor | null, limit: number,
  ): Promise<Page<ExplorationRecord>>;
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
    messages: (limit) => rpc('getChatHistoryPage', v.object({ items: JsonRowsSchema }), [{ limit }])
      .then((page) => page.items),
    // listRuns moved to Page<RunListEntry> + PageRequest; the old positional
    // [limit] parsed as a request object whose fields are all absent, and the
    // array schema then refused the page envelope — every bundle read "Runs (0)"
    // until section failures became visible.
    runs: (limit) => rpc('listRuns', pageSchema(DebugRunSchema), [{ limit }]).then((page) => [...page.items]),
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
    recordObjectives: (limit) =>
      rpc('listRecordObjectives', pageSchema(RecordObjectiveSummarySchema), [{ limit }])
        .then((page) => [...page.items]),
    // Each request is built field by field rather than spread: the handles cross a
    // JSON boundary, `SeekCursor` is a domain type with no index signature, and a
    // spread of a whole summary would put a leaderboard row in a request. `cursor`
    // is absent rather than null for the first page — that is what the request's
    // optional field means.
    recordCells: (handle, limit) =>
      rpc('listRecordCells', pageSchema(RecordCellSummarySchema),
        [{ objectiveId: handle.objectiveId, floorDigest: handle.floorDigest, limit }])
        .then((page) => [...page.items]),
    recordOccupants: (handle, cursor, limit) => {
      const request: JsonObject = {
        objectiveId: handle.objectiveId, floorDigest: handle.floorDigest,
        descriptor: handle.descriptor, limit,
      };
      // ABSENT, not `undefined`: JSON has no undefined, and the request's optional
      // `cursor` means "start at the beginning" by not being there.
      if (cursor !== null) request.cursor = { after: cursor.after };
      return rpc('readRecordCell', pageSchema(ExplorationRecordSchema), [request]);
    },
    activitySnapshot: () => rpc('getActivitySnapshot', v.nullable(JsonObjectSchema), [{}]),
  };
}

function localDebugSource(localName: string): DebugSource {
  return {
    identity: async () => parseLocal(JsonObjectSchema, { value: getLocalAgentInfo(localName) }),
    messages: async (limit) => parseLocal(JsonRowsSchema, { value: await getLocalChatHistory(localName, limit) }),
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
    recordObjectives: async (limit) => listLocalRecordObjectives(localName, limit),
    recordCells: async (handle, limit) => listLocalRecordCells(localName, handle, limit),
    recordOccupants: async (handle, cursor, limit) =>
      readLocalRecordCell(localName, handle, cursor, limit),
    activitySnapshot: async () => null,
  };
}

function parseLocal<T>(schema: v.GenericSchema<T>, input: { value: unknown }): T {
  return v.parse(schema, decodeJsonValue(input));
}

// ── Redaction ────────────────────────────────────────────────────

/** Kinu's own bearer-token shapes (pta_ access, ptc_ session, pdt_
 *  device — cli/access-token-store.ts, auth-store.ts, user-do.ts) plus the
 *  common provider-key and generic key=secret shapes. One function, applied
 *  to every string leaf written into the bundle — not a per-table allowlist,
 *  because a secret can land in free text (a tool result, a pasted token in
 *  chat) that no schema marks as sensitive. */
const SECRET_PATTERNS: RegExp[] = [
  /\bpt[a-z]_[A-Za-z0-9_-]{16,}\b/g, // Kinu session/access/device tokens
  /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, // Anthropic
  /\bsk-[A-Za-z0-9]{20,}\b/g, // OpenAI-shaped
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bBearer\s+[A-Za-z0-9._-]{15,}\b/gi,
];

/** Key/value patterns keep their two surrounding groups. They stand apart
 *  from SECRET_PATTERNS so the replacement shape is declared, not sniffed
 *  out of the pattern source. */
const SECRET_KEY_VALUE_PATTERNS: RegExp[] = [
  /("(?:token|secret|password|api[_-]?key|credential|access[_-]?token|refresh[_-]?token)"\s*:\s*")[^"]{4,}(")/gi,
];

function redactSecrets(text: string): string {
  let out = text;
  for (const pattern of SECRET_PATTERNS) out = out.replace(pattern, '[REDACTED]');
  for (const pattern of SECRET_KEY_VALUE_PATTERNS) out = out.replace(pattern, '$1[REDACTED]$2');
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
 *  in memory, matching the append-per-page pattern `kinu export` uses.
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
  recordObjectives: RecordObjectiveSummary[];
  backgroundJobs: DebugBackgroundJob[];
  changelogUnseen: number;
  scaffoldVersionCount: number;
  gepaRunCount: number;
  factCount: number;
  errors: Array<{ runId: string; message: string }>;
  sectionFailures: Array<{ section: string; message: string }>;
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
 *  per root_id — the fix for the client bug in use-kinu.ts's `buildTree`,
 *  which picks whichever depth-0 node sorts first (oldest by created_at) and
 *  silently drops every node not reachable from it. */
function summarizeMctsSearches(nodes: RawMctsNode[], searches: DebugMctsSearchRun[]): MctsSearchSummary[] {
  const byRoot = new Map<string, RawMctsNode[]>();
  for (const n of nodes) {
    const key = n.root_id;
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
const DEFAULT_RECORD_PAGE = 200;
/**
 * How many pages of ONE cell a bundle will walk.
 *
 * A bound rather than "until `end`", because the set being walked has no bound
 * of its own: `separated_cells_are_unboundedly_large` means a cell can hold more
 * occupants than a debug bundle should ever write, and a walk with no cap would
 * turn one pathological cell into an unbounded file. The cap TRUNCATES a cell and
 * says nothing false about it — the bundle is a sample of a store, and every
 * other section is limited the same way.
 *
 * Unrelated to `INHERITED_CONTEXT_CAP` (core orchestrator/heads-support.ts), which
 * happens to be the same round number: that one bounds how much context a head
 * inherits, this one bounds how much of one cell a debug bundle writes. Neither
 * decision constrains the other, so they are separate declarations on purpose.
 */
const RECORD_PAGE_CAP = 50;

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
    recordObjectives: [],
    factCount: 0, errors: [], sectionFailures: [],
  };

  /** A section that cannot be read is a FINDING, never an empty section — a
   *  bare catch-fallback here once read failing RPCs as empty workspaces. */
  const safe = async <T>(section: string, p: Promise<T>, fallback: T): Promise<T> => {
    try {
      return await p;
    } catch (caught) {
      const message = renderThrownChain({ cause: caught });
      summary.sectionFailures.push({ section, message });
      writer.write({ t: 'section_error', section, error: message });
      return fallback;
    }
  };

  try {
    const identity = await safe('identity', source.identity(), {});
    summary.identity = identity;
    writer.write({ t: 'identity', workspace: target.name, mode: target.mode, ...identity });

    const messages = await safe('messages', source.messages(sectionLimit), []);
    summary.messageCount = messages.length;
    for (const m of messages) writer.write({ t: 'message', ...m });

    // Runs + their full event ledger — paginated per run via `since`, so a
    // run with thousands of events never sits fully in memory at once.
    const runs = await safe('runs', source.runs(runLimit), []);
    for (const run of runs) {
      writer.write({ t: 'run', ...run });
      const events: DebugRunEvent[] = [];
      let since = 0;
      for (;;) {
        const page = await safe('run_events', source.runEvents(run.runId, since, DEFAULT_EVENT_PAGE), []);
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

    const headRuns = await safe('head_runs', source.headRuns(runLimit), []);
    summary.headRuns = headRuns;
    for (const run of headRuns) writer.write({ t: 'head_run', ...run });

    const [mctsSearches, mctsNodes] = await Promise.all([
      safe('mcts_search_runs', source.mctsSearchRuns(runLimit), []),
      safe('mcts_nodes', source.mctsNodes(), []),
    ]);
    for (const s of mctsSearches) writer.write({ t: 'mcts_search_run', ...s });
    for (const n of mctsNodes) writer.write({ t: 'mcts_node', ...n });
    summary.mctsSearches = summarizeMctsSearches(mctsNodes, mctsSearches);

    // The records store, walked as the grid it is. Every value written here is
    // RAW in the objective's own unit, and the unit and direction travel with it:
    // a bundle row carrying a bare real is a number a reader has to guess the
    // meaning of, which is the whole reason the store now records what it
    // measured. Occupants are PAGED — a cell's population has no bound.
    summary.recordObjectives = await safe('record_objectives', source.recordObjectives(sectionLimit), []);
    for (const objective of summary.recordObjectives) {
      writer.write(recordObjectiveRecord(objective));
      const objectiveHandle = {
        objectiveId: objective.objectiveId, floorDigest: objective.floorDigest,
      };
      const cells = await safe('record_cells', source.recordCells(objectiveHandle, sectionLimit), []);
      for (const cell of cells) {
        writer.write({
          t: 'record_cell', objectiveId: objective.objectiveId,
          floorDigest: objective.floorDigest, descriptor: cell.descriptor,
          occupants: cell.occupants, elite: cell.elite?.artifactDigest ?? null,
        });
        const handle = { ...objectiveHandle, descriptor: cell.descriptor };
        let cursor: SeekCursor | null = null;
        for (let page = 0; page < RECORD_PAGE_CAP; page += 1) {
          const occupants: Page<ExplorationRecord> = await safe(
            'record_occupants',
            source.recordOccupants(handle, cursor, DEFAULT_RECORD_PAGE),
            { status: 'end', items: [] },
          );
          for (const row of occupants.items) writer.write(explorationRecordRecord(row));
          if (occupants.status === 'end') break;
          cursor = occupants.next;
        }
      }
    }

    const jobs = await safe('background_jobs', source.backgroundJobs(sectionLimit), []);
    summary.backgroundJobs = jobs;
    for (const j of jobs) writer.write({ t: 'background_job', ...j });

    const changelog = await safe('changelog', source.changelog(sectionLimit), { entries: [], unseenCount: 0, seenAt: 0 });
    summary.changelogUnseen = changelog.unseenCount;
    for (const entry of changelog.entries) writer.write({ t: 'changelog_entry', ...entry });

    const scaffoldVersions = await safe('scaffold_versions', source.scaffoldVersions(sectionLimit), []);
    summary.scaffoldVersionCount = scaffoldVersions.length;
    for (const v of scaffoldVersions) writer.write({ t: 'scaffold_version', ...v });

    const gepaRuns = await safe('gepa_runs', source.gepaRuns(sectionLimit), []);
    summary.gepaRunCount = gepaRuns.length;
    for (const g of gepaRuns) writer.write({ t: 'gepa_run', ...g });

    const releaseBoard = await safe('release_board', source.releaseBoard(sectionLimit), null);
    if (releaseBoard) writer.write({ t: 'release_board', ...asRecord({ value: releaseBoard }, 'value') });

    const triggers = await safe('triggers', source.triggers(), null);
    if (triggers) writer.write({ t: 'triggers', ...asRecord({ value: triggers }, 'value') });

    const tools = await safe('tools', source.toolDescriptions(), null);
    if (tools) writer.write({ t: 'tools', ...asRecord({ value: tools }, 'value') });

    const facts = await safe('facts', source.facts(sectionLimit), []);
    summary.factCount = facts.length;
    for (const f of facts) writer.write({ t: 'fact', ...f });

    const memory = await safe('memory', source.memoryContent(), '');
    if (memory) writer.write({ t: 'memory', content: memory });

    const activity = await safe('activity_snapshot', source.activitySnapshot(), null);
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
function printJsonSummary(summary: DebugSummary, outPath: string): void {
  printJson(redactDeep(decodeJsonValue({ value: { bundle: outPath, ...summary } })));
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

  if (summary.recordObjectives.length > 0) {
    console.log(`\n${ACCENT('Exploration records')} (${summary.recordObjectives.length} comparable set(s), newest first)`);
    for (const objective of summary.recordObjectives.slice(0, 5)) {
      // The unit and the arrow are the whole point: a raw value with neither is a
      // number a reader has to guess the meaning of, and guessing a delta for a
      // level is how 25.4% came to be read as a reward level.
      const arrow = objective.direction === 'minimise' ? '↓' : '↑';
      const best = objective.best === null
        ? WARN('no rows')
        : `best ${arrow}${String(objective.best.value)} ${objective.unit}`;
      const floorTag = objective.floorDigest === null ? DIM('no floor') : DIM(`floor ${objective.floorDigest.slice(0, 8)}`);
      console.log(`  ${DIM(new Date(objective.lastRecordedAt).toLocaleString())} ${ACCENT(objective.objectiveId.slice(0, 8))} ${objective.metric} — ${objective.rows} row(s) over ${objective.cells} cell(s), ${best}, ${floorTag}`);
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
  if (summary.sectionFailures.length > 0) {
    console.log(`\n${ERR('Section failures')} (${summary.sectionFailures.length}). These sections are MISSING from the bundle, not empty`);
    for (const s of summary.sectionFailures.slice(0, 20)) console.log(`  ${ACCENT(s.section)} ${s.message.slice(0, 200)}`);
  }
  console.log('');
}
