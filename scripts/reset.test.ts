import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import { scratchDir } from '@kinu.run/test-utils';
import { deployedConfig } from './infra-manifest';
import { LATEST_RESET_KEY, type Reset, ResetSchema, type ResetTarget, type Serving, wipe } from './reset';

const config = deployedConfig('staging');

const [devbox, egress] = (config.containers ?? []).map((container) => container.name);

/** A staging account as a reset meets it: a live build binding two classes, the container applications its classes
 *  run (one deleted only through the REST API, by its 32-hex id), one application of something else, and chains in
 *  the devbox store. `failing` names a call that throws once. */
function account(failing?: keyof ResetTarget) {
  let fail = failing;

  const serving: Serving = { versionId: 'build-version', bound: new Map([['KinuDevbox', 'ns-devbox'], ['CodexEgress', 'ns-egress']]) };

  const placeholders: string[] = [];

  const checkpoints: string[] = [];

  const state = {
    serving,
    applications: [
      { id: 'a'.repeat(32), name: devbox ?? '', namespace: 'ns-devbox' },
      { id: '0b1c2d3e-0000-4000-8000-000000000000', name: egress ?? '', namespace: 'ns-egress' },
      { id: 'c'.repeat(32), name: 'another-worker-box', namespace: 'ns-other' },
    ],
    chains: 3,
    records: new Map<string, Reset>(),
    placeholders,
    sessions: true,
    checkpoints,
  };

  const step = (name: keyof ResetTarget): void => {
    if (fail !== name) return;
    fail = undefined;
    throw new Error(`${name} failed`);
  };

  const target: ResetTarget = {
    serving: () => state.serving,
    applications: () => state.applications,
    latest: () => state.records.get(LATEST_RESET_KEY),
    deployPlaceholder: (classes, tag) => {
      step('deployPlaceholder');
      state.placeholders.push(`${tag}: ${classes.join(', ')}`);
      state.serving = { versionId: `placeholder-${String(state.placeholders.length)}`, bound: new Map() };

      return state.serving.versionId;
    },
    deleteApplication: (application) => {
      step('deleteApplication');
      state.applications = state.applications.filter((each) => each.id !== application.id);
    },
    deleteChains: async () => {
      step('deleteChains');
      const deleted = state.chains;

      state.chains = 0;

      return deleted;
    },
    putRecord: (key, file) => {
      step('putRecord');
      state.records.set(key, v.parse(ResetSchema, JSON.parse(readFileSync(file, 'utf8'))));
    },
    stampless: async () => state.serving.bound.size === 0,
    forgetSessions: () => {
      state.sessions = false;
    },
    checkpoint: (taken) => {
      step('checkpoint');
      state.checkpoints.push(`${taken} with ${String(state.placeholders.length)} placeholder(s)`);
    },
  };

  return { state, target };
}

const recordFile = join(scratchDir('reset'), 'record.json');

describe('a reset stopped anywhere can be finished', () => {
  // 2026-09-30: a staging reset stopped with its placeholder up and two applications deleted, wrote no record and no
  // barrier, kept the eval sessions, and its rerun refused the placeholder.
  test('stopped after its placeholder, it leaves its record and barrier started, and a rerun finishes it', async () => {
    const { state, target } = account('deleteApplication');
    const input = { environment: 'staging' as const, config, recordFile, restToken: 'a-rest-token', target };

    await expect(wipe(input)).rejects.toThrow('deleteApplication failed');

    const started = state.records.get(LATEST_RESET_KEY);

    expect(started?.state).toBe('started');
    expect(started?.placeholderVersion).toBe('placeholder-1');
    expect(state.records.get(`resets/${started?.tag ?? ''}.json`)).toEqual(started);
    expect(state.sessions).toBe(false);
    expect(state.applications).toHaveLength(3);

    const done = await wipe(input);

    expect([done.tag, done.state, done.placeholderVersion, done.chains?.objects]).toEqual([started?.tag, 'done', 'placeholder-1', 3]);
    expect(state.placeholders).toEqual([`${started?.tag ?? ''}: KinuDevbox, CodexEgress`]);
    expect(state.applications.map((application) => application.name)).toEqual(['another-worker-box']);
    expect(state.records.get(LATEST_RESET_KEY)).toEqual(done);
    expect(state.records.get(`resets/${done.tag}.json`)).toEqual(done);
    expect(v.parse(ResetSchema, JSON.parse(readFileSync(recordFile, 'utf8')))).toEqual(done);

    // A deploy whose upload failed after the reset runs it again: it is done, so nothing more is deleted or uploaded.
    expect(await wipe(input)).toEqual(done);
    expect(state.placeholders).toHaveLength(1);
    // Taken before the placeholder deleted them; each resumed run checks what its restore is owed instead.
    expect(state.checkpoints).toEqual(['capture with 0 placeholder(s)', 'owed with 1 placeholder(s)', 'owed with 1 placeholder(s)']);
  });

  test('a reset that cannot take eval-service\'s credentials deletes and records nothing', async () => {
    const { state, target } = account('checkpoint');

    await expect(wipe({ environment: 'staging', config, recordFile, restToken: 'a-rest-token', target })).rejects.toThrow('checkpoint failed');
    expect([state.placeholders, state.records.size, state.applications.length, state.sessions]).toEqual([[], 0, 3, true]);
  });

  // The placeholder IS the first deletion: wrangler can report a failure for an upload the platform applied, so the
  // barrier is up before it, and stays up until a reset finishes.
  test('a placeholder upload that fails leaves the barrier started, and a rerun resets afresh', async () => {
    const { state, target } = account('deployPlaceholder');
    const input = { environment: 'staging' as const, config, recordFile, restToken: 'a-rest-token', target };

    await expect(wipe(input)).rejects.toThrow('deployPlaceholder failed');

    const barrier = state.records.get(LATEST_RESET_KEY);

    expect([barrier?.state, barrier?.placeholderVersion, state.placeholders.length]).toEqual(['started', '', 0]);

    const done = await wipe(input);

    expect([done.state, state.placeholders.length, state.records.get(LATEST_RESET_KEY)]).toEqual(['done', 1, done]);
  });

  test('a missing REST token is refused before anything is deleted or recorded', async () => {
    const { state, target } = account();

    await expect(wipe({ environment: 'staging', config, recordFile, restToken: '', target }))
      .rejects.toThrow('no REST token is set (KINU_CLOUDFLARE_API_TOKEN); nothing was deleted');
    expect([state.placeholders, state.records.size, state.applications.length, state.sessions]).toEqual([[], 0, 3, true]);
  });

  test('a placeholder no reset record names is refused', async () => {
    const { state, target } = account();

    state.serving = { versionId: 'an-unrecorded-placeholder', bound: new Map() };
    await expect(wipe({ environment: 'staging', config, recordFile, restToken: 'a-rest-token', target }))
      .rejects.toThrow('binds no class, as a reset placeholder does, and no reset record names it');
    expect(state.applications).toHaveLength(3);
  });
});
