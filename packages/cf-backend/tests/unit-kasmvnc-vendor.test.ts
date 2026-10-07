// D70: the desktop's client is KasmVNC's own, unedited, from the release the devbox image installs, and only the files it loads.
import { expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import * as v from 'valibot';
import { KASMVNC_CLIENT, KASMVNC_PIN, KasmvncPin, sha256 } from '../../../scripts/kasmvnc-client';

const pin = v.parse(KasmvncPin, JSON.parse(readFileSync(KASMVNC_PIN, 'utf8')));

test('the vendored client is the pinned files, byte for byte, and nothing else', () => {
  const vendored = readdirSync(KASMVNC_CLIENT, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(KASMVNC_CLIENT, join(entry.parentPath, entry.name)))
    .filter((path) => join(KASMVNC_CLIENT, path) !== KASMVNC_PIN);

  expect(Object.fromEntries(vendored.sort().map((path) => [path, sha256(readFileSync(join(KASMVNC_CLIENT, path)))]))).toEqual(pin.files);
});

test('the client is from the release the devbox tools install', () => {
  const setup = readFileSync(join(import.meta.dir, '../../devbox/block-lower/tools-setup.sh'), 'utf8');

  expect(setup).toContain(` ${pin.deb.url} ${pin.deb.sha256}\n`);
});
