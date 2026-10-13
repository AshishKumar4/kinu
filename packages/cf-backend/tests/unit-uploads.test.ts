/**
 * The file manager's uploads: one over a file already there waits for the owner, and their Replace lands at the path
 * it was dropped at, whatever folder they have browsed to since. The hook runs under React's client reconciler; its
 * caller renders nothing, so the container is the few fields React reads.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { FileWriteConflict } from '@kinu.run/core';
import type { VfsRevision } from '@nimbus-sh/core/vfs/vfs.js';
import { useUploads, type Uploads } from '../src/hooks/use-uploads';

const KEYS = ['window', 'IS_REACT_ACT_ENVIRONMENT'] as const;

const saved = new Map(KEYS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));

beforeAll(() => {
  Object.assign(globalThis, { window: { HTMLIFrameElement: class {}, document: { activeElement: null } }, IS_REACT_ACT_ENVIRONMENT: true });
});

afterAll(() => {
  for (const [key, descriptor] of saved) {
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, key);
    else Object.defineProperty(globalThis, key, descriptor);
  }
});

/** Folders of files, each with its revision: a write with no revision is a create, one with a revision lands over it. */
function revisionedFolders(seed: Record<string, string>) {
  const files = new Map(Object.entries(seed).map(([path, text]) => [path, { text, revision: 1 }]));

  const put = async (target: string, file: File, revision?: VfsRevision): Promise<void> => {
    const held = files.get(target);

    if (held !== undefined && held.revision !== revision) throw new FileWriteConflict(held.revision);

    files.set(target, { text: await file.text(), revision: (held?.revision ?? 0) + 1 });
  };

  return { put, text: (path: string) => files.get(path)?.text, write: (path: string, text: string) => {
    const held = files.get(path);

    files.set(path, { text, revision: (held?.revision ?? 0) + 1 });
  } };
}

test.each([false, true])('a Replace after browsing elsewhere writes the dropped file where it was dropped (edited meanwhile: %p)', async (edited) => {
  const folders = revisionedFolders({ '/home/main/a.txt': 'was here', '/home/other/a.txt': 'the other folder\'s' });
  const listens = { addEventListener() {}, removeEventListener() {} };
  const container: Element = Object.create(null, Object.getOwnPropertyDescriptors({ nodeType: 1, tagName: 'DIV', namespaceURI: null, ownerDocument: listens, ...listens }));
  const root = createRoot(container);
  let current: Uploads | undefined;

  function Probe(): null {
    current = useUploads({ put: folders.put, reload: async () => {} });

    return null;
  }

  const uploads = (): Uploads => {
    if (current === undefined) throw new Error('the hook never rendered');

    return current;
  };

  const held = (): Extract<Uploads['uploads'][number], { status: 'exists' }> => {
    const [first] = uploads().uploads;

    if (first?.status !== 'exists') throw new Error('expected the upload to wait for the owner');

    return first;
  };

  try {
    await act(async () => { root.render(createElement(Probe)); });
    await act(async () => { await uploads().upload([{ file: new File(['mine'], 'a.txt'), target: '/home/main/a.txt' }]); });
    expect(folders.text('/home/main/a.txt')).toBe('was here');

    // The owner browses to another folder holding its own a.txt; nothing about the held upload follows them. A save
    // there meanwhile is not written over: the owner is asked again, over the newer bytes.
    if (edited) {
      folders.write('/home/main/a.txt', 'edited meanwhile');
      await act(async () => { await uploads().replace(held()); });
      expect(folders.text('/home/main/a.txt')).toBe('edited meanwhile');
    }

    await act(async () => { await uploads().replace(held()); });

    expect(folders.text('/home/main/a.txt')).toBe('mine');
    expect(folders.text('/home/other/a.txt')).toBe('the other folder\'s');
    expect(uploads().uploads).toEqual([]);
  } finally {
    await act(async () => { root.unmount(); });
  }
});
