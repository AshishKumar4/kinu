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
      list: (path: string) => files.readdir(path),
      write: async (path: string, text: string) => {
        await files.writeFile(path, new TextEncoder().encode(text));
      },
      hostFile: null,
    };
  }

  const cwd = scratchDir('workspace-paths');
  mkdirSync(join(cwd, 'slates'));

  const db = new Database(':memory:');
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
    write: async (path: string, text: string) => { await rt.storage.vfs.writeFile(path, new TextEncoder().encode(text)); },
    end: () => db.close(),
    hostFile: (path: string) => readFileSync(join(cwd, path), 'utf8'),
  };
}

for (const name of testBackends()) {
  describe(`${name} public workspace paths`, () => {
    test('every home spelling reads and updates the same file, without copying it', async () => {
      const plane = await publicPlane(name);

      try {
        await plane.write('notes/item.txt', 'one');

        for (const path of [
          'notes/item.txt', './notes/item.txt', './/notes/./item.txt', 'notes/deep/../item.txt',
          '/home/main/notes/item.txt', '/home//main/notes/item.txt', '/home/user/notes/item.txt',
          '/home/main/notes/item.txt/',
        ]) {
          expect(await plane.read(path)).toMatchObject({ content: 'one' });
        }

        await plane.write('/home/user/notes/./item.txt', 'two');
        expect(await plane.read('notes/item.txt')).toMatchObject({ content: 'two' });

        if (plane.hostFile !== null) expect(plane.hostFile('notes/item.txt')).toBe('two');

        for (const path of ['', '.', './', '/home/main/', '/home/user/']) {
          expect((await plane.list(path)).map((entry) => entry.name)).toContain('notes');
        }

        expect((await plane.read('/workspace/notes/item.txt')).error).toBeDefined();
      } finally {
        plane.end?.();
      }
    });

    test('a path resolves as POSIX resolves it, from the home, on both backends', async () => {
      const plane = await publicPlane(name);

      try {
        await plane.write('item.txt', 'one');
        await plane.write('/slates/project/item.txt', 'slate');

        for (const path of ['../main/item.txt', './dir/../item.txt', '/slates/../home/main/item.txt', '/home/x/../main/item.txt']) {
          expect(await plane.read(path)).toMatchObject({ content: 'one' });
        }

        expect(await plane.read('/home/main/../../slates/project/./item.txt')).toMatchObject({ content: 'slate' });

        if (plane.hostFile !== null) expect(plane.hostFile('slates/project/item.txt')).toBe('slate');
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

    test('relative mount names stay local, while absolute mounts retain their own boundary', async () => {
      const plane = await publicPlane(name);

      try {
        await plane.write('pc/studio/item.txt', 'local device spelling');
        await plane.write('shared/item.txt', 'local shared spelling');
        expect(await plane.read('pc/studio/item.txt')).toMatchObject({ content: 'local device spelling' });
        expect(await plane.read('shared/item.txt')).toMatchObject({ content: 'local shared spelling' });
        expect((await plane.read('/shared/item.txt')).error).toContain('ENXIO');
        expect((await plane.read('/shared/../item.txt')).error).toContain('EPERM');

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
