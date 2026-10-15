// The GitHub reader check decides by what a connection is: a server anyone named GitHub never mints a reader, on the
// holder's side or the reader's, and an answer that only echoes the query reads as no.
import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import type { SerializableToolDescriptor } from '../src/tools/mcp-surface';
import { initSlateRoomTables, RoomCaretaker } from '../src/slates/room/caretaker';
import { canonicalRoot, flows } from '../src/slates/room/labels';
import { planReaderCheck, READER_CHECK_LIFETIME_MS, searchFindsRepository } from '../src/slates/room/reader-check';
import { makeExecRaw, makeSqlExec } from './helpers';

const SEARCH = 'search_repositories';

const preset = (serverId: string): SerializableToolDescriptor => ({
  serverId, serverName: 'GitHub', name: SEARCH, toolKey: `GitHub__${SEARCH}`, presetId: 'github',
});

/** A custom server its owner named GitHub, at an address of their own, answering the same tool. */
const namesake = (serverId: string): SerializableToolDescriptor => ({ serverId, serverName: 'GitHub', name: SEARCH, toolKey: `GitHub__${SEARCH}` });

const repoTag = { server: 'mcp.GitHub', root: canonicalRoot({ owner: 'acme', repo: 'secret' }) };

test('a reader whose only GitHub is a namesake has nothing to check with', () => {
  expect(planReaderCheck(repoTag, [preset('alice-gh')], [namesake('bob-fake')])).toEqual({ kind: 'no-connection' });
});

test('a holder whose GitHub is a namesake holds no repository a check can vouch for', () => {
  expect(planReaderCheck(repoTag, [namesake('alice-fake')], [preset('bob-gh')])).toEqual({ kind: 'unsupported' });
});

test('both sides on the GitHub preset: the reader asks with their own preset connection', () => {
  expect(planReaderCheck(repoTag, [preset('alice-gh')], [namesake('bob-fake'), preset('bob-gh')]))
    .toEqual({ kind: 'ask', tool: preset('bob-gh'), owner: 'acme', repo: 'secret' });
});

test('only an exact repository in the search items reads as yes', () => {
  expect(searchFindsRepository(JSON.stringify({ items: [{ full_name: 'Acme/Secret' }] }), 'acme', 'secret')).toBe(true);
  expect(searchFindsRepository(JSON.stringify({ items: [{ full_name: 'acme/secret-old' }] }), 'acme', 'secret')).toBe(false);
  expect(searchFindsRepository('No results for repo:acme/secret', 'acme', 'secret')).toBe(false);
  expect(searchFindsRepository(JSON.stringify({ message: 'repo:acme/secret is not visible' }), 'acme', 'secret')).toBe(false);
});

test('a check\'s yes lapses: the part is hidden again until the reader is checked anew', () => {
  let now = 1_000_000;
  const db = new Database(':memory:');

  initSlateRoomTables(makeExecRaw(db));
  const room = new RoomCaretaker({ db: makeSqlExec(db), now: () => now });
  const elem = { holder: 'alice@acme.dev', ...repoTag, fn: 'prs', image: 'img-1' };

  room.create({ workspace: 'sam', slate: 'board', title: 'Board', owner: 'sam@acme.dev', parent: null });
  room.checked('bob@acme.dev', elem, true);
  expect(flows(room.facts(), [elem], 'bob@acme.dev')).toBe(true);

  now += READER_CHECK_LIFETIME_MS;
  expect(flows(room.facts(), [elem], 'bob@acme.dev')).toBe(false);

  room.checked('bob@acme.dev', elem, true);
  expect(flows(room.facts(), [elem], 'bob@acme.dev')).toBe(true);
});
