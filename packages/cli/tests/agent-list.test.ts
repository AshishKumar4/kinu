import { mkdtempSync, realpathSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { agentWorkspaceKey, groupAgentWorkspaces, reconcileAgentRefs, type ListedAgent } from '../src/agent-list';
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
        { name: 'web-agent', displayName: 'Web Agent', createdAt: 1 },
        { name: 'web-agent', displayName: 'Web Agent', createdAt: 1 },
      ],
    );

    expect(reconciled.map(({ name, label, mode }) => ({ name, label, mode }))).toEqual([
      { name: 'localbot', label: 'Local Bot', mode: 'local' },
      { name: 'web-agent', label: 'Web Agent', mode: 'cloud' },
    ]);
    expect(reconciled.some((agent) => agent.name === 'stale')).toBeFalse();
  });

  test('reconciled local rows carry their placement metadata through', () => {
    const reconciled = reconcileAgentRefs(
      ['placed'],
      [{
        name: 'placed',
        mode: 'local',
        localName: 'placed',
        cwd: '/repo/shop',
        workspaceId: 'shop',
        createdAt: '2026-06-08T00:00:00.000Z',
        updatedAt: '2026-06-08T00:00:00.000Z',
      }],
      [],
    );
    expect(reconciled).toEqual([{
      name: 'placed',
      label: 'placed',
      mode: 'local',
      localName: 'placed',
      cloudName: undefined,
      cwd: '/repo/shop',
      workspaceId: 'shop',
    }]);
  });

  test('uses the cloud agent list as the source of truth for cloud refs', () => {
    const home = mkdtempSync(join(tmpdir(), 'kinu-agent-list-'));
    tempDirs.push(home);
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'config.json'), JSON.stringify({
      origin: 'https://kinu.test',
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
        if (String(input) !== 'https://kinu.test/api/cli/workspaces') throw new Error(String(input));
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
      env: { ...process.env, KINU_HOME: home },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(proc.exitCode).toBe(0);
    const parsed = v.parse(v.object({
      result: v.object({
        agents: v.array(v.object({ name: v.string(), mode: v.string(), label: v.string() })),
        collisions: v.array(v.looseObject({ name: v.string() })),
      }),
      config: v.object({
        agents: v.record(v.string(), v.object({ mode: v.string(), displayName: v.optional(v.string()) })),
        aliases: v.optional(v.record(v.string(), v.string())),
      }),
    }), JSON.parse(proc.stdout.toString()));
    expect(parsed.config.agents.stale).toBeUndefined();
    expect(parsed.config.agents['web-agent']).toMatchObject({ mode: 'cloud', displayName: 'Web Agent' });
    expect(parsed.config.agents.localbot).toMatchObject({ mode: 'local', displayName: 'Local Bot' });
    expect(parsed.config.aliases).toEqual({ local: 'localbot' });
    expect(parsed.result.agents.map((agent) => `${agent.name}:${agent.mode}`)).toContain('web-agent:cloud');
    // Distinct names, so nothing was contested.
    expect(parsed.result.collisions).toEqual([]);
  });

  test('a cloud workspace whose name a placed local ref holds leaves the placement alone and reports the clash', () => {
    const home = mkdtempSync(join(tmpdir(), 'kinu-agent-list-'));
    const project = realpathSync(mkdtempSync(join(tmpdir(), 'kinu-project-')));
    tempDirs.push(home, project);
    mkdirSync(join(home, 'shopbot'), { recursive: true });
    // `listLocalRefsAllProjects` only counts a ref whose database exists.
    writeFileSync(join(home, 'shopbot', 'agent.db'), '');
    writeFileSync(join(home, 'config.json'), JSON.stringify({
      origin: 'https://kinu.test',
      accessToken: 'ptc_0123456789abcdef0123456789abcdef_abcdefghijklmnopqrstuvwxyz',
      agents: {
        shopbot: {
          name: 'shopbot',
          mode: 'local',
          displayName: 'Shop Bot',
          localName: 'shopbot',
          cwd: project,
          workspaceId: 'shop-floor',
          createdAt: '2026-06-08T00:00:00.000Z',
          updatedAt: '2026-06-08T00:00:00.000Z',
        },
      },
      aliases: { shop: 'shopbot' },
    }, null, 2));

    // The server offers a workspace under the SAME name as the placed local one.
    const script = `
      globalThis.fetch = async () => Response.json([
        { name: 'shopbot', displayName: 'Cloud Shop', createdAt: 1790000000000, lastVisited: 1790000000000, archivedAt: null }
      ]);
      const { syncCloudAgentRefs } = await import('./packages/cli/src/agent-list.ts');
      const { listLocalRefsAllProjects } = await import('./packages/cli/src/config.ts');
      const { readFileSync } = await import('node:fs');
      const result = await syncCloudAgentRefs();
      console.log(JSON.stringify({
        result,
        config: JSON.parse(readFileSync('${join(home, 'config.json')}', 'utf8')),
        placed: listLocalRefsAllProjects(),
      }));
    `;
    const proc = Bun.spawnSync({
      cmd: [process.execPath, '-e', script],
      cwd: repoRoot,
      env: { ...process.env, KINU_HOME: home },
      stdout: 'pipe',
      stderr: 'pipe',
    });

    expect(proc.exitCode).toBe(0);
    const parsed = v.parse(v.object({
      result: v.object({
        agents: v.array(v.looseObject({ name: v.string(), mode: v.string() })),
        collisions: v.array(v.object({
          name: v.string(),
          localName: v.string(),
          cloudDisplayName: v.string(),
        })),
      }),
      config: v.object({
        agents: v.record(v.string(), v.looseObject({
          mode: v.string(),
          displayName: v.optional(v.string()),
          cwd: v.optional(v.string()),
          workspaceId: v.optional(v.string()),
        })),
        aliases: v.optional(v.record(v.string(), v.string())),
      }),
      placed: v.array(v.looseObject({ name: v.string(), workspaceId: v.string() })),
    }), JSON.parse(proc.stdout.toString()));

    // The placement survives byte for byte: mode, directory and workspace.
    expect(parsed.config.agents.shopbot).toMatchObject({
      mode: 'local',
      displayName: 'Shop Bot',
      cwd: project,
      workspaceId: 'shop-floor',
    });
    // So the scheduler's roster still holds it, which is what the mode flip
    // used to destroy: placedRef requires mode 'local'.
    expect(parsed.placed.map((ref) => `${ref.name}@${ref.workspaceId}`)).toEqual(['shopbot@shop-floor']);
    expect(parsed.config.aliases).toEqual({ shop: 'shopbot' });
    // And the clash is reported rather than resolved by overwriting.
    expect(parsed.result.collisions).toEqual([{
      name: 'shopbot',
      localName: 'shopbot',
      cloudDisplayName: 'Cloud Shop',
    }]);
    // One row for that name, and it is the local one.
    expect(parsed.result.agents.filter((agent) => agent.name === 'shopbot').map((a) => a.mode)).toEqual(['local']);
  });
});

describe('virtual workspace grouping', () => {
  const ROOT = '/repo/shop';
  const row = (over: Partial<ListedAgent> & Pick<ListedAgent, 'name' | 'mode'>): ListedAgent => ({
    label: over.name,
    ...over,
  });

  test('peers group by their {cwd, workspaceId} pair; legacy and cloud rows keep their own buckets', () => {
    const grouped = groupAgentWorkspaces([
      row({ name: 'lead', mode: 'local', cwd: ROOT, workspaceId: 'shop' }),
      row({ name: 'writer', mode: 'local', cwd: ROOT, workspaceId: 'docs' }),
      row({ name: 'fixer', mode: 'local', cwd: ROOT, workspaceId: 'shop' }),
      row({ name: 'oldbot', mode: 'local' }),
      row({ name: 'jarvis', mode: 'cloud', cloudName: 'jarvis' }),
      row({ name: 'faraway', mode: 'local', cwd: '/elsewhere/repo', workspaceId: 'other' }),
    ], ROOT);
    expect(grouped.workspaces.map((group) => `${group.cwd}:${group.workspaceId}:${group.agents.map((agent) => agent.name).join('+')}`)).toEqual([
      `${ROOT}:shop:lead+fixer`,
      `${ROOT}:docs:writer`,
      '/elsewhere/repo:other:faraway',
    ]);
    expect(grouped.unplaced.map((agent) => agent.name)).toEqual(['oldbot']);
    expect(grouped.remote.map((agent) => agent.name)).toEqual(['jarvis']);
  });

  test('a placed row without a recorded workspaceId falls back to the directory slug, matching placement', () => {
    expect(agentWorkspaceKey(row({ name: 'a', mode: 'local', cwd: '/repo/My Shop!' }), ROOT))
      .toBe('/repo/My Shop!\u0000my-shop');
    expect(agentWorkspaceKey(row({ name: 'a', mode: 'local' }), ROOT)).toBe('unplaced');
    expect(agentWorkspaceKey(row({ name: 'a', mode: 'cloud' }), ROOT)).toBeNull();
    const grouped = groupAgentWorkspaces([row({ name: 'a', mode: 'local', cwd: ROOT })], ROOT);
    expect(grouped.workspaces).toEqual([{ cwd: ROOT, workspaceId: 'shop', agents: [row({ name: 'a', mode: 'local', cwd: ROOT })] }]);
  });
});

describe('the sidebar roster for one directory', () => {
  test('lists this project, unplaced legacy agents, and cloud refs — never another project, and never merged duplicates', () => {
    const home = mkdtempSync(join(tmpdir(), 'kinu-agent-list-'));
    const projectDir = realpathSync(mkdtempSync(join(tmpdir(), 'kinu-agent-proj-')));
    const otherDir = realpathSync(mkdtempSync(join(tmpdir(), 'kinu-agent-other-')));
    tempDirs.push(home, projectDir, otherDir);
    const stamp = '2026-06-08T00:00:00.000Z';
    const localRef = (name: string, cwd?: string, workspaceId?: string, displayName?: string) => ({
      name, mode: 'local', localName: name, cwd, workspaceId, displayName, createdAt: stamp, updatedAt: stamp,
    });
    for (const name of ['lead', 'fixer', 'writer', 'faraway', 'oldbot', 'audit', 'stray']) {
      mkdirSync(join(home, name));
      writeFileSync(join(home, name, 'agent.db'), '');
    }
    writeFileSync(join(home, 'config.json'), JSON.stringify({
      agents: {
        lead: localRef('lead', projectDir, 'shop'),
        fixer: localRef('fixer', projectDir, 'shop'),
        writer: localRef('writer', projectDir, 'docs', 'Writer'),
        faraway: localRef('faraway', otherDir, 'other'),
        oldbot: localRef('oldbot', undefined, undefined, 'Old Bot'),
        audit: { name: 'audit', mode: 'cloud', cloudName: 'audit', displayName: 'Audit', createdAt: stamp, updatedAt: stamp },
        jarvis: { name: 'jarvis', mode: 'cloud', cloudName: 'jarvis', displayName: 'Jarvis', createdAt: stamp, updatedAt: stamp },
      },
    }, null, 2));

    const script = `
      const { listSidebarAgents, groupAgentWorkspaces } = await import('./packages/cli/src/agent-list.ts');
      const { canonicalProjectRoot } = await import('./packages/cli/src/config.ts');
      const root = canonicalProjectRoot(${JSON.stringify(projectDir)});
      const agents = listSidebarAgents(${JSON.stringify(projectDir)});
      console.log(JSON.stringify({ root, agents, grouped: groupAgentWorkspaces(agents, root) }));
    `;
    const proc = Bun.spawnSync({
      cmd: [process.execPath, '-e', script],
      cwd: repoRoot,
      env: { ...process.env, KINU_HOME: home },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect({ exitCode: proc.exitCode, stderr: proc.stderr.toString() }).toEqual({ exitCode: 0, stderr: '' });
    const RowSchema = v.object({
      name: v.string(),
      label: v.string(),
      mode: v.picklist(['local', 'cloud']),
      localName: v.optional(v.string()),
      cloudName: v.optional(v.string()),
      cwd: v.optional(v.string()),
      workspaceId: v.optional(v.string()),
    });
    const parsed = v.parse(v.object({
      root: v.string(),
      agents: v.array(RowSchema),
      grouped: v.object({
        projectRoot: v.string(),
        workspaces: v.array(v.object({ cwd: v.string(), workspaceId: v.string(), agents: v.array(RowSchema) })),
        unplaced: v.array(RowSchema),
        remote: v.array(RowSchema),
      }),
    }), JSON.parse(proc.stdout.toString()));

    expect(parsed.agents.map((agent) => `${agent.mode}:${agent.name}`)).toEqual([
      // This project's placed agents, ordered by workspace then name…
      'local:writer', 'local:fixer', 'local:lead',
      // …then unplaced legacy workspaces (a cloud name collision stays separate)…
      'local:audit', 'local:oldbot', 'local:stray',
      // …then the account's cloud workspaces. `faraway` belongs to another project.
      'cloud:audit', 'cloud:jarvis',
    ]);
    const oldbot = parsed.agents.find((agent) => agent.name === 'oldbot');
    expect(oldbot?.label).toBe('Old Bot');
    expect(oldbot?.cwd).toBeUndefined();
    expect(oldbot?.workspaceId).toBeUndefined();
    expect(parsed.grouped.workspaces.map((group) => `${group.workspaceId}:${group.agents.map((agent) => agent.name).join('+')}`)).toEqual([
      'docs:writer',
      'shop:fixer+lead',
    ]);
    expect(parsed.grouped.unplaced.map((agent) => agent.name)).toEqual(['audit', 'oldbot', 'stray']);
    expect(parsed.grouped.remote.map((agent) => `${agent.mode}:${agent.name}`)).toEqual(['cloud:audit', 'cloud:jarvis']);
  });
});
