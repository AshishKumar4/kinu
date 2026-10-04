import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readText } from '@nimbus-sh/core/vfs/vfs.js';
import { isVfsError } from '@nimbus-sh/core/vfs/vfs-error.js';
import { buildBuiltinTools, type AgentRuntime, type JsonValue } from '@kinu.run/core';
import { present, scratchDir, toolExecute } from '@kinu.run/test-utils';
import * as v from 'valibot';
import { createCLIRuntime } from '../../../cli-backend/src/runtime';
import { conversationsFor } from '../../../core/tests/helpers';
import { hostedMainActor, orchestratorHarness, workspaceFiles } from '../helpers/actor-harness';
import { testBackends } from './backend';

/** The model's `file` tool over a backend's own runtime. */
function fileTool(rt: AgentRuntime): (input: { action: string; path: string; content?: string }) => Promise<JsonValue> {
  return toolExecute(present(buildBuiltinTools({ rt, workMode: 'build', conversations: conversationsFor(rt) }).file, 'the file tool'));
}

async function publicPlane(name: 'cf' | 'cli') {
  if (name === 'cf') {
    const cloud = orchestratorHarness();
    await cloud.started;

    const files = workspaceFiles(cloud.agent);

    return {
      read: (path: string) => cloud.agent.readExecutorFile('workspace', path),
      file: fileTool((await hostedMainActor(cloud)).actor.runtime),
      shell: present((await hostedMainActor(cloud)).actor.runtime.shell, 'the cloud workspace shell'),
      list: (path: string) => files.readdir(path),
      write: async (path: string, text: string) => {
        await files.writeFile(path, new TextEncoder().encode(text));
      },
      // The own home is the Nimbus tree's, and a relative path starts there.
      home: '/home/main', workdir: '/home/main', legacyHomes: ['/home/user'],
      hostFile: null,
    };
  }

  // The own space is real files beside the database; a relative path starts in the folder.
  const root = scratchDir('workspace-paths');
  const cwd = join(root, 'project');
  const space = join(root, 'space');
  mkdirSync(cwd);
  mkdirSync(space);

  const db = new Database(join(space, 'agent.db'));
  const rt = createCLIRuntime(db, { llm: null, cwd });

  return {
    read: async (path: string) => {
      try { return { content: await readText(rt.storage.vfs, path) }; }
      catch (cause) {
        if (isVfsError(cause)) return { error: cause.message };

        throw cause;
      }
    },
    list: (path: string) => rt.storage.vfs.readdir(path),
    file: fileTool(rt),
    shell: present(rt.shell, 'the local shell'),
    write: async (path: string, text: string) => { await rt.storage.vfs.writeFile(path, new TextEncoder().encode(text)); },
    end: () => db.close(),
    home: join(space, 'home', 'main'), workdir: cwd, legacyHomes: [],
    hostFile: (path: string) => readFileSync(path, 'utf8'),
  };
}

for (const name of testBackends()) {
  describe(`${name} public workspace paths`, () => {
    test('every spelling of the own home reads and updates the same file, without copying it', async () => {
      const plane = await publicPlane(name);

      try {
        await plane.write('/home/main/notes/item.txt', 'one');

        for (const path of [
          '/home/main/notes/item.txt', '/home//main/notes/item.txt', '/home/main/notes/./item.txt', '/home/main/notes/item.txt/',
          `${plane.home}/notes/item.txt`, ...plane.legacyHomes.map((home) => `${home}/notes/item.txt`),
        ]) {
          expect(await plane.read(path)).toMatchObject({ content: 'one' });
        }

        await plane.write(`${plane.home}/notes/./item.txt`, 'two');
        expect(await plane.read('/home/main/notes/item.txt')).toMatchObject({ content: 'two' });

        if (plane.hostFile !== null) expect(plane.hostFile(`${plane.home}/notes/item.txt`)).toBe('two');

        for (const path of ['/home/main/', `${plane.home}/`]) {
          expect((await plane.list(path)).map((entry) => entry.name)).toContain('notes');
        }

        expect((await plane.read('/workspace/notes/item.txt')).error).toBeDefined();
      } finally {
        plane.end?.();
      }
    });

    test('a path resolves as POSIX resolves it, a relative one from where the agent works', async () => {
      const plane = await publicPlane(name);

      try {
        await plane.write('item.txt', 'one');
        await plane.write('/slates/project/item.txt', 'slate');

        for (const path of ['./item.txt', './dir/../item.txt', `${plane.workdir}/x/../item.txt`, `${plane.workdir}//./item.txt`]) {
          expect(await plane.read(path)).toMatchObject({ content: 'one' });
        }

        expect(await plane.read('/home/main/../../slates/project/./item.txt')).toMatchObject({ content: 'slate' });

        if (plane.hostFile !== null) {
          expect(plane.hostFile(`${plane.workdir}/item.txt`)).toBe('one');
          expect(plane.hostFile(join(plane.home, '..', '..', 'slates', 'project', 'item.txt'))).toBe('slate');
        }
      } finally {
        plane.end?.();
      }
    });

    // 2026-10-04: the file tool printed `root://path` references it could not read back, and took `~` as a name.
    test('the file tool reads a file by the reference it printed, and `~` as the shell names it', async () => {
      const plane = await publicPlane(name);

      try {
        const written = v.parse(v.object({ reference: v.string() }), await plane.file({ action: 'write', path: 'notes/ref.txt', content: 'one' }));
        expect(written.reference).toBe(name === 'cf' ? 'vfs://home/main/notes/ref.txt' : 'local://notes/ref.txt');
        expect(await plane.file({ action: 'read', path: written.reference })).toContain('one');

        if (name === 'cf') expect(await plane.file({ action: 'read', path: '~/notes/ref.txt' })).toContain('one');
      } finally {
        plane.end?.();
      }
    });

    // 2026-10-04: a shell given `vfs://x` ran it as a relative path. The shell takes its machine's paths; a refusal names the real one.
    test('the shell refuses a plane reference and names the path it has for it', async () => {
      const plane = await publicPlane(name);

      try {
        const refused = await plane.shell.exec('cat vfs://home/main/notes/ref.txt');
        expect(refused.stderr).toContain(`NOT RUN: the shell takes this machine's paths: vfs://home/main/notes/ref.txt is ${plane.home}/notes/ref.txt here`);
        expect(refused.exitCode).not.toBe(0);
        expect((await plane.shell.exec('echo "see vfs://home/main/x and https://example.com"')).stdout).toContain('see vfs://home/main/x');
      } finally {
        plane.end?.();
      }
    });

    test('relative mount names stay local, while absolute mounts retain their own boundary', async () => {
      const plane = await publicPlane(name);

      try {
        await plane.write('pc/studio/item.txt', 'local device spelling');
        await plane.write('shared/item.txt', 'local shared spelling');
        expect(await plane.read('pc/studio/item.txt')).toMatchObject({ content: 'local device spelling' });
        expect(await plane.read('shared/item.txt')).toMatchObject({ content: 'local shared spelling' });
        expect((await plane.read('/shared/item.txt')).error).toContain('ENXIO');
        // A mount on the cloud refuses a climb out of it; a real path climbs as POSIX does.
        expect((await plane.read('/shared/../item.txt')).error).toContain(name === 'cf' ? 'EPERM' : 'ENOENT');

        if (name === 'cf') {
          expect((await plane.read('/pc/studio/item.txt')).error).toContain('ENXIO');
          expect((await plane.read('/pc/studio/../../item.txt')).error).toContain('EPERM');
        }
      } finally {
        plane.end?.();
      }
    });
  });
}
