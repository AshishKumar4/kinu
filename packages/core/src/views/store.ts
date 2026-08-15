/**
 * View storage — the same split the scaffold uses, for the same reasons.
 *
 * Bytes live in the agent VFS (`views/<slug>.json` live, `views/<slug>.json.vN`
 * per version); the ledger lives in one SQL table. No blob column, so the file
 * the renderer reads and the file the agent wrote are the same object, and a
 * version is reverted by copying a file that is still there.
 *
 * Everything a caller can do is here, and everything here validates. There is
 * no way to store a spec that has not been through `parseViewSpec`.
 */

import type { RawSqlExec, SqlExecutor, VFS } from '../types/primitives.js';
import * as v from 'valibot';
import { ensureDir } from '../utils/vfs-helpers.js';
import { VIEW_LIMITS, parseViewSpec, type ViewSpec } from './spec.js';
import { parseJsonValue, type JsonValue } from '../utils/json.js';

export interface ViewStoreDeps {
  vfs: VFS;
  sql: SqlExecutor;
}

export interface AgentViewSummary {
  slug: string;
  title: string;
  subtitle: string | null;
  version: number;
  writtenAt: number;
}

export interface AgentViewVersion {
  slug: string;
  version: number;
  title: string;
  writtenAt: number;
  status: ViewStatus;
}

export type ViewStatus = 'current' | 'historical' | 'deleted';

const ViewStatusSchema = v.picklist(['current', 'historical', 'deleted']);

export type CreateViewResult =
  | { ok: true; slug: string; version: number; action: 'created' | 'updated' }
  | { ok: false; error: string };

export type ReadViewResult =
  | { ok: true; slug: string; version: number; spec: ViewSpec }
  | { ok: false; error: string };

const VIEW_DIR = 'views';
const SLUG_MAX = 40;

export function initViewTables(execRaw: RawSqlExec): void {
  execRaw(`
    CREATE TABLE IF NOT EXISTS agent_views (
      slug       TEXT NOT NULL,
      version    INTEGER NOT NULL,
      title      TEXT NOT NULL,
      subtitle   TEXT,
      written_at INTEGER NOT NULL,
      status     TEXT NOT NULL DEFAULT 'current',
      PRIMARY KEY (slug, version)
    )
  `);
  execRaw(`CREATE INDEX IF NOT EXISTS idx_agent_views_status ON agent_views(status, written_at DESC)`);
}

/** Fold an agent-chosen name into a slug. Mirrors `workspace.createTool`'s
 *  sanitize-then-use rule: the model gets a usable name back rather than an
 *  error it has to guess its way out of. */
export function viewSlug(name: string): string | null {
  const slug = String(name)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX);
  return slug.length > 0 ? slug : null;
}

const livePath = (slug: string): string => `${VIEW_DIR}/${slug}.json`;
const versionPath = (slug: string, version: number): string => `${VIEW_DIR}/${slug}.json.v${version}`;

async function readJson(vfs: VFS, path: string): Promise<JsonValue> {
  const raw = await vfs.readFile(path, { encoding: 'utf8' });
  const text = raw instanceof Uint8Array ? new TextDecoder().decode(raw) : raw;
  return parseJsonValue(text);
}

/**
 * Validate and publish a view. Upsert by slug, like `createTool`.
 *
 * The spec is serialized before it is measured, so the size bound is over the
 * bytes that will actually be stored rather than over whatever the model
 * believed it was sending.
 */
export async function createView<Name, Spec>(
  deps: ViewStoreDeps,
  name: Name,
  rawSpec: Spec,
): Promise<CreateViewResult> {
  const slug = viewSlug(String(name ?? ''));
  if (!slug) return { ok: false, error: 'A view name must contain at least one letter or digit.' };

  // A JSON string is what a model reaches for half the time; accept it rather
  // than failing on a distinction that carries no meaning.
  const encodedSpec = v.safeParse(v.string(), rawSpec);
  let parsed: ReturnType<typeof parseViewSpec>;
  if (encodedSpec.success) {
    try {
      parsed = parseViewSpec(parseJsonValue(encodedSpec.output));
    } catch {
      return { ok: false, error: 'The spec was a string but not valid JSON.' };
    }
  } else {
    parsed = parseViewSpec(rawSpec);
  }
  if (!parsed.ok) return { ok: false, error: parsed.error };

  const serialized = JSON.stringify(parsed.spec);
  if (serialized.length > VIEW_LIMITS.specBytes) {
    return {
      ok: false,
      error: `The spec is ${serialized.length} bytes; the limit is ${VIEW_LIMITS.specBytes}.`,
    };
  }

  const { sql, vfs } = deps;
  const prior = sql<{ version: number }>`
    SELECT MAX(version) AS version FROM agent_views WHERE slug = ${slug}
  `;
  const priorVersion = prior[0]?.version ?? 0;
  const version = priorVersion + 1;
  const writtenAt = Date.now();

  // Bytes first: a ledger row pointing at a file that failed to write would
  // make the tab list disagree with what is renderable.
  await ensureDir(vfs, VIEW_DIR);
  await vfs.writeFile(versionPath(slug, version), serialized);
  await vfs.writeFile(livePath(slug), serialized);

  void sql`UPDATE agent_views SET status = 'historical' WHERE slug = ${slug} AND status = 'current'`;
  void sql`
    INSERT INTO agent_views (slug, version, title, subtitle, written_at, status)
    VALUES (${slug}, ${version}, ${parsed.spec.title}, ${parsed.spec.subtitle ?? null}, ${writtenAt}, 'current')
  `;

  return { ok: true, slug, version, action: priorVersion === 0 ? 'created' : 'updated' };
}

/** The views the UI should show tabs for, oldest first so the strip is stable
 *  as new ones arrive. */
export function listViews(sql: SqlExecutor): AgentViewSummary[] {
  const rows = sql<{ slug: string; title: string; subtitle: string | null; version: number; written_at: number }>`
    SELECT slug, title, subtitle, version, written_at
    FROM agent_views WHERE status = 'current' ORDER BY written_at ASC
  `;
  return rows.map((r) => ({
    slug: r.slug,
    title: r.title,
    subtitle: r.subtitle,
    version: r.version,
    writtenAt: r.written_at,
  }));
}

export function listViewVersions(sql: SqlExecutor, slug: string): AgentViewVersion[] {
  const rows = sql<{ slug: string; version: number; title: string; written_at: number; status: string }>`
    SELECT slug, version, title, written_at, status
    FROM agent_views WHERE slug = ${slug} ORDER BY version DESC
  `;
  return rows.map((r) => ({
    slug: r.slug,
    version: r.version,
    title: r.title,
    writtenAt: r.written_at,
    status: v.parse(ViewStatusSchema, r.status),
  }));
}

/**
 * Read the live spec for rendering.
 *
 * Re-validates. The live file sits on a plane the agent can write through the
 * `file` tool and `workspace.writeFile`, so "it was valid when we stored it" is
 * not a property this function may assume.
 */
export async function readView(deps: ViewStoreDeps, slug: string): Promise<ReadViewResult> {
  const rows = deps.sql<{ version: number }>`
    SELECT version FROM agent_views WHERE slug = ${slug} AND status = 'current'
  `;
  const version = rows[0]?.version;
  if (version === undefined) return { ok: false, error: `No view named "${slug}".` };

  let raw: unknown;
  try {
    raw = await readJson(deps.vfs, livePath(slug));
  } catch (err) {
    return { ok: false, error: `View "${slug}" could not be read: ${errText(err)}` };
  }

  const parsed = parseViewSpec(raw);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  return { ok: true, slug, version, spec: parsed.spec };
}

/** Retire a view. Versions stay on disk and in the ledger: the changelog
 *  offers to put it back, and an audit trail that deletes itself is not one. */
export async function deleteView(
  deps: ViewStoreDeps,
  slug: string,
): Promise<{ ok: boolean; error?: string }> {
  const rows = deps.sql<{ version: number }>`
    SELECT version FROM agent_views WHERE slug = ${slug} AND status = 'current'
  `;
  if (rows.length === 0) return { ok: false, error: `No view named "${slug}".` };

  void deps.sql`UPDATE agent_views SET status = 'deleted' WHERE slug = ${slug} AND status = 'current'`;
  try {
    await deps.vfs.unlink(livePath(slug));
  } catch { /* the ledger is the source of truth for what renders */ }
  return { ok: true };
}

/**
 * Put a view back the way it was before its newest version — the owner-facing
 * undo behind the Evolution Changelog entry.
 *
 * Reverting version 1 deletes the view, because "before version 1" is a
 * workspace that did not have this tab.
 */
export async function revertView(
  deps: ViewStoreDeps,
  slug: string,
): Promise<{ ok: boolean; error?: string; revertedTo?: number }> {
  const rows = deps.sql<{ version: number }>`
    SELECT version FROM agent_views WHERE slug = ${slug} AND status = 'current'
  `;
  const current = rows[0]?.version;
  if (current === undefined) return { ok: false, error: `No live view named "${slug}".` };

  const previous = deps.sql<{ version: number }>`
    SELECT MAX(version) AS version FROM agent_views WHERE slug = ${slug} AND version < ${current}
  `;
  const target = previous[0]?.version ?? null;
  if (target === null) {
    const removed = await deleteView(deps, slug);
    return removed.ok ? { ok: true } : removed;
  }

  let restored: string;
  try {
    const raw = await deps.vfs.readFile(versionPath(slug, target), { encoding: 'utf8' });
    restored = raw instanceof Uint8Array ? new TextDecoder().decode(raw) : raw;
  } catch (err) {
    return { ok: false, error: `Version ${target} of "${slug}" is unreadable: ${errText(err)}` };
  }

  let restoredValue: JsonValue;
  try {
    restoredValue = parseJsonValue(restored);
  } catch (err) {
    return { ok: false, error: `Version ${target} of "${slug}" is not JSON: ${errText(err)}` };
  }
  const parsed = parseViewSpec(restoredValue);
  if (!parsed.ok) return { ok: false, error: `Version ${target} no longer validates: ${parsed.error}` };

  await deps.vfs.writeFile(livePath(slug), restored);
  void deps.sql`UPDATE agent_views SET status = 'historical' WHERE slug = ${slug} AND version = ${current}`;
  void deps.sql`UPDATE agent_views SET status = 'current' WHERE slug = ${slug} AND version = ${target}`;
  return { ok: true, revertedTo: target };
}

function errText<E>(err: E): string {
  return err instanceof Error ? err.message : String(err);
}
