import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import * as v from 'valibot';

const WorkspaceConfigSchema = v.object({
  agents: v.record(v.string(), v.object({ mode: v.string() })),
  aliases: v.record(v.string(), v.string()),
});

const repoRoot = resolve(__dirname, '../../..');
const cliBin = join(repoRoot, 'packages/cli/bin/cli.ts');
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('kinu workspace delete', () => {
  test('deletes with the stored session token and prunes the cloud config entry', async () => {
    const seen: Array<{ path: string; method: string; authorization: string | null }> = [];
    const server = Bun.serve({
      hostname: '127.0.0.1',
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        seen.push({
          path: url.pathname,
          method: request.method,
          authorization: request.headers.get('authorization'),
        });
        return Response.json({ ok: true });
      },
    });
    const home = workspaceHome(`http://127.0.0.1:${server.port}`);

    try {
      const proc = Bun.spawn([process.execPath, cliBin, 'workspace', 'delete', 'web-agent', '--yes'], {
        cwd: repoRoot,
        env: {
          ...process.env,
          KINU_HOME: home,
          KINU_ORIGIN: `http://127.0.0.1:${server.port}`,
          KINU_TOKEN: `pta_${'0'.repeat(32)}_${'a'.repeat(44)}`,
          NO_COLOR: '1',
        },
        stdout: 'pipe',
        stderr: 'pipe',
      });
      const exitCode = await proc.exited;
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();

      expect(exitCode).toBe(0);
      expect(stderr).toBe('');
      expect(stdout).toContain('Deleted cloud workspace web-agent');
      expect(seen[0]).toEqual({
        path: '/api/cli/workspaces/web-agent',
        method: 'DELETE',
        authorization: 'Bearer ptc_stored_session',
      });

      const config = v.parse(WorkspaceConfigSchema, JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')));
      expect(config.agents['web-agent']).toBeUndefined();
      expect(config.agents.localbot).toMatchObject({ mode: 'local' });
      expect(config.aliases).toEqual({ local: 'localbot' });
    } finally {
      server.stop(true);
    }
  });

  test('requires explicit confirmation when no terminal is attached', async () => {
    const home = workspaceHome('https://kinu.invalid');
    const proc = Bun.spawn([process.execPath, cliBin, 'workspace', 'delete', 'web-agent'], {
      cwd: repoRoot,
      detached: true,
      env: { ...process.env, KINU_HOME: home, NO_COLOR: '1' },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    const exitCode = await proc.exited;
    const stderr = await new Response(proc.stderr).text();

    expect(exitCode).toBe(1);
    expect(stderr).toContain('--yes');
    const config = v.parse(WorkspaceConfigSchema, JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')));
    expect(config.agents['web-agent']).toBeDefined();
  });
});

function workspaceHome(origin: string): string {
  const home = mkdtempSync(join(tmpdir(), 'kinu-workspace-delete-'));
  tempDirs.push(home);
  writeFileSync(join(home, 'config.json'), JSON.stringify({
    origin,
    accessToken: 'ptc_stored_session',
    agents: {
      'web-agent': {
        name: 'web-agent',
        mode: 'cloud',
        cloudName: 'web-agent',
        createdAt: '2026-07-14T00:00:00.000Z',
        updatedAt: '2026-07-14T00:00:00.000Z',
      },
      localbot: {
        name: 'localbot',
        mode: 'local',
        localName: 'localbot',
        createdAt: '2026-07-14T00:00:00.000Z',
        updatedAt: '2026-07-14T00:00:00.000Z',
      },
    },
    aliases: { web: 'web-agent', local: 'localbot' },
  }, null, 2));
  return home;
}
