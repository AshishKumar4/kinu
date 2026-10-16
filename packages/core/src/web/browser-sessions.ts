/**
 * Chrome sessions agents open on Browser Run, and which actor owns each. Browser Run holds the session; the
 * workspace object holds only the owner, so a program reaches a session through cf-backend's `codemode-egress.ts`
 * only when its actor opened it. Measured 2026-09-28 (kinu-brsess-probe): a session survives the object's eviction
 * and reconnects by id with its page state; Kitesurf sessions end with their connection, so none is recorded here.
 */
import { Effect } from 'effect';
import * as v from 'valibot';
import type { BrowserSessions, BrowserSessionView } from './provider';
import type { RawSqlExec, SqlExec } from '../types/primitives';
import { attempt, KinuError, settle } from '../obs/index';
import { PLATFORM_CATALOG } from '../platform-catalog';

export function initBrowserSessionTable(execRaw: RawSqlExec): void {
  execRaw(`CREATE TABLE IF NOT EXISTS browser_sessions (
    session_id TEXT PRIMARY KEY,
    actor_id   TEXT NOT NULL
  )`);
}

/** A session outlives its programs by as long as Browser Run lets one sit idle. */
const IDLE_LIFETIME_MS = PLATFORM_CATALOG['browser.session.keep_alive_ms'].limit.value;

const OwnedRowSchema = v.object({ session_id: v.string() });

/** The session members of a Worker's browser binding Kinu calls; structural, so core compiles without `BrowserRun`. */
export interface BrowserSessionBinding {
  acquire(options: AcquireOptions): Promise<{ sessionId: string }>;
  getSession(sessionId: string): Promise<object | null>;
  getLiveView(sessionId: string, options: { mode: 'tab' }): Promise<{ devtoolsFrontendUrl: string }>;
  closeSession(sessionId: string): Promise<{ status: string }>;
}

/** `lab` is accepted by acquire though its type omits it: a lab session lists and runs the page's WebMCP tools (2026-09-28). */
interface AcquireOptions {
  readonly keepAlive: number;
  readonly lab?: true;
}

export function ownsBrowserSession(db: SqlExec, actorId: string, sessionId: string): boolean {
  return db.exec(`SELECT 1 AS x FROM browser_sessions WHERE session_id = ? AND actor_id = ?`, sessionId, actorId).toArray().length > 0;
}

export function browserSessions(input: { readonly db: SqlExec; readonly binding: BrowserSessionBinding; readonly actorId: string }): BrowserSessions {
  const { db, binding, actorId } = input;

  const view = (id: string): Effect.Effect<BrowserSessionView, KinuError> => Effect.map(
    attempt({ doing: `opening the Live View of browser ${id}`, otherwise: 'unavailable' }, () => binding.getLiveView(id, { mode: 'tab' })),
    (live) => ({ id, liveView: live.devtoolsFrontendUrl }),
  );

  const opened = (lab: boolean): Effect.Effect<BrowserSessionView, KinuError> => Effect.gen(function* () {
    const options: AcquireOptions = lab ? { keepAlive: IDLE_LIFETIME_MS, lab: true } : { keepAlive: IDLE_LIFETIME_MS };
    const { sessionId } = yield* attempt({ doing: 'opening a Chrome browser on Browser Run', otherwise: 'unavailable' }, () => binding.acquire(options));
    db.exec(`INSERT INTO browser_sessions (session_id, actor_id) VALUES (?, ?)`, sessionId, actorId);

    return yield* view(sessionId);
  });

  const owned = (): string[] => db.exec(`SELECT session_id FROM browser_sessions WHERE actor_id = ?`, actorId).toArray()
    .map((row) => v.parse(OwnedRowSchema, row).session_id);

  const live = (): Effect.Effect<BrowserSessionView[], KinuError> => Effect.gen(function* () {
    const views: BrowserSessionView[] = [];

    for (const id of owned()) {
      const session = yield* attempt({ doing: `reading browser ${id}`, otherwise: 'unavailable' }, () => binding.getSession(id));

      if (session === null) {
        db.exec(`DELETE FROM browser_sessions WHERE session_id = ?`, id);
        continue;
      }

      views.push(yield* view(id));
    }

    return views;
  });

  const closed = (id: string): Effect.Effect<void, KinuError> => Effect.gen(function* () {
    if (!ownsBrowserSession(db, actorId, id)) return yield* Effect.fail(new KinuError('missing', `no browser ${id} of yours is open`));
    yield* attempt({ doing: `closing browser ${id}`, otherwise: 'unavailable' }, () => binding.closeSession(id));
    db.exec(`DELETE FROM browser_sessions WHERE session_id = ?`, id);
  });

  return {
    open: ({ lab }) => settle(opened(lab)),
    list: () => settle(live()),
    close: (id) => settle(closed(id)),
  };
}
