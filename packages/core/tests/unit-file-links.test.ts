// 2026-10-04: a file the agent named was plain text. Each reference is a link: a local workspace's to the file on this
// machine, a cloud workspace's to its Files surface; code blocks and other schemes stay as written.
import { describe, expect, test } from 'bun:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { formatPath, localPlanes } from '../src/vfs/resolve';
import { cloudFileLinks, filesFocusOf, linkFileReferences, localFileLinks } from '../src/read-models/file-links';

const PLANES = localPlanes({ space: '/home/ana/.kinu/acme', folder: '/home/ana/acme', home: '/home/ana', views: [] });

describe('a reference opens the file it names', () => {
  test('locally as the file on this machine; one that climbs out of its plane names nothing', () => {
    const links = localFileLinks(PLANES);

    expect(links.roots).toEqual(['vfs', 'local']);
    expect(links.href('vfs://slates/my board/index.ts')).toBe('file:///home/ana/.kinu/acme/slates/my%20board/index.ts');
    expect(links.href('local://src/app.ts')).toBe('file:///home/ana/acme/src/app.ts');
    expect(links.href('vfs://local/src/app.ts')).toBe('file:///home/ana/acme/src/app.ts');
    expect(links.href('vfs://../../etc/passwd')).toBeNull();
  });

  test('on the cloud as the workspace\'s Files page, landing on the reference', () => {
    const links = cloudFileLinks('https://kinu.run', 'acme');

    expect(links.roots).toEqual(['vfs', 'local', 'sandbox']);
    expect(links.href('vfs://home/main/a b.md')).toBe('https://kinu.run/workspace/acme?file=vfs%3A%2F%2Fhome%2Fmain%2Fa+b.md');
    expect(links.href('sandbox://w/x')).toBe('https://kinu.run/workspace/acme?file=sandbox%3A%2F%2Fw%2Fx');
  });
});

describe('a message\'s references become links', () => {
  const links = { roots: ['vfs'], href: (reference: string) => (reference.includes('..') ? null : `T:${reference}`) };

  test('bare, as a whole inline code span, and as an existing link\'s target', () => {
    expect(linkFileReferences('See vfs://a/b.md, then `vfs://c` and [the plan](vfs://p.md).', links))
      .toBe('See [vfs://a/b.md](T:vfs://a/b.md), then [`vfs://c`](T:vfs://c) and [the plan](T:vfs://p.md).');
  });

  test('fenced code, code that only mentions one, other schemes and a reference naming nothing stay as written', () => {
    const fenced = '```sh\ncat vfs://x\n```\n~~~\nvfs://y\n~~~';
    expect(linkFileReferences(fenced, links)).toBe(fenced);
    expect(linkFileReferences('run `cat vfs://x` or open https://x.io and vfs://../z', links)).toBe('run `cat vfs://x` or open https://x.io and vfs://../z');
  });
});

// Release review, 2026-10-05: encodeURI left `#` and `?` in a file URL, so report#1.md opened report.
describe('a local link is the file URL pathToFileURL makes', () => {
  test('for every name a reference escapes, and from a whole inline code span with spaces in it', () => {
    const links = localFileLinks(PLANES);

    for (const name of ['report#1.md', 'what?.md', 'My Report.md', '100%.md']) {
      const href = links.href(formatPath(`/home/ana/acme/${name}`, PLANES));

      expect(href).toBe(pathToFileURL(`/home/ana/acme/${name}`).href);
      expect(fileURLToPath(href ?? '')).toBe(`/home/ana/acme/${name}`);
    }

    expect(linkFileReferences('Open `local://My Report.md` now.', links))
      .toBe(`Open [\`local://My Report.md\`](${pathToFileURL('/home/ana/acme/My Report.md').href}) now.`);
  });
});

describe('a cloud reference opens the Files surface', () => {
  test('on its folder with the file previewed, or on the folder itself', () => {
    expect(filesFocusOf('vfs://home/main/notes/report.md')).toEqual({ path: '/home/main/notes', file: '/home/main/notes/report.md' });
    expect(filesFocusOf('sandbox://w/')).toEqual({ path: '/sandbox/w' });
    expect(filesFocusOf('vfs://')).toEqual({ path: '/' });
    expect(filesFocusOf('vfs://../x')).toBeNull();
  });
});
