#!/usr/bin/env bun
/**
 * WHAT THE PLATFORM DID TO A LEG'S WORKSPACES, from Workers Logs, joined by eval workspace name. Each trial's results row
 * names its workspace; the objects that logged that name at startup are its workspace and the agents it hosts, and over
 * the leg's window this counts their invocations that did not end ok, the failures the product logged with a code, and
 * the alarms that woke one of them with nothing to do. Writes `PlatformReport` (src/platform.ts); a leg whose logs
 * cannot be read, for want of the Workers Observability token or for an answer refused, is written as not measured,
 * with why, and the comparison reports it rather than comparing it.
 *   bun evals/scripts/platform-bugs.ts <results.json> --worker <kinu|kinu-staging> --out <platform.json>
 */
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { renderThrownChain } from '@kinu.run/core/obs';
import { idleWakeHours, readToken, Telemetry, type Filter, type ObjectMinuteCount } from '../../scripts/prod-logs';
import type { PlatformReport, WorkspaceRead } from '../src/platform';
import { parseResults, trials } from '../src/results';

const DO_ID = '$workers.durableObjectId';

const MINUTE_MS = 60_000;

/** Logs land minutes after the line is written: the window runs this long past the leg's last trial. */
const LATE_MS = 10 * MINUTE_MS;

/** Groups one telemetry read keeps; a read that reaches it would drop objects, which then read as clean. */
const GROUPS = 2000;

const eq = (key: string, value: string): Filter => ({ key, operation: 'eq', value, type: 'string' });

const INVOCATION = eq('$metadata.type', 'cf-worker-event');

const { values, positionals } = parseArgs({ allowPositionals: true, options: { worker: { type: 'string' }, out: { type: 'string' } } });

const [resultsPath] = positionals;

if (resultsPath === undefined || values.worker === undefined || values.out === undefined) {
  throw new Error('usage: bun evals/scripts/platform-bugs.ts <results.json> --worker <name> --out <platform.json>');
}

const files = parseResults('the leg', await Bun.file(resultsPath).text());

const workspaces = new Set(trials(files).flatMap((trial): string[] => {
  const name = trial.meta.harness.run.session.metadata.workspace;

  return name === undefined || name === null ? [] : [name];
}));

const starts = files.flatMap((file) => file.startTime ?? []);

const ends = files.flatMap((file) => file.endTime ?? []);

/** Every group a read returns, refused when it may have dropped some. */
function whole<T>(rows: readonly T[], what: string): readonly T[] {
  if (rows.length >= GROUPS) throw new Error(`the read of ${what} reached ${String(GROUPS)} groups and may have dropped objects`);

  return rows;
}

async function read(telemetry: Telemetry): Promise<WorkspaceRead[]> {
  const named = whole(await telemetry.count({
    filters: [eq('event', 'actor.startup'), { key: 'fields.workspace', operation: 'includes', value: 'eval-', type: 'string' }],
    groupBy: ['fields.workspace', DO_ID], limit: GROUPS,
  }), 'the eval workspaces\u2019 objects');

  const objectsOf = new Map<string, Set<string>>();

  for (const { groups: [workspace = '', object = ''] } of named) {
    if (workspaces.has(workspace)) objectsOf.set(workspace, (objectsOf.get(workspace) ?? new Set()).add(object));
  }

  const notOk: Filter = { key: '$workers.outcome', operation: 'neq', value: 'ok', type: 'string' };
  const ended = whole(await telemetry.count({ filters: [INVOCATION, notOk], groupBy: [DO_ID, '$workers.outcome'], limit: GROUPS }), 'the invocations');
  const coded = whole(await telemetry.count({ filters: [{ key: 'code', operation: 'exists', type: 'string' }], groupBy: [DO_ID, 'event', 'code'], limit: GROUPS }), 'the coded failures');

  const perMinute = async (filters: readonly Filter[], what: string): Promise<ObjectMinuteCount[]> => whole(
    await telemetry.buckets({ filters, groupBy: [DO_ID], limit: GROUPS }, MINUTE_MS), what,
  ).map((row) => ({ object: row.groups[0] ?? '', minute: row.at, count: row.count }));

  const alarms = await perMinute([INVOCATION, eq('$workers.eventType', 'alarm')], 'the alarms');
  const called = await perMinute([INVOCATION, { key: '$workers.eventType', operation: 'neq', value: 'alarm', type: 'string' }], 'the calls');
  const streams = await perMinute([eq('$metadata.type', 'cf-worker'), eq('event', 'provider.stream_opened')], 'the model calls');
  const idle = idleWakeHours(alarms, [...called, ...streams]);

  return [...workspaces].sort().map((workspace) => {
    const objects = objectsOf.get(workspace) ?? new Set<string>();
    const mine = <T extends { readonly groups: readonly string[] }>(rows: readonly T[]) => rows.filter((row) => objects.has(row.groups[0] ?? ''));

    return {
      workspace, objects: objects.size,
      ended: mine(ended).map((row) => ({ outcome: row.groups[1] ?? '', count: row.count })),
      failures: mine(coded).map((row) => ({ event: row.groups[1] ?? '', code: row.groups[2] ?? '', count: row.count })),
      idleWakes: idle.filter((row) => objects.has(row.object)).reduce((sum, row) => sum + row.count, 0),
    };
  });
}

async function report(): Promise<PlatformReport> {
  if (workspaces.size === 0 || starts.length === 0 || ends.length === 0) return { measured: false, why: 'the report names no workspace or no run window' };
  const [from, to] = [Math.min(...starts) - MINUTE_MS, Math.max(...ends) + LATE_MS];
  let token: string;

  try {
    token = await readToken();
  } catch (error) {
    return { measured: false, why: `no Workers Observability token: ${renderThrownChain({ cause: error })}` };
  }

  const telemetry = new Telemetry(token, { worker: values.worker ?? '', from, to: Math.min(to, Date.now()) });

  try {
    const readings = await read(telemetry);

    return { measured: true, worker: values.worker ?? '', from, to, sampling: telemetry.sampling, workspaces: readings };
  } catch (error) {
    return { measured: false, why: renderThrownChain({ cause: error }) };
  }
}

const written = await report();

writeFileSync(values.out, `${JSON.stringify(written, null, 1)}\n`);

console.log(written.measured
  ? `platform: ${String(written.workspaces.length)} workspaces read from ${values.worker}'s logs${written.sampling > 1 ? ', sampled' : ''}`
  : `platform: not read: ${written.why}`);
