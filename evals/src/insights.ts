import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, normalize } from 'node:path';
import * as v from 'valibot';
import { parseSync, Visitor, type VisitorObject } from 'oxc-parser';
import { decodeModelMessageValues, JsonValueSchema, RunEventSchema, type JsonValue, type RunEvent } from '@kinu.run/core';
import { redactJson } from './redact';
import type { Assertion, HarnessRun } from './results';
import type { TimelineEntry } from './timeline';
import { TimelineEntrySchema } from './timing';

export const EVIDENCE_FILES = ['ledger.jsonl', 'timeline.jsonl', 'transcript.md', 'results.json'] as const;

export type EvidenceFile = typeof EVIDENCE_FILES[number];

export type EvidenceLine = { file: EvidenceFile; line: number };

export type TrialEvidence = { ledger: string; timeline: string; transcript: string };

export type InsightKind = 'tool-calls' | 'tool-errors' | 'failing-call-loop' | 'helper-hired' | 'helper-runs'
  | 'helper-message' | 'idle-helper' | 'duplicated-delegation' | 'lead-delegated-work' | 'lead-report-wait'
  | 'swarm-run' | 'no-tool-turn' | 'provider-error' | 'provider-wait' | 'stream-drop' | 'first-failing-check'
  | 'turn-outcome' | 'harness-error';

export type InsightFact = { kind: InsightKind; data: JsonValue; evidence: EvidenceLine[] };

export type TrialInsights = {
  taskId: string; model: string; arm: string; trial: number;
  facts: InsightFact[];
  lines: Record<EvidenceFile, number>;
};

type RecordFact = (kind: InsightKind, data: JsonValue, sources: EvidenceLine[]) => void;

type Located<T> = { value: T; evidence: EvidenceLine };

type ToolEnd = Extract<RunEvent, { type: 'tool_call_end' }>;

type Call = { event: ToolEnd; args: JsonValue; complete: boolean; evidence: [EvidenceLine, ...EvidenceLine[]]; run: LedgerRun };

type LedgerRun = {
  start: Extract<RunEvent, { type: 'run_start' }>; evidence: EvidenceLine; calls: Call[]; steps: number;
  end?: Located<Extract<RunEvent, { type: 'run_end' }>>;
};

type Assignment = { helper: string; brief: string; evidence: EvidenceLine[]; call: Call };

type HelperObservation = { status: string | null; runs: JsonValue | null; evidence: EvidenceLine[] };

type HelperObservations = Map<string, HelperObservation>;

const JsonObject = v.record(v.string(), JsonValueSchema);

// The older build writes partial snapshots as well as completed steps; snapshots are not calls.
const EvidenceEvent = v.union([RunEventSchema, v.object({ type: v.literal('step_partial'), runId: v.string() })]);

const HelperRun = v.object({ status: v.string(), asked: v.optional(v.string()), userMessage: v.optional(v.nullable(v.string())) });

const Helper = v.object({ name: v.string(), status: v.string(), runs: v.optional(v.array(HelperRun)) });

const HelperCheck = v.object({ helpers: v.array(Helper) });

type EvidenceEvent = v.InferOutput<typeof EvidenceEvent>;

type Helper = v.InferOutput<typeof Helper>;

function jsonLines<S extends v.GenericSchema>(content: string, file: EvidenceFile, schema: S): Located<v.InferOutput<S>>[] {
  return content.split('\n').flatMap((line, index) => line.trim() === '' ? [] : [{
    value: v.parse(schema, JSON.parse(line)), evidence: { file, line: index + 1 },
  }]);
}

function object(value: JsonValue | undefined): Record<string, JsonValue> {
  return v.is(JsonObject, value) ? value : {};
}

function stringOf(value: JsonValue | undefined): string {
  return v.is(v.string(), value) ? value : '';
}

function refs(...parts: readonly EvidenceLine[][]): EvidenceLine[] {
  const seen = new Set<string>();

  return parts.flat().filter((ref) => {
    const key = `${ref.file}:${String(ref.line)}`;

    if (seen.has(key)) return false;

    seen.add(key);

    return true;
  });
}

/** Object key order does not distinguish two calls; array order and every input value do. */
function canonical(value: JsonValue): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;

  if (v.is(JsonObject, value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key] ?? null)}`).join(',')}}`;

  return JSON.stringify(value);
}

function failed(event: ToolEnd): boolean {
  return event.error !== undefined || event.outcome?.success === false;
}

function mentionedPaths(content: string): string[] {
  return [...new Set([...content.matchAll(/\/(?:[\w.-]+\/)*[\w.-]+/g)].map((match) => match[0]))];
}

function lineCount(content: string): number {
  const kept = content.trimEnd();

  return kept === '' ? 0 : kept.split('\n').length;
}

/** A program's file writes, by namespace. */
const PROGRAM_WRITES = new Map([['workspace', ['writeFile', 'editFile']], ['file', ['write', 'edit']]]);

/** Only explicit write submissions count, never reading an output or mentioning it in a reply. */
function writtenPaths(call: Call): string[] {
  if (failed(call.event)) return [];

  const args = object(call.args);

  if (call.event.name === 'file' && ['write', 'edit'].includes(stringOf(args.op))) return [stringOf(args.path)];

  if (call.event.name === 'eval') {
    const source = parseSync('trial.ts', stringOf(args.code));
    const paths: string[] = [];

    new Visitor({
      CallExpression(node) {
        const callee = node.callee;

        if (callee.type !== 'MemberExpression' || callee.object.type !== 'Identifier' || callee.property.type !== 'Identifier'
          || PROGRAM_WRITES.get(callee.object.name)?.includes(callee.property.name) !== true) return;

        const path = node.arguments[0];

        if (path === undefined || path.type !== 'Literal') return;

        const literal = v.safeParse(v.string(), path.value);

        if (literal.success) paths.push(literal.output);
      },
    } satisfies VisitorObject).visit(source.program);

    return paths;
  }

  if (call.event.name !== 'shell') return [];

  const command = stringOf(args.command);

  return [...command.matchAll(/(?:^|[^<])>{1,2}\s*["']?(\/[^\s"';&|]+)/g)].flatMap((match) => match[1] === undefined ? [] : [match[1]]);
}

function lineOf(lines: readonly string[], key: string, value: JsonValue, from = 0): number {
  const field = `${JSON.stringify(key)}: ${JSON.stringify(value)}`;
  const at = lines.findIndex((line, index) => index >= from && (line.trim() === field || line.trim() === `${field},`));

  if (at === -1) throw new Error(`results row has no ${key}=${JSON.stringify(value)}`);

  return at + 1;
}

export function resultsRow(assertion: Assertion): string {
  return `${JSON.stringify(assertion, null, 2)}\n`;
}

function completeStep(owner: LedgerRun, step: Extract<RunEvent, { type: 'step_finish' }>, source: EvidenceLine): void {
  owner.steps += 1;

  for (const message of decodeModelMessageValues(step.messages ?? [])) {
    if (message.role !== 'assistant' || v.is(v.string(), message.content)) continue;

    for (const part of message.content) {
      if (part.type !== 'tool-call') continue;

      const input = v.safeParse(JsonValueSchema, part.input);
      const call = owner.calls.find((candidate) => candidate.event.toolCallId === part.toolCallId);

      if (input.success && call !== undefined) {
        call.args = input.output;
        call.complete = true;
        call.evidence.push(source);
      }
    }
  }
}

function recordProvider(event: EvidenceEvent, source: EvidenceLine, add: RecordFact): void {
  if (event.type === 'provider_wait') {
    add('provider-wait', { provider: event.provider, model: event.modelId ?? null, status: event.status ?? null,
      attempt: event.attempt, waitMs: event.waitMs, source: event.source }, [source]);
  } else if (event.type === 'model_operation' && event.error !== undefined) {
    add('provider-error', { model: event.modelId ?? null, operation: event.op, outcome: event.outcome ?? null, error: event.error }, [source]);
  } else if (event.type === 'model_fallback') {
    add('provider-error', { from: event.from, to: event.to, error: event.reason }, [source]);
  } else if (event.type === 'error') {
    add('provider-error', { origin: 'run error; provider attribution is unproven', error: event.message }, [source]);
  }
}

function ledgerRuns(rows: readonly Located<EvidenceEvent>[], add: RecordFact) {
  const runs: LedgerRun[] = [];
  const active = new Map<string, LedgerRun>();
  const calls: Call[] = [];

  for (const { value: event, evidence: source } of rows) {
    if (event.type === 'run_start') {
      const started: LedgerRun = { start: event, evidence: source, calls: [], steps: 0 };

      runs.push(started);
      active.set(event.runId, started);
    } else if (event.type === 'tool_call_end') {
      const owner = active.get(event.runId);

      if (owner === undefined) throw new Error(`ledger.jsonl:${String(source.line)}: call has no run_start`);

      const call: Call = { event, args: event.args ?? null, complete: v.is(JsonObject, event.args), evidence: [source], run: owner };

      calls.push(call);
      owner.calls.push(call);
    } else if (event.type === 'step_finish') {
      const owner = active.get(event.runId);

      if (owner !== undefined) completeStep(owner, event, source);
    } else if (event.type === 'run_end') {
      const owner = active.get(event.runId);

      if (owner !== undefined) owner.end = { value: event, evidence: source };
    } else {
      recordProvider(event, source, add);
    }
  }

  return { runs, calls };
}

function recordTools(calls: readonly Call[], add: RecordFact): void {
  for (const tool of new Set(calls.map((call) => call.event.name))) {
    const invoked = calls.filter((call) => call.event.name === tool);

    add('tool-calls', { tool, calls: invoked.length, errors: invoked.filter((call) => failed(call.event)).length }, invoked.flatMap((call) => call.evidence));
  }

  type Failure = { tool: string; code: string | null; kind: string; message: string };

  const errors = new Map<string, Failure & { evidence: EvidenceLine[] }>();

  const countError = (failure: Failure, source: EvidenceLine): void => {
    const key = JSON.stringify([failure.tool, failure.code, failure.kind]);
    const counted = errors.get(key);

    if (counted === undefined) errors.set(key, { ...failure, evidence: [source] });
    else counted.evidence.push(source);
  };

  for (const call of calls) {
    const outcome = call.event.outcome;

    if (failed(call.event)) countError({ tool: call.event.name, code: outcome?.success === false ? outcome.reason : null,
      kind: outcome?.success === false ? 'refusal' : 'error', message: call.event.error ?? JSON.stringify(call.event.result ?? null) }, call.evidence[0]);

    for (const failure of outcome?.failures ?? []) {
      countError({ tool: failure.tool, code: failure.reason, kind: 'binding-refusal', message: failure.error }, call.evidence[0]);
    }
  }

  for (const { tool, code, kind, message, evidence: sources } of errors.values()) {
    add('tool-errors', { tool, code, kind, count: sources.length, firstMessage: message }, sources);
  }
}

function recordRuns(runs: readonly LedgerRun[], add: RecordFact): void {
  for (const owner of runs) {
    const repeated = new Map<string, Call[]>();

    const flush = (key: string): void => {
      const same = repeated.get(key) ?? [];
      const first = same[0];

      if (first !== undefined && same.length > 1) add('failing-call-loop', { runId: owner.start.runId, tool: first.event.name,
        arguments: first.args, count: same.length }, same.flatMap((call) => call.evidence));

      repeated.delete(key);
    };

    for (const call of owner.calls) {
      if (!call.complete) continue;

      const key = `${call.event.name}:${canonical(call.args)}`;

      if (!failed(call.event)) flush(key);
      else {
        const same = repeated.get(key) ?? [];

        same.push(call);
        repeated.set(key, same);
      }
    }

    for (const key of repeated.keys()) flush(key);

    if (owner.end !== undefined && owner.calls.length === 0) add('no-tool-turn', {
      runId: owner.start.runId, agent: owner.start.agentId, causedBy: owner.start.caused_by ?? null,
      steps: owner.steps, outcome: owner.end.value.reason ?? null,
    }, [owner.evidence, owner.end.evidence]);

    if (owner.end?.value.error !== undefined) add('provider-error', {
      origin: 'run end; provider attribution is unproven', error: owner.end.value.error, outcome: owner.end.value.reason ?? null,
    }, [owner.end.evidence]);
  }
}

function recordedHelper(helper: Helper, old: HelperObservation | undefined, sources: EvidenceLine[]): HelperObservation {
  return { status: helper.status, runs: helper.runs?.map((item) => ({ status: item.status, asked: item.asked ?? item.userMessage ?? null })) ?? old?.runs ?? null,
    evidence: refs(old?.evidence ?? [], sources) };
}

function assignedHelper(call: Call, helpers: HelperObservations, add: RecordFact): Assignment | null {
  const args = object(call.args), answer = object(call.event.result);
  const op = stringOf(args.op);

  if (op === 'hire' && stringOf(answer.name) !== '') {
    const name = stringOf(answer.name);

    add('helper-hired', { helper: name, mission: args.mission ?? null, lifetime: args.lifetime ?? null }, call.evidence);
    helpers.set(name, { status: null, runs: null, evidence: call.evidence });

    return { helper: name, brief: stringOf(args.mission), evidence: call.evidence, call };
  }

  if ((op === 'assign' || op === 'message') && stringOf(args.agent) !== '') {
    const name = stringOf(args.agent);

    add('helper-message', { helper: name, op, message: args.message ?? null, delivery: answer.delivery ?? answer.status ?? null,
      eventId: answer.event_id ?? null }, call.evidence);

    return { helper: name, brief: stringOf(args.message), evidence: call.evidence, call };
  }

  return null;
}

function recordDelegations(calls: readonly Call[], add: RecordFact) {
  const assignments: Assignment[] = [];
  const helpers: HelperObservations = new Map();

  for (const call of calls) {
    if (call.event.name !== 'agents') continue;

    const args = object(call.args);
    const op = stringOf(args.op);

    if (op === 'swarm') {
      add('swarm-run', { task: args.task ?? null, outcome: failed(call.event) ? 'failed' : 'returned',
        code: call.event.outcome?.success === false ? call.event.outcome.reason : null, result: call.event.result ?? null }, call.evidence);
    }

    if (failed(call.event)) continue;

    const assignment = assignedHelper(call, helpers, add);

    if (assignment !== null) assignments.push(assignment);

    if (op === 'list') {
      const roster = v.safeParse(v.object({ subordinates: v.array(Helper) }), call.event.result);

      for (const helper of roster.success ? roster.output.subordinates : []) {
        helpers.set(helper.name, recordedHelper(helper, helpers.get(helper.name), call.evidence));
      }
    }
  }

  return { assignments, helpers };
}

function helperSources(lines: readonly string[], helper: Helper, at: number): EvidenceLine[] {
  const source: EvidenceLine[] = [{ file: 'results.json', line: at }];
  let runAt = lineOf(lines, 'status', helper.status, at);

  source.push({ file: 'results.json', line: runAt });

  for (const observedRun of helper.runs ?? []) {
    runAt = lineOf(lines, 'status', observedRun.status, runAt);
    source.push({ file: 'results.json', line: runAt });
  }

  return source;
}

function recordResultTurns(run: HarnessRun, lines: readonly string[], helpers: HelperObservations, add: RecordFact): void {
  let checkAt = lines.findIndex((line) => line.trim() === '"output": {');

  for (const turn of run.output.turns) {
    const statusAt = lineOf(lines, 'status', turn.outcome.status, checkAt);

    checkAt = statusAt;

    if (turn.outcome.status !== 'completed') add('turn-outcome', { turn: turn.turn, status: turn.outcome.status,
      message: turn.outcome.message ?? null }, [{ file: 'results.json', line: statusAt }]);

    for (const check of turn.checks) {
      const at = lineOf(lines, 'id', check.id, checkAt);
      const inspected = v.safeParse(HelperCheck, check.evidence);

      checkAt = at;

      if (!inspected.success) continue;

      let helperAt = at;

      for (const helper of inspected.output.helpers) {
        helperAt = lineOf(lines, 'name', helper.name, helperAt);
        helpers.set(helper.name, recordedHelper(helper, helpers.get(helper.name), helperSources(lines, helper, helperAt)));
      }
    }
  }
}

function recordHelperRuns(helpers: HelperObservations, runs: readonly LedgerRun[], add: RecordFact): void {
  for (const [helper, observed] of helpers) {
    const own = runs.filter((owner) => owner.start.agentId === helper);

    const recorded = own.map((owner) => ({ runId: owner.start.runId, status: owner.end?.value.reason ?? 'open',
      asked: owner.start.turn?.text ?? owner.start.userMessage ?? '' }));

    const observedRuns = recorded.length === 0 ? observed.runs : recorded;
    const source = refs(observed.evidence, own.flatMap((owner) => [owner.evidence, ...(owner.end === undefined ? [] : [owner.end.evidence])]));

    add('helper-runs', { helper, status: observed.status, runs: observedRuns }, source);

    if (observed.status === 'idle' && Array.isArray(observedRuns) && observedRuns.length === 0) add('idle-helper', { helper }, source);
  }
}

function recordDelegationWork(assignments: readonly Assignment[], calls: readonly Call[], add: RecordFact): void {
  const distinct = assignments.filter((assignment, index, all) => assignment.brief !== ''
    && all.findIndex((other) => other.helper === assignment.helper && other.brief === assignment.brief) === index);

  const writes = new Map<Call, string[]>();

  for (const [index, assignment] of distinct.entries()) {
    const duplicates = distinct.slice(index + 1).filter((other) => other.helper !== assignment.helper && other.brief === assignment.brief);

    if (duplicates.length > 0 && !distinct.slice(0, index).some((other) => other.brief === assignment.brief)) add('duplicated-delegation', {
      helpers: [assignment.helper, ...duplicates.map((other) => other.helper)], brief: assignment.brief,
    }, refs(assignment.evidence, ...duplicates.map((other) => other.evidence)));

    const delegated = new Set(mentionedPaths(assignment.brief));

    for (const call of calls) {
      if (call.run.start.agentId !== assignment.call.run.start.agentId || call.evidence[0].line <= assignment.call.evidence[0].line) continue;

      const submitted = writes.get(call) ?? writtenPaths(call);
      const overlaps = submitted.filter((path) => delegated.has(path));

      writes.set(call, submitted);

      if (overlaps.length > 0) add('lead-delegated-work', { helper: assignment.helper, paths: overlaps, tool: call.event.name,
        observation: 'lead submitted explicit writes to paths named in the delegation; whether this duplicated the computation needs the trajectory' }, refs(assignment.evidence, call.evidence));
    }
  }
}

function recordReports(assignments: readonly Assignment[], runs: readonly LedgerRun[], helpers: HelperObservations, add: RecordFact): void {
  const first = assignments[0];

  if (first === undefined) return;

  const lead = first.call.run.start.agentId;

  const reports = runs.filter((owner) => owner.start.agentId === lead && (owner.start.caused_by === 'subordinate_report'
    || (owner.start.turn?.kind === 'programmatic' && owner.start.turn.text.includes('subordinate_report'))));

  const ends = runs.filter((owner) => owner.start.agentId === lead && owner.end !== undefined);

  add('lead-report-wait', { helpers: [...helpers.keys()], reportRuns: reports.map((owner) => owner.start.runId),
    observed: reports.length === 0 ? 'no-report-recorded' : 'resumed-on-report' },
  refs(...assignments.map((assignment) => assignment.evidence), reports.map((owner) => owner.evidence), ends.flatMap((owner) => owner.end === undefined ? [] : [owner.end.evidence])));
}

function recordStreamDrops(timeline: readonly Located<TimelineEntry>[], add: RecordFact): void {
  let turnNumber = 0;

  for (const { value: entry, evidence: source } of timeline) {
    if (entry.mark === 'turn') turnNumber += 1;

    if (entry.mark.startsWith('chunk:closed ') || entry.mark === 'chunk:replay') add('stream-drop', {
      turn: turnNumber, mark: entry.mark, count: entry.count ?? 1, at: entry.at,
    }, [source]);
  }
}

function recordFailures(run: HarnessRun, lines: readonly string[], transcript: readonly string[], add: RecordFact): void {
  const outputAt = lines.findIndex((line) => line.trim() === '"output": {');
  const first = run.output.turns.flatMap((turn) => turn.checks.filter((check) => !check.pass).map((check) => ({ turn: turn.turn, check }))).at(0);

  if (first !== undefined) {
    const at = lineOf(lines, 'id', first.check.id, outputAt);
    const transcriptAt = transcript.findIndex((line) => line.startsWith(`- FAIL \`${first.check.id}\``));

    add('first-failing-check', { turn: first.turn, id: first.check.id, evidence: first.check.evidence ?? null },
      [{ file: 'results.json', line: at }, ...(transcriptAt === -1 ? [] : [{ file: 'transcript.md' as const, line: transcriptAt + 1 }])]);
  }

  for (const error of run.errors) add('harness-error', { name: error.name, message: error.message }, [{ file: 'results.json', line: lineOf(lines, 'name', error.name, outputAt) }]);
}

/** Facts are observations, not causes. Missing facet evidence is not proof that a helper was idle. */
export function extractInsights(assertion: Assertion, evidence: TrialEvidence): TrialInsights {
  const run = assertion.meta.harness.run;
  const resultLines = resultsRow(assertion).split('\n');
  const facts: InsightFact[] = [];
  const add: RecordFact = (kind, data, sources) => { facts.push({ kind, data: redactJson(data), evidence: refs(sources) }); };

  const { runs, calls } = ledgerRuns(jsonLines(evidence.ledger, 'ledger.jsonl', EvidenceEvent), add);

  recordTools(calls, add);
  recordRuns(runs, add);

  const { assignments, helpers } = recordDelegations(calls, add);

  recordResultTurns(run, resultLines, helpers, add);
  recordHelperRuns(helpers, runs, add);
  recordDelegationWork(assignments, calls, add);
  recordReports(assignments, runs, helpers, add);
  recordStreamDrops(jsonLines(evidence.timeline, 'timeline.jsonl', TimelineEntrySchema), add);
  recordFailures(run, resultLines, evidence.transcript.split('\n'), add);

  return { taskId: run.session.metadata.taskId, model: run.usage.model, arm: run.session.metadata.arm, trial: run.session.metadata.trial, facts,
    lines: { 'ledger.jsonl': lineCount(evidence.ledger), 'timeline.jsonl': lineCount(evidence.timeline),
      'transcript.md': lineCount(evidence.transcript), 'results.json': resultLines.length - 1 } };
}

/** Uploaded evidence has a new root, but retains the report's task-run/model/arm/trial suffix. */
export function evidenceDirectories(root: string): string[] {
  if (existsSync(join(root, 'ledger.jsonl'))) return [root];

  return readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory())
    .flatMap((entry) => evidenceDirectories(join(root, entry.name)));
}

export function evidenceDirectory(directories: readonly string[], assertion: Assertion): string {
  const stored = v.parse(v.pipe(v.string(), v.minLength(1)), assertion.meta.harness.run.session.metadata.evidence);
  const suffix = normalize(stored).split('/').slice(-4).join('/');
  const matches = directories.filter((directory) => normalize(directory).endsWith(`/${suffix}`));
  const directory = matches[0];

  if (directory === undefined || matches.length !== 1) throw new Error(`expected one evidence directory for ${stored}, found ${String(matches.length)}`);

  return directory;
}

export function readTrialEvidence(directory: string): TrialEvidence {
  return { ledger: readFileSync(join(directory, 'ledger.jsonl'), 'utf8'), timeline: readFileSync(join(directory, 'timeline.jsonl'), 'utf8'),
    transcript: readFileSync(join(directory, 'transcript.md'), 'utf8') };
}
