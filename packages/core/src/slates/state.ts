import * as v from 'valibot';
import { KinuError } from '../obs/error';
import type { RawSqlExec, SqlExec, SqlExecRow } from '../types/primitives';
import { JsonValueSchema, parseJsonValue, renderIssues, type JsonValue } from '../utils/json';
import type { SlateBindingRequest } from './bindings';

/** The one binding name a slate never declares: every slate gets it, and the
 *  host answers it from the workspace object's own `slate_state` table. */
export const SLATE_STORAGE_BINDING = '__storage';

/** The other reserved binding name: the process's channel back to its host,
 *  minted beside `__storage` and answered by `bindingCall`'s `__host` arm —
 *  today the one call `release`, which retires a socket-held invocation. */
export const SLATE_HOST_BINDING = '__host';

const Key = v.pipe(v.string(), v.minLength(1), v.maxLength(512));

/**
 * A slate's durable KV table — rows the authored `this.storage` owns, keyed
 * per slate so one slate cannot read another's state. Values are JSON text.
 * Called from `initWorkspaceSchema` and by the resident-slate probe, which
 * runs the same table on its own DO storage to stand in for the workspace
 * object.
 */
export function initSlateStateTable(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS slate_state (
    slate_id TEXT NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL,
    PRIMARY KEY (slate_id, key)
  )`);
}

const ListOptions = v.strictObject({
  prefix: v.optional(v.string()),
  limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1000))),
});

export type SlateStorageListOptions = v.InferInput<typeof ListOptions>;

/** The ops `__storage` routes to, after `routeSlateStorageCall` validates one. */
export type SlateStorageOp =
  | { readonly op: 'get'; readonly key: string }
  | { readonly op: 'put'; readonly key: string; readonly value: JsonValue }
  | { readonly op: 'delete'; readonly key: string }
  | { readonly op: 'list'; readonly prefix?: string; readonly limit?: number };

function oneKey(request: SlateBindingRequest): string {
  if (request.args.length !== 1) {
    throw new KinuError('bad_input', `slate storage ${request.member} takes one key`);
  }

  const parsed = v.safeParse(Key, request.args[0]);

  if (!parsed.success) {
    throw new KinuError('bad_input', `slate storage ${request.member} takes one key: ${renderIssues(parsed.issues)}`);
  }

  return parsed.output;
}

/**
 * Turn one `__storage` member call into a typed store operation. `member`
 * selects the signature; a name the KV does not offer is `denied` and a
 * malformed argument set is `bad_input` naming the signature it broke.
 */
export function routeSlateStorageCall(request: SlateBindingRequest): SlateStorageOp {
  switch (request.member) {
    case 'get': return { op: 'get', key: oneKey(request) };
    case 'delete': return { op: 'delete', key: oneKey(request) };
    case 'put': {
      if (request.args.length !== 2) throw new KinuError('bad_input', 'slate storage put takes key and value');

      const parsed = v.safeParse(v.tuple([Key, JsonValueSchema]), request.args);

      if (!parsed.success) {
        throw new KinuError('bad_input', `slate storage put takes key and value: ${renderIssues(parsed.issues)}`);
      }

      return { op: 'put', key: parsed.output[0], value: parsed.output[1] };
    }

    case 'list': {
      if (request.args.length > 1) throw new KinuError('bad_input', 'slate storage list takes at most one { prefix?, limit? }');

      const parsed = v.safeParse(ListOptions, request.args[0] ?? {});

      if (!parsed.success) {
        throw new KinuError('bad_input', `slate storage list takes { prefix?, limit? }: ${renderIssues(parsed.issues)}`);
      }

      return { op: 'list', prefix: parsed.output.prefix, limit: parsed.output.limit };
    }

    default:
      throw new KinuError('denied', 'slate storage offers get, put, delete and list');
  }
}

/** Both `slate_state` columns are `TEXT NOT NULL`, so a row that fails these
 *  is not one this table wrote. */
const StateValue = v.object({ value: v.string() });

const StateEntry = v.object({ key: v.string(), value: v.string() });

/** One row as the pair `list` answers with. */
function stateEntry(row: SqlExecRow): [string, JsonValue] {
  const { key, value } = v.parse(StateEntry, row);

  return [key, parseJsonValue(value)];
}

/**
 * A slate's durable KV over the workspace object's `slate_state` table.
 * Values are stored as JSON text; `updated_at` is wall time for the host's
 * own diagnostics, never a guard.
 */
export class SqliteSlateStateStore {
  constructor(private readonly db: SqlExec) {}

  get(slateId: string, key: string): { value: JsonValue } | null {
    const row = this.db.exec('SELECT value FROM slate_state WHERE slate_id = ? AND key = ?', slateId, key).toArray()[0];

    return row === undefined ? null : { value: parseJsonValue(v.parse(StateValue, row).value) };
  }

  put(slateId: string, key: string, value: JsonValue): void {
    this.db.exec(
      'INSERT INTO slate_state (slate_id, key, value, updated_at) VALUES (?, ?, ?, ?)'
      + ' ON CONFLICT (slate_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      slateId, key, JSON.stringify(value), Date.now(),
    );
  }

  delete(slateId: string, key: string): boolean {
    return this.db.exec('DELETE FROM slate_state WHERE slate_id = ? AND key = ? RETURNING key', slateId, key).toArray().length !== 0;
  }

  list(slateId: string, options?: SlateStorageListOptions): Array<[string, JsonValue]> {
    const limit = Math.min(options?.limit ?? 1000, 1000);
    const prefix = options?.prefix;

    if (prefix === undefined || prefix === '') {
      return this.db.exec('SELECT key, value FROM slate_state WHERE slate_id = ? ORDER BY key LIMIT ?', slateId, limit).toArray()
        .map(stateEntry);
    }

    // The smallest key strictly above every key `prefix` begins: the prefix
    // with its last code unit one higher, trailing U+FFFF stripped first. A
    // prefix that is nothing but U+FFFF tops the collation and has no bound.
    const stem = prefix.replace(/￿+$/u, '');
    const bound = stem === '' ? undefined : stem.slice(0, -1) + String.fromCharCode(stem.charCodeAt(stem.length - 1) + 1);

    const rows = bound === undefined
      ? this.db.exec('SELECT key, value FROM slate_state WHERE slate_id = ? AND key >= ? ORDER BY key LIMIT ?', slateId, prefix, limit).toArray()
      : this.db.exec('SELECT key, value FROM slate_state WHERE slate_id = ? AND key >= ? AND key < ? ORDER BY key LIMIT ?', slateId, prefix, bound, limit).toArray();

    return rows.map(stateEntry);
  }
}
