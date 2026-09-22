import { expect, test } from 'bun:test';
import { buildSlateShareHost, parseSlateShareLabel } from '../src/preview/slate-share-host';
import { buildWorkspacePreviewHost, parseWorkspacePreviewLabel } from '../src/preview/nimbus-preview-host';

const HANDLE = '0123abcdef';

const TOKEN = 'abcxyz234567abc';

test('a slate share label round-trips handle, token and workspace', () => {
  const host = buildSlateShareHost({ handle: HANDLE, token: TOKEN, workspace: 'my-ws', suffix: 'kinu.run' });

  expect(host).toBe(`${HANDLE}-${TOKEN}-my-ws.kinu.run`);
  expect(parseSlateShareLabel(`${HANDLE}-${TOKEN}-my-ws`)).toEqual({ handle: HANDLE, token: TOKEN, workspace: 'my-ws' });

  expect(parseSlateShareLabel('xyz')).toBeNull();
  expect(parseSlateShareLabel(`${HANDLE.toUpperCase()}-${TOKEN}-my-ws`)).toEqual({
    handle: HANDLE, token: TOKEN, workspace: 'my-ws',
  });
  expect(parseSlateShareLabel(`${HANDLE}-${TOKEN}-`)).toBeNull();
  expect(parseSlateShareLabel(`${HANDLE}-${TOKEN}-Bad_Name`)).toBeNull();
  expect(parseSlateShareLabel(`zzzzzzzzzz-${TOKEN}-my-ws`)).toBeNull();
  expect(parseSlateShareLabel(`${HANDLE}-${TOKEN.slice(0, 14)}-my-ws`)).toBeNull();

  // The label budget: a 31-char workspace address still fits one DNS label.
  const longest = 'a'.repeat(31);
  expect(buildSlateShareHost({ handle: HANDLE, token: TOKEN, workspace: longest, suffix: 'kinu.run' }))
    .toBe(`${HANDLE}-${TOKEN}-${longest}.kinu.run`);
  expect(buildSlateShareHost({ handle: HANDLE, token: TOKEN, workspace: 'a'.repeat(32), suffix: 'kinu.run' })).toBeNull();
  expect(() => buildSlateShareHost({ handle: 'nope', token: TOKEN, workspace: 'my-ws', suffix: 'kinu.run' })).toThrow();
  expect(() => buildSlateShareHost({ handle: HANDLE, token: 'nope', workspace: 'my-ws', suffix: 'kinu.run' })).toThrow();
});

test('each parser refuses the other address grammar', () => {
  const shareHost = buildSlateShareHost({ handle: HANDLE, token: TOKEN, workspace: 'my-ws', suffix: 'kinu.run' });
  const previewHost = buildWorkspacePreviewHost({ port: 3_000, workspace: 'my-ws', handle: 'fedcba9876', token: TOKEN, suffix: 'kinu.run' });

  expect(shareHost).not.toBeNull();
  expect(previewHost).not.toBeNull();

  const shareLabel = shareHost!.split('.')[0];
  const previewLabel = previewHost!.split('.')[0];

  // A share label's first field is ten hex digits — a port the preview grammar
  // refuses — and a preview label's port makes the share's handle field a '-'.
  expect(parseWorkspacePreviewLabel(shareLabel)).toBeNull();
  expect(parseSlateShareLabel(previewLabel)).toBeNull();
});
