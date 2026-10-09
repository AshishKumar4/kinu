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
import { readToken, Telemetry } from '../../scripts/prod-logs';
import { readWorkspacePlatform, type PlatformReport } from '../src/platform';
import { parseResults, trials } from '../src/results';

const MINUTE_MS = 60_000;

/** Logs land minutes after the line is written: the window runs this long past the leg's last trial. */
const LATE_MS = 10 * MINUTE_MS;

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
    const readings = await readWorkspacePlatform(telemetry, workspaces);

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
