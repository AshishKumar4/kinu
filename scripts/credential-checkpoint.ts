#!/usr/bin/env bun
/**
 * EVAL-SERVICE'S CREDENTIALS ACROSS A RESET, so the reviewer's ChatGPT login is never asked of the owner again.
 * `capture` is a reset's last check before it deletes (scripts/reset.ts): the deployment seals each credential the
 * account holds for the account, not its object, and a key it no longer holds keeps the record a restore still owes.
 * `owed` checks that record when a reset resumes past its deletions. `restore` runs once a build serves: the deployment
 * stores what the account lacks, then the file goes. Each refuses an origin that is not an eval target, and exits 1
 * naming why.
 *
 *   bun scripts/credential-checkpoint.ts capture|owed|restore <origin>
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import * as v from 'valibot';
import { DEV_IDENTITY_HEADER } from '@kinu.run/core';
import { evalTargetVerdict, evalWebIdentityEnv } from '@kinu.run/test-utils';

const CheckpointSchema = v.array(v.object({ key: v.string(), sealed: v.string() }));

const RestoredSchema = v.object({ restored: v.array(v.string()) });

interface EvalService {
  readonly origin: string;
  readonly secret: string;
}

function evalService(asked: string): EvalService {
  const verdict = evalTargetVerdict(asked);

  if (verdict.kind === 'refused') throw new Error(verdict.reason);
  const variable = evalWebIdentityEnv(verdict.origin);
  const secret = process.env[variable]?.trim() ?? '';

  if (secret === '') throw new Error(`${variable} is not set, so nothing can act as eval-service at ${verdict.origin}`);

  return { origin: verdict.origin, secret };
}

async function carried<Schema extends v.GenericSchema>(schema: Schema, service: EvalService, init: RequestInit = {}): Promise<v.InferOutput<Schema>> {
  const response = await fetch(`${service.origin}/api/user/credential-checkpoint`, {
    ...init, redirect: 'error', headers: { [DEV_IDENTITY_HEADER]: service.secret, 'content-type': 'application/json' }, signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) throw new Error(`${init.method ?? 'GET'} /api/user/credential-checkpoint answered ${String(response.status)}: ${(await response.text()).slice(0, 300)}`);

  return v.parse(schema, await response.json());
}

if (import.meta.main) {
  const [step, asked = ''] = process.argv.slice(2);

  if (step !== 'capture' && step !== 'owed' && step !== 'restore') {
    console.error('usage: bun scripts/credential-checkpoint.ts capture|owed|restore <origin>');
    process.exit(2);
  }

  try {
    const service = evalService(asked);
    const file = join(homedir(), '.cache', 'kinu', 'credential-checkpoint', `${new URL(service.origin).host}.json`);
    const owes = existsSync(file) ? v.parse(CheckpointSchema, JSON.parse(readFileSync(file, 'utf8'))) : [];

    if (step === 'capture') {
      const live = await carried(CheckpointSchema, service);
      const held = new Set(live.map((each) => each.key));
      const checkpoint = [...live, ...owes.filter((each) => !held.has(each.key))];
      const written = `${file}.${String(process.pid)}`;

      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      writeFileSync(written, JSON.stringify(checkpoint), { mode: 0o600 });
      renameSync(written, file);
      console.log(`credential-checkpoint: captured ${checkpoint.map((each) => each.key).join(', ') || 'nothing'} from ${service.origin}`);
    } else if (step === 'owed') {
      console.log(`credential-checkpoint: ${service.origin} is owed ${owes.map((each) => each.key).join(', ') || 'nothing'}`);
    } else if (existsSync(file)) {
      const { restored } = await carried(RestoredSchema, service, { method: 'POST', body: JSON.stringify(owes) });

      rmSync(file);
      console.log(`credential-checkpoint: restored ${restored.join(', ') || 'nothing'} at ${service.origin}`);
    }
  } catch (error) {
    console.error(`credential-checkpoint: ${step} at ${asked} failed: ${String(error)}`);
    process.exit(1);
  }
}
