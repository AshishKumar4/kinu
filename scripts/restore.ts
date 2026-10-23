#!/usr/bin/env bun
/**
 * THE OPERATOR'S RESTORE: one workspace or one account of a deployment back to a moment of the last 30 days, from its
 * Durable Object's own SQLite history (packages/core/src/state/ops-restore.ts, ARCHITECTURE-DECISIONS W7).
 *
 *   bun scripts/restore.ts <staging|production> workspace <name> (--at=<ISO time> | --bookmark=<bookmark>)
 *   bun scripts/restore.ts <staging|production> account <email|user id> --at=<ISO time>
 *   bun scripts/restore.ts <staging|production> --undo=<file>
 *
 * Its authority is the deploy's: a one-time pass written into the deployment's AUTH_KV with wrangler under the
 * account's API token, as `scripts/reset.ts tables` writes one, and deleted when the restore answers. A workspace goes
 * back with every agent of it. An account goes back with its mailbox and its Drive, its workspaces not: each is its
 * own restore. Each restored object's rows that name R2 bytes no longer held are counted and named, as a teardown or
 * an account's deletion deleted them at once. The undo file it writes restores each object to the moment just before.
 */
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as v from 'valibot';
import { OPS_PASS_PREFIX, sha256Hex } from '@kinu.run/core';
import { why, wrangler } from './infra-cloudflare';
import { deployedConfig, INFRA_ENVIRONMENTS } from './infra-manifest';

/** A pass outlives this process by at most this, if it dies before it deletes it. */
const PASS_TTL_SECONDS = 600;

const ObjectSchema = v.looseObject({
  class: v.string(), name: v.string(), id: v.string(), bookmark: v.string(), undo: v.string(), previous: v.string(), current: v.string(), landed: v.boolean(),
  missing: v.optional(v.object({ named: v.number(), missing: v.number(), keys: v.array(v.string()) })),
  unread: v.optional(v.string()),
});

const AnswerSchema = v.object({
  objects: v.array(ObjectSchema), landed: v.boolean(), stopped: v.optional(v.string()),
  skipped: v.optional(v.array(v.object({ class: v.string(), name: v.string(), why: v.string() })), []),
});

const UndoSchema = v.array(v.object({ class: v.string(), name: v.string(), bookmark: v.string() }));

const ArgsSchema = v.object({
  environment: v.picklist(INFRA_ENVIRONMENTS),
  kind: v.picklist(['workspace', 'account']),
  name: v.pipe(v.string(), v.nonEmpty()),
});

/** The request's object and target, from the command line; null with why when it says neither right. */
export function restoreRequest(argv: readonly string[]): { readonly environment: string; readonly body: object } | { readonly refused: string } {
  const [environment, kind, name] = argv.filter((arg) => !arg.startsWith('--'));
  const flag = (key: string) => argv.find((arg) => arg.startsWith(`--${key}=`))?.slice(key.length + 3);
  const undo = flag('undo');

  if (undo !== undefined) {
    const objects = v.safeParse(UndoSchema, JSON.parse(readFileSync(undo, 'utf8')));
    const env = v.safeParse(v.picklist(INFRA_ENVIRONMENTS), environment);

    if (!objects.success || !env.success) return { refused: `--undo=${undo} is not an undo file this script wrote, or the environment is not named` };

    return { environment: env.output, body: { undo: objects.output } };
  }

  const args = v.safeParse(ArgsSchema, { environment, kind, name });
  const [at, bookmark] = [flag('at'), flag('bookmark')];

  if (!args.success) return { refused: 'name the environment, then `workspace <name>` or `account <email|user id>`' };

  if ((at === undefined) === (bookmark === undefined)) return { refused: 'name one of --at=<ISO time> and --bookmark=<bookmark>' };

  if (args.output.kind === 'account' && bookmark !== undefined) return { refused: 'an account goes back by --at: a bookmark is one object\'s, and an account is several' };
  const moment = at === undefined ? undefined : Date.parse(at);

  if (moment !== undefined && Number.isNaN(moment)) return { refused: `--at=${at ?? ''} is not a time` };
  const { kind: chosen, name: named } = args.output;
  const account = named.includes('@') ? { class: 'UserDO', email: named } : { class: 'UserDO', name: named };

  return {
    environment: args.output.environment,
    body: { object: chosen === 'workspace' ? { class: 'OrchestratorAgent', name: named } : account, to: moment === undefined ? { bookmark } : { at: moment } },
  };
}

function kv(environment: string, argv: readonly string[]): void {
  const config = deployedConfig(v.parse(v.picklist(INFRA_ENVIRONMENTS), environment));
  const id = config.kv_namespaces?.find((namespace) => namespace.binding === 'AUTH_KV')?.id;

  if (id === undefined) throw new Error(`${config.name ?? 'the Worker'} binds no AUTH_KV, where the restore's pass is written`);
  const ran = wrangler(['kv', 'key', ...argv, '--namespace-id', id, '--remote'], { timeoutMs: 120_000 });

  if (!ran.ok) throw new Error(`wrangler kv key ${argv[0] ?? ''} failed: ${why(ran)}`);
}

async function main(argv: readonly string[]): Promise<number> {
  const asked = restoreRequest(argv);

  if ('refused' in asked) {
    console.error(`restore: ${asked.refused}\nusage: bun scripts/restore.ts <staging|production> (workspace <name> (--at=<ISO time> | --bookmark=<b>) | account <email|user id> --at=<ISO time> | --undo=<file>)`);

    return 2;
  }

  const config = deployedConfig(v.parse(v.picklist(INFRA_ENVIRONMENTS), asked.environment));
  const origin = config.vars?.CLI_PUBLIC_ORIGIN ?? '';
  const pass = randomBytes(32).toString('base64url');
  const key = `${OPS_PASS_PREFIX}${sha256Hex(pass)}`;

  kv(asked.environment, ['put', key, '1', '--ttl', String(PASS_TTL_SECONDS)]);

  try {
    const answer = await fetch(`${origin}/ops/restore`, {
      method: 'POST', headers: { authorization: `Bearer ${pass}`, 'content-type': 'application/json' }, body: JSON.stringify(asked.body),
      signal: AbortSignal.timeout(120_000),
    });

    const text = await answer.text();
    const read = v.safeParse(AnswerSchema, JSON.parse(text));

    if (!read.success) throw new Error(`/ops/restore answered ${String(answer.status)}: ${text.slice(0, 600)}`);
    const { objects, landed, stopped, skipped } = read.output;

    for (const one of objects) {
      console.log(`${one.class} ${one.name}: ${one.landed ? 'restored' : 'ARMED BUT NOT LANDED: it lands at the object\'s next start'}  (to ${one.bookmark}, was ${one.previous})`);

      if (one.unread !== undefined) console.log(`  what its rows name could not be read, so what it lost is unknown: ${one.unread}`);

      if (one.missing !== undefined && one.missing.missing > 0) {
        console.log(`  ${String(one.missing.missing)} of the ${String(one.missing.named)} R2 objects its rows name are gone, deleted at once and not brought back:`);

        for (const gone of one.missing.keys) console.log(`    ${gone}`);
      }
    }

    for (const one of skipped) console.log(`${one.class} ${one.name}: skipped, ${one.why}`);

    if (stopped !== undefined) console.log(`STOPPED before the rest of it: ${stopped}`);
    const undoFile = join(mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), 'kinu-restore-')), 'undo.json');

    writeFileSync(undoFile, `${JSON.stringify(objects.map((one) => ({ class: one.class, name: one.name, bookmark: one.undo })), null, 2)}\n`);
    console.log(`undo with: bun scripts/restore.ts ${asked.environment} --undo=${undoFile}`);

    return landed ? 0 : 1;
  } finally {
    kv(asked.environment, ['delete', key]);
  }
}

if (import.meta.main) process.exit(await main(process.argv.slice(2)));
