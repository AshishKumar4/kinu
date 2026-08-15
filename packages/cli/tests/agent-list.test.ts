import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { reconcileAgentRefs } from '../src/agent-list.js';
import * as v from 'valibot';

const tempDirs: string[] = [];
const repoRoot = resolve(__dirname, '../../..');

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('CLI cloud agent registry sync', () => {
  test('merges local and server workspaces while dropping stale cloud refs', () => {
    const reconciled = reconcileAgentRefs(
      ['localbot', 'localbot'],
      [
        {
          name: 'localbot',
          mode: 'local',
          displayName: 'Local Bot',
          localName: 'localbot',
          createdAt: '2026-06-08T00:00:00.000Z',
          updatedAt: '2026-06-08T00:00:00.000Z',
        },
        {
          name: 'stale',
          mode: 'cloud',
          displayName: 'Stale',
          cloudName: 'stale',
          createdAt: '2026-06-08T00:00:00.000Z',
          updatedAt: '2026-06-08T00:00:00.000Z',
        },
      ],
      [
        { name: 'web-agent', displayName: 'Web Agent', createdAt: 1, lastVisited: 1, archivedAt: null },
        { name: 'web-agent', displayName: 'Web Agent', createdAt: 1, lastVisited: 1, archivedAt: null },
      ],
    );

    expect(reconciled.map(({ name, label, mode }) => ({ name, label, mode }))).toEqual([
      { name: 'localbot', label: 'Local Bot', mode: 'local' },
      { name: 'web-agent', label: 'Web Agent', mode: 'cloud' },
    ]);
    expect(reconciled.some((agent) => agent.name === 'stale')).toBeFalse();
  });

  test('uses the cloud agent list as the source of truth for cloud refs', () => {
    const home = mkdtempSync(join(tmpdir(), 'proteus-agent-list-'));
    tempDirs.push(home);
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'config.json'), JSON.stringify({
      origin: 'https://proteus.test',
      accessToken: 'ptc_0123456789abcdef0123456789abcdef_abcdefghijklmnopqrstuvwxyz',
      agents: {
        stale: {
          name: 'stale',
          mode: 'cloud',
          displayName: 'Stale',
          cloudName: 'stale',
          createdAt: '2026-06-08T00:00:00.000Z',
          updatedAt: '2026-06-08T00:00:00.000Z',
        },
        localbot: {
          name: 'localbot',
          mode: 'local',
          displayName: 'Local Bot',
          localName: 'localbot',
          createdAt: '2026-06-08T00:00:00.000Z',
          updatedAt: '2026-06-08T00:00:00.000Z',
        },
      },
      aliases: { old: 'stale', local: 'localbot' },
    }, null, 2));

    const script = `
      globalThis.fetch = async (input, init) => {
        if (String(input) !== 'https://proteus.test/api/cli/workspaces') throw new Error(String(input));
        if (new Headers(init?.headers).get('authorization') !== 'Bearer ptc_0123456789abcdef0123456789abcdef_abcdefghijklmnopqrstuvwxyz') {
          throw new Error('missing auth');
        }
        return Response.json([
          { name: 'web-agent', displayName: 'Web Agent', createdAt: 1790000000000, lastVisited: 1790000000000, archivedAt: null }
        ]);
      };
      const { syncCloudAgentRefs } = await import('./packages/cli/src/agent-list.ts');
      const { readFileSync } = await import('node:fs');
      const result = await syncCloudAgentRefs();
      const config = JSON.parse(readFileSync('${join(home, 'config.json')}', 'utf8'));
      console.log(JSON.stringify({ result, config }));
    `;
    const proc = Bun.spawnSync({
      cmd: [process.execPath, '-e', script],
      cwd: repoRoot,
      env: { ...process.env, PROTEUS_HOME: home },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(proc.exitCode).toBe(0);
    const parsed = v.parse(v.object({
      result: v.array(v.object({ name: v.string(), mode: v.string(), label: v.string() })),
      config: v.object({
        agents: v.record(v.string(), v.object({ mode: v.string(), displayName: v.optional(v.string()) })),
        aliases: v.optional(v.record(v.string(), v.string())),
      }),
    }), JSON.parse(proc.stdout.toString()));
    expect(parsed.config.agents.stale).toBeUndefined();
    expect(parsed.config.agents['web-agent']).toMatchObject({ mode: 'cloud', displayName: 'Web Agent' });
    expect(parsed.config.agents.localbot).toMatchObject({ mode: 'local', displayName: 'Local Bot' });
    expect(parsed.config.aliases).toEqual({ local: 'localbot' });
    expect(parsed.result.map((agent) => `${agent.name}:${agent.mode}`)).toContain('web-agent:cloud');
  });
});
