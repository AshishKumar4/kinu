import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, test } from 'bun:test';
import { initUserTables } from '../src/state/user-schema';
import { SlateConsentStore } from '../src/slates';
import type { SlateConsent } from '../src/slates/share-modes';
import { makeSqlExec } from './helpers';

const databases: Database[] = [];

afterEach(() => {
  for (const database of databases) database.close();
  databases.length = 0;
});

function fixture() {
  const database = new Database(':memory:');
  databases.push(database);
  const sql = makeSqlExec(database);
  initUserTables(sql);

  return { database, sql, store: new SlateConsentStore(sql) };
}

const CONSENT: SlateConsent = {
  workspace: 'owner-workspace', slate: 'issues', server: 'mcp.github', root: { repo: 'kinu', owner: 'viewer' },
  tools: ['list_issues'], effects: false, revision: 'source-a',
};

describe('a viewer account\'s slate consents', () => {
  test('a slate without a consent has no rows and no matching grant', () => {
    const { store } = fixture();

    expect(store.forSlate(CONSENT.workspace, CONSENT.slate)).toEqual([]);
    expect(store.find(CONSENT.workspace, CONSENT.slate, CONSENT.server, CONSENT.root)).toBeNull();
    expect(store.withdraw(CONSENT.workspace, CONSENT.slate, CONSENT.server, CONSENT.root)).toBe(false);
  });

  test('stores the canonical root, JSON tool array and integer effect bit, and reads the consent back', () => {
    const { database, store } = fixture();
    store.put({ ...CONSENT, effects: true });

    expect(database.query('SELECT root, tools, effects FROM slate_consents').get()).toEqual({ root: '{"owner":"viewer","repo":"kinu"}', tools: '["list_issues"]', effects: 1 });
    expect(store.find(CONSENT.workspace, CONSENT.slate, CONSENT.server, { owner: 'viewer', repo: 'kinu' })).toEqual({ ...CONSENT, effects: true });
    expect(store.forSlate(CONSENT.workspace, CONSENT.slate)).toEqual([{ ...CONSENT, effects: true }]);
  });

  test('the latest consent for a canonical key replaces tools, effects and revision, including narrowing to nothing', () => {
    const { database, store } = fixture();
    store.put({ ...CONSENT, effects: true, tools: ['list_issues', 'create_issue'] });
    const replacement = { ...CONSENT, root: { owner: 'viewer', repo: 'kinu' }, tools: [], revision: 'source-b' };
    store.put(replacement);

    expect(database.query('SELECT COUNT(*) AS n FROM slate_consents').get()).toEqual({ n: 1 });
    expect(store.find(CONSENT.workspace, CONSENT.slate, CONSENT.server, CONSENT.root)).toEqual(replacement);
  });

  test('workspace, slate, server and root each isolate a consent', () => {
    const { store } = fixture();
    const otherRoot = { ...CONSENT, root: { owner: 'viewer', repo: 'another' } };
    const otherServer = { ...CONSENT, server: 'mcp.gitlab' };

    for (const consent of [CONSENT, { ...CONSENT, workspace: 'other' }, { ...CONSENT, slate: 'other' }, otherRoot, otherServer]) store.put(consent);

    expect(store.forSlate(CONSENT.workspace, CONSENT.slate)).toEqual([otherRoot, CONSENT, otherServer]);
    expect(store.forSlate('other', CONSENT.slate)).toEqual([{ ...CONSENT, workspace: 'other' }]);
    expect(store.find(CONSENT.workspace, CONSENT.slate, CONSENT.server, {})).toBeNull();
  });

  test('withdrawal takes only the named canonical key, once', () => {
    const { store } = fixture();
    store.put(CONSENT);
    store.put({ ...CONSENT, server: 'ai', root: {} });

    expect(store.withdraw(CONSENT.workspace, CONSENT.slate, CONSENT.server, { owner: 'viewer', repo: 'kinu' })).toBe(true);
    expect(store.withdraw(CONSENT.workspace, CONSENT.slate, CONSENT.server, CONSENT.root)).toBe(false);
    expect(store.find(CONSENT.workspace, CONSENT.slate, CONSENT.server, CONSENT.root)).toBeNull();
    expect(store.forSlate(CONSENT.workspace, CONSENT.slate)).toEqual([{ ...CONSENT, server: 'ai', root: {} }]);
  });

  test('a fresh store reads the durable row without any in-memory grant', () => {
    const { sql, store } = fixture();
    store.put(CONSENT);

    expect(new SlateConsentStore(sql).forSlate(CONSENT.workspace, CONSENT.slate)).toEqual([CONSENT]);
  });
});
