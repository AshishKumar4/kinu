import { expect, test } from 'bun:test';
import { workspacePath } from '../src/vfs/workspace-path';

const paths: readonly (readonly [string, string])[] = [
  ['', '/home/main'], ['.', '/home/main'], ['./', '/home/main'],
  ['note.txt', '/home/main/note.txt'], ['.//dir/./note.txt/', '/home/main/dir/note.txt'],
  ['dir/deep/../note.txt', '/home/main/dir/note.txt'],
  ['/./home//main/', '/home/main'], ['/home/main/dir/../note.txt', '/home/main/note.txt'],
  ['/home/user', '/home/user'], ['/./home//user/', '/home/user'],
  ['/home/user/dir/note.txt', '/home/main/dir/note.txt'],
  ['/home/userland/note.txt', '/home/userland/note.txt'], ['..hidden/item.txt', '/home/main/..hidden/item.txt'],
  ['/slates/project/./item.txt/', '/slates/project/item.txt'],
  ['/', '/'], ['/.', '/'], ['//', '/'],
  ['/workspace/../item.txt', '/workspace/../item.txt'],
  ['/pc/studio/../../item.txt', '/pc/studio/../../item.txt'],
  ['/shared/./../item.txt', '/shared/../item.txt'],
  ['pc/studio/item.txt', '/home/main/pc/studio/item.txt'],
  ['shared/item.txt', '/home/main/shared/item.txt'],
];

for (const [input, expected] of paths) {
  test(`workspace path ${JSON.stringify(input)} names ${expected}`, () => {
    expect(workspacePath(input)).toBe(expected);
  });
}

for (const path of [
  '../item.txt', './dir/../../item.txt', '/home/main/../item.txt',
  '/home/user/../item.txt', '/slates/../item.txt', '/slates/project/../../item.txt',
  '/../home/main/SOUL.md', '/home/x/../main/SOUL.md', '/home/x/../user/SOUL.md',
  '/../home/main/../x', '/../slates/item.txt', '/home/x/../../slates/item.txt',
]) {
  test(`workspace path ${JSON.stringify(path)} cannot leave its named root`, () => {
    expect(() => workspacePath(path)).toThrow(expect.objectContaining({ code: 'EACCES' }));
  });
}
