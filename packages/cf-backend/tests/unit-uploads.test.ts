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

test('a Replace pressed after browsing elsewhere writes the file the conflict named, over the revision it named', async () => {
  const puts: Array<{ target: string; revision: VfsRevision | undefined }> = [];

  const put = async (target: string, _file: File, revision?: VfsRevision): Promise<void> => {
    puts.push({ target, revision });

    if (revision === undefined) throw new FileWriteConflict('rev-7');
  };

  const listens = { addEventListener() {}, removeEventListener() {} };
  const container: Element = Object.create(null, Object.getOwnPropertyDescriptors({ nodeType: 1, tagName: 'DIV', namespaceURI: null, ownerDocument: listens, ...listens }));
  const root = createRoot(container);
  let current: Uploads | undefined;

  function Probe(): null {
    current = useUploads({ put, reload: async () => {} });

    return null;
  }

  const uploads = (): Uploads => {
    if (current === undefined) throw new Error('the hook never rendered');

    return current;
  };

  await act(async () => { root.render(createElement(Probe)); });
  await act(async () => { await uploads().upload([{ file: new File(['mine'], 'a.txt'), target: '/home/main/a.txt' }]); });

  const [held] = uploads().uploads;

  if (held?.status !== 'exists') throw new Error('expected the upload to wait for the owner');
  // The owner browses to another folder holding its own a.txt; nothing about the held upload follows them.
  await act(async () => { await uploads().replace(held); });

  expect(puts).toEqual([{ target: '/home/main/a.txt', revision: undefined }, { target: '/home/main/a.txt', revision: 'rev-7' }]);
  expect(uploads().uploads).toEqual([]);
  await act(async () => { root.unmount(); });
});
