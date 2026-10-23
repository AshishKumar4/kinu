/**
 * The account's secrets: values sealed in the owner's own object with the shared credential cipher, each granted by the
 * owner to the workspaces that may use it. A workspace only ever holds a random placeholder, never derived from the
 * value; the grant, the scheme and the host are re-checked here on every request. Plaintext exists only here, in the
 * outbound handler, and, where the owner turned on reading for a workspace, in that workspace's commands.
 */

import { Effect } from 'effect';
import * as v from 'valibot';
import { settle } from '../obs/effect';
import { KinuError } from '../obs/index';
import type { CredentialCipher } from '../credentials/envelope';
import type { SqlExec } from '../types/primitives';
import { nanoid } from '../utils/nanoid';
import {
  EGRESS_PLACEHOLDER_PREFIX,
  PLACEHOLDER_BODY_LENGTH,
  isEgressPlaceholder,
  isSecretName,
  planEgress,
  type EgressRequestFacts,
  type EgressSecretBinding,
  type SecretPosition,
} from './egress-gate';

/** A hostname, or one under a domain as `*.example.com`: a wildcard anywhere else (`api.*`, a bare `*`) would let a
 *  program name a host of its own choosing and have the secret sent there. */
const HOST_RE = /^(?:\*\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+$/;

/** A header a secret may ride in: a field name, and none whose meaning is not a credential's to carry. */
const HEADER_NAME_RE = /^[A-Za-z0-9-]{1,64}$/;

const QUERY_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;

/** Headers a secret never rides in: the request's own routing and framing, and Authorization, which is its own position. */
const NOT_A_CREDENTIAL_HEADER: ReadonlySet<string> = new Set(['host', 'authorization', 'content-length', 'content-type', 'transfer-encoding', 'connection']);

/**
 * The stored form of a position, `authorization`, `header:<name>` or `query:<name>`, read and written only here. One
 * column, so no stored state means nothing (Authorization with a name).
 */
const PositionSchema = v.pipe(v.string(), v.rawTransform(({ dataset, addIssue, NEVER }): SecretPosition => {
  const [kind, name = ''] = dataset.value.split(/:(.*)/s, 2);

  if (kind === 'authorization' && name === '') return { kind: 'authorization' };

  if (kind === 'header' && HEADER_NAME_RE.test(name)) return { kind: 'header', name };

  if (kind === 'query' && QUERY_NAME_RE.test(name)) return { kind: 'query', name };
  addIssue({ message: `"${dataset.value}" is no secret position` });

  return NEVER;
}));

function storedPosition(position: SecretPosition): string {
  return position.kind === 'authorization' ? 'authorization' : `${position.kind}:${position.kind === 'header' ? position.name.toLowerCase() : position.name}`;
}

/** A secret as the owner's Settings lists it: never its value or placeholder. */
export interface SecretSummary {
  readonly name: string;
  readonly hosts: readonly string[];
  readonly position: SecretPosition;
  readonly updatedAt: number;
  readonly grants: readonly SecretGrant[];
}

/** The owner's consent for one workspace; `reveal` lets its agents read the value itself. */
interface SecretGrant {
  readonly workspace: string;
  /** The workspace's own title, as the owner's roster shows it. */
  readonly title: string;
  readonly reveal: boolean;
}

export interface SecretInput {
  readonly name: string;
  readonly hosts: readonly string[];
  readonly position: SecretPosition;
  readonly value: string;
}

/** Where a secret may go: its hosts, and its one position in a request to them. */
export interface SecretDestination {
  readonly hosts: readonly string[];
  readonly position: SecretPosition;
}

/** A workspace's own view: what it may use, with placeholders, and how many of the owner's secrets it may not. */
export interface GrantedSecrets {
  readonly granted: readonly (EgressSecretBinding & { readonly reveal: boolean })[];
  readonly withheld: number;
}

/** `substitutions` carries plaintext: substitution is positional inside a request this object does not own. */
export type EgressInjectionResult =
  | { readonly kind: 'forward'; readonly substitutions: readonly EgressInjection[] }
  | { readonly kind: 'refuse'; readonly status: number; readonly reason: string };

export interface EgressInjection {
  readonly placeholder: string;
  readonly secret: string;
}

/** `aad` binds a ciphertext to one secret in one user's store. */
export interface EgressVaultDeps {
  readonly sql: SqlExec;
  readonly cipher: CredentialCipher;
  readonly aad: (name: string) => string;
}

export function initEgressVaultTables(sql: SqlExec): void {
  // `placeholder` UNIQUE is load-bearing: a shared placeholder would spend one secret where another was granted.
  sql.exec(`
    CREATE TABLE IF NOT EXISTS user_secrets (
      name        TEXT PRIMARY KEY,
      hosts       TEXT NOT NULL,
      position    TEXT NOT NULL,
      placeholder TEXT NOT NULL UNIQUE,
      secret      TEXT NOT NULL,
      updated_at  INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
    )
  `);
  sql.exec(`
    CREATE TABLE IF NOT EXISTS user_secret_grants (
      workspace TEXT NOT NULL,
      name      TEXT NOT NULL,
      reveal    INTEGER NOT NULL DEFAULT 0 CHECK (reveal IN (0, 1)),
      PRIMARY KEY (workspace, name)
    )
  `);
}

/**
 * The computer's own git, pointed at the GitHub connection for github.com by a helper given in the environment
 * (`GIT_CONFIG_*`, git 2.31+), so no file holds it. Git asks it only for a repository that needs a sign-in, and sends
 * its answer as Basic's password; with no connection it says so, rather than git's "could not read Username".
 */
const GIT_CREDENTIAL_ENVIRONMENT = {
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'credential.https://github.com.helper',
  GIT_CONFIG_VALUE_0: '!f() { test "$1" = get || return 0; if [ -z "$KINU_GITHUB_TOKEN" ]; then '
    + 'echo "Kinu: GitHub is not connected to this account, or not signed in. Connect it in Settings > Connections, then run git again." >&2; '
    + 'return 1; fi; echo username=x-access-token; echo "password=$KINU_GITHUB_TOKEN"; }; f',
} as const;

/**
 * The variables beyond the secrets' own that an owner's command gets: the computer's git helper, always, and
 * `GIT_TOKEN` for Nimbus's git, which sends it unasked, only while the GitHub connection holds a token and the owner
 * granted no `GIT_TOKEN` of their own.
 */
export function connectionEnvironment(granted: GrantedSecrets['granted']): typeof GIT_CREDENTIAL_ENVIRONMENT & { GIT_TOKEN?: string } {
  const connection = granted.find((secret) => secret.name === 'KINU_GITHUB_TOKEN');

  if (connection === undefined || granted.some((secret) => secret.name === 'GIT_TOKEN')) return GIT_CREDENTIAL_ENVIRONMENT;

  return { ...GIT_CREDENTIAL_ENVIRONMENT, GIT_TOKEN: connection.placeholder };
}

/** Names a connection's credential takes in every workspace (`KINU_GITHUB_TOKEN`, the GitHub connection's): no owner
 *  secret may take one. */
const RESERVED_SECRET_NAMES: ReadonlySet<string> = new Set(['KINU_GITHUB_TOKEN']);

/** Independent of the secret by construction. */
export function mintEgressPlaceholder(): string {
  return `${EGRESS_PLACEHOLDER_PREFIX}${nanoid(PLACEHOLDER_BODY_LENGTH)}`;
}

const SecretRowSchema = v.object({ name: v.string(), hosts: v.string(), position: PositionSchema, updated_at: v.number() });

const GrantRowSchema = v.object({ workspace: v.string(), title: v.string(), name: v.string(), reveal: v.number() });

const BindingRowSchema = v.object({ name: v.string(), hosts: v.string(), position: PositionSchema, placeholder: v.string(), reveal: v.number() });

/** Every secret and where it is granted, no secret material. */
export function listSecrets(sql: SqlExec): SecretSummary[] {
  // A grant's workspace is registered: a grant needs one, and a workspace's removal takes its grants.
  const grants = sql.exec(
    `SELECT g.workspace, w.display_name AS title, g.name, g.reveal FROM user_secret_grants g
       JOIN user_workspaces w ON w.name = g.workspace ORDER BY w.display_name`,
  ).toArray().map((row) => v.parse(GrantRowSchema, row));

  return sql.exec(`SELECT name, hosts, position, updated_at FROM user_secrets ORDER BY name`).toArray().map((row) => {
    const secret = v.parse(SecretRowSchema, row);

    return {
      name: secret.name,
      hosts: secret.hosts.split(' '),
      position: secret.position,
      updatedAt: secret.updated_at,
      grants: grants.filter((grant) => grant.name === secret.name).map((grant) => ({ workspace: grant.workspace, title: grant.title, reveal: grant.reveal === 1 })),
    };
  });
}

function validHosts(name: string, hosts: readonly string[]): Effect.Effect<string, KinuError> {
  return Effect.gen(function* () {
    const normalized = [...new Set(hosts.map((host) => host.trim().toLowerCase()).filter((host) => host !== ''))];

    if (normalized.length === 0) return yield* new KinuError('bad_input', `${name} needs at least one host it may be sent to.`);
    const wrong = normalized.find((host) => !HOST_RE.test(host));

    if (wrong !== undefined) {
      return yield* new KinuError('bad_input', `"${wrong}" is not a host ${name} can be sent to: write a hostname such as `
        + 'api.example.com, or *.example.com for every host under a domain, with no scheme, port or path.');
    }

    return normalized.join(' ');
  });
}

/** `position` as stored, once it names a place a credential can ride; refused in the owner's words otherwise. */
function validPosition(name: string, position: SecretPosition): Effect.Effect<string, KinuError> {
  if (position.kind === 'header' && (!HEADER_NAME_RE.test(position.name) || NOT_A_CREDENTIAL_HEADER.has(position.name.toLowerCase()))) {
    return Effect.fail(new KinuError('bad_input', `"${position.name}" is not a header ${name} can be sent in: name the header its API `
      + 'reads a key from, such as X-API-Key, or choose the Authorization header.'));
  }

  if (position.kind === 'query' && !QUERY_NAME_RE.test(position.name)) {
    return Effect.fail(new KinuError('bad_input', `"${position.name}" is not a query parameter ${name} can be sent in: name it as its API does, such as key.`));
  }

  return Effect.succeed(storedPosition(position));
}

function registered(sql: SqlExec, workspaces: readonly string[]): Effect.Effect<void, KinuError> {
  return Effect.gen(function* () {
    for (const workspace of workspaces) {
      if (sql.exec(`SELECT 1 FROM user_workspaces WHERE name = ?`, workspace).toArray().length === 0) {
        return yield* new KinuError('missing', `There is no workspace "${workspace}" in this account.`);
      }
    }
  });
}

/**
 * Add or replace secrets, all or none, and grant them to `grantTo` (an existing grant keeps its reading switch).
 * Replacing keeps the placeholder, so rotation reaches every workspace with nothing to restart. Returns the workspaces
 * whose secrets moved.
 */
export function putSecrets(deps: EgressVaultDeps, entries: readonly SecretInput[], grantTo: readonly string[]): Promise<string[]> {
  return settle(Effect.gen(function* () {
    if (entries.length === 0) return yield* new KinuError('bad_input', 'Add at least one secret.');
    const names = new Set<string>();
    const rows: { name: string; hosts: string; position: string }[] = [];

    for (const entry of entries) {
      if (!isSecretName(entry.name)) {
        return yield* new KinuError('bad_input', `"${entry.name}" cannot name a secret: use letters, digits and _, not starting `
          + 'with a digit, as an environment variable is named.');
      }

      if (RESERVED_SECRET_NAMES.has(entry.name) || entry.name.startsWith('GIT_CONFIG_')) {
        return yield* new KinuError('bad_input', `"${entry.name}" is Kinu's own: it carries a connection's credential, or points git at one. `
          + 'Name this secret otherwise.');
      }

      if (names.has(entry.name)) return yield* new KinuError('bad_input', `${entry.name} is listed twice.`);
      names.add(entry.name);

      if (entry.value.length === 0) return yield* new KinuError('bad_input', `${entry.name} has no value.`);

      if (isEgressPlaceholder(entry.value)) return yield* new KinuError('bad_input', `${entry.name}'s value is a placeholder, not a secret.`);
      rows.push({ name: entry.name, hosts: yield* validHosts(entry.name, entry.hosts), position: yield* validPosition(entry.name, entry.position) });
    }

    yield* registered(deps.sql, grantTo);
    const sealed = yield* Effect.promise(() => Promise.all(entries.map((entry) => deps.cipher.seal(deps.aad(entry.name), entry.value))));

    // No await from here: every row lands in one turn of the object, or none does.
    for (const [index, row] of rows.entries()) {
      deps.sql.exec(
        `INSERT INTO user_secrets (name, hosts, position, placeholder, secret) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET hosts = excluded.hosts, position = excluded.position, secret = excluded.secret,
           updated_at = unixepoch() * 1000`,
        row.name, row.hosts, row.position, mintEgressPlaceholder(), sealed[index],
      );

      for (const workspace of grantTo) {
        deps.sql.exec(`INSERT INTO user_secret_grants (workspace, name) VALUES (?, ?) ON CONFLICT DO NOTHING`, workspace, row.name);
      }
    }

    return grantedWorkspaces(deps.sql, [...names]);
  }));
}

/** The workspaces holding any of `names`. */
function grantedWorkspaces(sql: SqlExec, names: readonly string[]): string[] {
  const workspaces = new Set<string>();

  for (const name of names) {
    for (const row of sql.exec(`SELECT workspace FROM user_secret_grants WHERE name = ?`, name).toArray()) {
      workspaces.add(v.parse(v.object({ workspace: v.string() }), row).workspace);
    }
  }

  return [...workspaces];
}

function known(sql: SqlExec, name: string): Effect.Effect<void, KinuError> {
  return sql.exec(`SELECT 1 FROM user_secrets WHERE name = ?`, name).toArray().length > 0
    ? Effect.void
    : Effect.fail(new KinuError('missing', `There is no secret named ${name}.`));
}

/** Where `name` may go, replaced: its hosts and its position; returns the workspaces whose secrets moved. */
export function setSecretDestination(sql: SqlExec, name: string, destination: SecretDestination): Promise<string[]> {
  return settle(Effect.gen(function* () {
    yield* known(sql, name);
    const hosts = yield* validHosts(name, destination.hosts);
    const position = yield* validPosition(name, destination.position);
    sql.exec(`UPDATE user_secrets SET hosts = ?, position = ?, updated_at = unixepoch() * 1000 WHERE name = ?`, hosts, position, name);

    return grantedWorkspaces(sql, [name]);
  }));
}

/** The secret and every grant of it; returns the workspaces that held it. A later request naming it is refused. */
export function deleteSecret(sql: SqlExec, name: string): Promise<string[]> {
  return settle(Effect.gen(function* () {
    yield* known(sql, name);
    const held = grantedWorkspaces(sql, [name]);
    sql.exec(`DELETE FROM user_secret_grants WHERE name = ?`, name);
    sql.exec(`DELETE FROM user_secrets WHERE name = ?`, name);

    return held;
  }));
}

/** Grant `name` to `workspace`, or change whether its agents may read the value. */
export function grantSecret(sql: SqlExec, input: { readonly name: string; readonly workspace: string; readonly reveal: boolean }): Promise<void> {
  return settle(Effect.gen(function* () {
    yield* known(sql, input.name);
    yield* registered(sql, [input.workspace]);
    sql.exec(
      `INSERT INTO user_secret_grants (workspace, name, reveal) VALUES (?, ?, ?)
       ON CONFLICT(workspace, name) DO UPDATE SET reveal = excluded.reveal`,
      input.workspace, input.name, input.reveal ? 1 : 0,
    );
  }));
}

/** Whether a grant went away. */
export function revokeSecretGrant(sql: SqlExec, input: { readonly name: string; readonly workspace: string }): boolean {
  return sql.exec(`DELETE FROM user_secret_grants WHERE workspace = ? AND name = ? RETURNING name`, input.workspace, input.name).toArray().length > 0;
}

function bindings(sql: SqlExec, workspace: string): (EgressSecretBinding & { readonly reveal: boolean })[] {
  return sql.exec(
    `SELECT s.name, s.hosts, s.position, s.placeholder, g.reveal FROM user_secret_grants g JOIN user_secrets s ON s.name = g.name
      WHERE g.workspace = ? ORDER BY s.name`,
    workspace,
  ).toArray().map((row) => {
    const binding = v.parse(BindingRowSchema, row);

    return { name: binding.name, hosts: binding.hosts.split(' '), position: binding.position, placeholder: binding.placeholder, reveal: binding.reveal === 1 };
  });
}

/**
 * A secret an account's connection holds rather than the vault (the GitHub connection's token, as `GIT_TOKEN`): bound
 * as a granted one is, to every workspace of the account, and opened from the connection at each request. A secret the
 * owner granted under the same name stands in its place.
 */
export interface ConnectionSecret {
  readonly binding: EgressSecretBinding;
  /** Its value as the connection holds it now; null once the connection is gone. */
  readonly open: () => Promise<string | null>;
  /** Why a request carrying it was refused once the connection is gone, in words the program can act on. */
  readonly gone: string;
}

export function grantedSecrets(sql: SqlExec, workspace: string, connections: readonly EgressSecretBinding[] = []): GrantedSecrets {
  const granted = bindings(sql, workspace);
  const all = v.parse(v.object({ count: v.number() }), sql.exec(`SELECT count(*) AS count FROM user_secrets`).toArray()[0]).count;
  const named = new Set(granted.map((binding) => binding.name));

  return { granted: [...granted, ...connections.filter((binding) => !named.has(binding.name)).map((binding) => ({ ...binding, reveal: false }))], withheld: all - granted.length };
}

/** The values `workspace`'s agents may read, by name; asked for each command, never kept. */
export function revealedSecrets(deps: EgressVaultDeps, workspace: string): Promise<Record<string, string>> {
  return settle(Effect.gen(function* () {
    const revealed: Record<string, string> = {};

    for (const binding of bindings(deps.sql, workspace)) {
      if (binding.reveal) revealed[binding.name] = yield* open(deps, binding.name);
    }

    return revealed;
  }));
}

const SecretRow = v.object({ secret: v.string() });

function open(deps: EgressVaultDeps, name: string): Effect.Effect<string> {
  return Effect.gen(function* () {
    const row = v.parse(SecretRow, deps.sql.exec(`SELECT secret FROM user_secrets WHERE name = ?`, name).toArray()[0]);

    return yield* Effect.promise(() => deps.cipher.open(deps.aad(name), row.secret));
  });
}

/**
 * Decide one intercepted request for `workspace` and open only the secrets it may spend: the owner's grants to that
 * workspace as they stand, the scheme and the destination, on every request.
 */
export function resolveEgressInjection(
  deps: EgressVaultDeps,
  facts: EgressRequestFacts,
  workspace: string,
  connections: readonly ConnectionSecret[] = [],
): Promise<EgressInjectionResult> {
  return settle(Effect.gen(function* () {
    const granted = bindings(deps.sql, workspace);
    const named = new Set(granted.map((binding) => binding.name));
    const held = new Map(connections.filter((secret) => !named.has(secret.binding.name)).map((secret) => [secret.binding.placeholder, secret]));
    const plan = planEgress(facts, [...granted, ...[...held.values()].map((secret) => secret.binding)]);

    if (plan.kind === 'refuse') return plan;
    const substitutions: EgressInjection[] = [];

    for (const { name, placeholder } of plan.substitutions) {
      const connection = held.get(placeholder);

      if (connection === undefined) {
        substitutions.push({ placeholder, secret: yield* open(deps, name) });
        continue;
      }

      const secret = yield* Effect.promise(connection.open);

      if (secret === null) return { kind: 'refuse', status: 403, reason: connection.gone };
      substitutions.push({ placeholder, secret });
    }

    return { kind: 'forward', substitutions };
  }));
}
