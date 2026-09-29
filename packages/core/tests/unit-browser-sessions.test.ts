/**
 * A browser session belongs to the agent that opened it: another agent can neither close it nor, through
 * `ownsBrowserSession`, reach its socket; and a session Browser Run has ended leaves the agent's list.
 */
import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { browserSessions, initBrowserSessionTable, ownsBrowserSession, type BrowserSessionBinding } from '../src/index';
import { makeExecRaw, makeSqlExec } from './helpers';

/** Browser Run as a stub: sessions it holds, and what it was asked to close. */
function browserRun() {
  const live = new Set<string>();
  const closed: string[] = [];
  let next = 0;

  const binding: BrowserSessionBinding = {
    acquire: async () => {
      next += 1;
      live.add(`s${next}`);

      return { sessionId: `s${next}` };
    },
    getSession: async (id) => (live.has(id) ? { sessionId: id } : null),
    getLiveView: async (id) => ({ devtoolsFrontendUrl: `https://live.example/${id}` }),
    closeSession: async (id) => {
      closed.push(id);
      live.delete(id);

      return { status: 'closed' };
    },
  };

  return { binding, live, closed };
}

describe('browser sessions', () => {
  test("another agent cannot close or reach a session; its opener can", async () => {
    const database = new Database(':memory:');
    const db = makeSqlExec(database);
    initBrowserSessionTable(makeExecRaw(database));
    const run = browserRun();
    const mine = browserSessions({ db, binding: run.binding, actorId: 'a1' });
    const theirs = browserSessions({ db, binding: run.binding, actorId: 'a2' });

    const opened = await mine.open({ lab: false });

    expect(opened).toEqual({ id: 's1', liveView: 'https://live.example/s1' });
    expect([ownsBrowserSession(db, 'a1', 's1'), ownsBrowserSession(db, 'a2', 's1')]).toEqual([true, false]);
    expect(await theirs.list()).toEqual([]);
    await expect(theirs.close('s1')).rejects.toMatchObject({ code: 'missing' });
    expect(run.closed).toEqual([]);

    await mine.close('s1');

    expect(run.closed).toEqual(['s1']);
    expect(ownsBrowserSession(db, 'a1', 's1')).toBe(false);
  });

  test('a session Browser Run ended, idle past its keep-alive, leaves the list and its owner record', async () => {
    const database = new Database(':memory:');
    const db = makeSqlExec(database);
    initBrowserSessionTable(makeExecRaw(database));
    const run = browserRun();
    const mine = browserSessions({ db, binding: run.binding, actorId: 'a1' });
    await mine.open({ lab: false });
    await mine.open({ lab: true });

    run.live.delete('s1');

    expect((await mine.list()).map((session) => session.id)).toEqual(['s2']);
    expect(ownsBrowserSession(db, 'a1', 's1')).toBe(false);
  });
});
