#!/usr/bin/env bun
/**
 * EVAL-SERVICE'S CREDENTIALS ACROSS A RESET, so the reviewer's ChatGPT login is never asked of the owner again. `save`
 * runs before a reset deletes the deployment's objects, which it refuses when this fails: the deployment seals
 * eval-service's credentials for its account, not its object, and the file keeps that ciphertext. `restore` runs once a
 * build serves: the deployment opens it and stores what the account lacks, then the file goes. A file still there is a
 * restore owed, which `save` keeps. A failure exits 1, naming why.
 *
 *   bun scripts/credential-checkpoint.ts save|restore <origin>
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as v from 'valibot';
import { DEV_IDENTITY_HEADER } from '@kinu.run/core';
import { evalWebIdentityEnv } from '@kinu.run/test-utils';

const CheckpointSchema = v.array(v.object({ key: v.string(), sealed: v.string() }));

const RestoredSchema = v.object({ restored: v.array(v.string()) });

async function carried<Schema extends v.GenericSchema>(schema: Schema, origin: string, secret: string, init: RequestInit = {}): Promise<v.InferOutput<Schema>> {
  const response = await fetch(`${origin}/api/user/credential-checkpoint`, {
    ...init, headers: { [DEV_IDENTITY_HEADER]: secret, 'content-type': 'application/json' }, signal: AbortSignal.timeout(30_000),
  });

  if (!response.ok) throw new Error(`${init.method ?? 'GET'} /api/user/credential-checkpoint answered ${String(response.status)}: ${(await response.text()).slice(0, 300)}`);

  return v.parse(schema, await response.json());
}

if (import.meta.main) {
  const [step, asked = ''] = process.argv.slice(2);

  if ((step !== 'save' && step !== 'restore') || !URL.canParse(asked)) {
    console.error('usage: bun scripts/credential-checkpoint.ts save|restore <origin>');
    process.exit(2);
  }

  const origin = new URL(asked).origin;
  const file = join(homedir(), '.cache', 'kinu', 'credential-checkpoint', `${new URL(origin).host}.json`);
  const secret = process.env[evalWebIdentityEnv(origin)]?.trim() ?? '';

  try {
    if (secret === '') throw new Error(`${evalWebIdentityEnv(origin)} is not set, so nothing can act as eval-service at ${origin}`);

    if (step === 'save' && existsSync(file)) {
      console.log(`credential-checkpoint: ${file} is a restore still owed to ${origin}; kept`);
    } else if (step === 'save') {
      const checkpoint = await carried(CheckpointSchema, origin, secret);

      mkdirSync(join(file, '..'), { recursive: true });
      writeFileSync(file, JSON.stringify(checkpoint), { mode: 0o600 });
      console.log(`credential-checkpoint: saved ${checkpoint.map((each) => each.key).join(', ') || 'nothing'} from ${origin}`);
    } else if (existsSync(file)) {
      const body = readFileSync(file, 'utf8');
      const { restored } = await carried(RestoredSchema, origin, secret, { method: 'POST', body });

      rmSync(file);
      console.log(`credential-checkpoint: restored ${restored.join(', ') || 'nothing'} at ${origin}`);
    }
  } catch (error) {
    console.error(`credential-checkpoint: ${step} at ${origin} failed: ${String(error)}`);
    process.exit(1);
  }
}
