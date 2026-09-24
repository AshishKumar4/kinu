/** Drive skill rules: no silent same-name replacement, no non-skill links, reserved folders stay put. */
import { describe, expect, test } from 'bun:test';
import { mossaicVfs } from '../src/vfs/mossaic-vfs';
import { DRIVE_SKILLS_DIR } from '../src/vfs/shared-drive';
import {
  addSkill, deleteDriveEntry, driveFailure, listDrive, makeDriveFolder, markAsSkill, normalizeDrivePath,
  packDriveFolder, receiveDriveUpload, renameDriveEntry,
} from '../src/skills/drive';
import { looksLikeZip, packZip, unpackZip } from '../src/utils/zip';
import { fakeMossaic, scratchDir } from '@kinu.run/test-utils';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SKILL = (name: string): string => `---\nname: ${name}\ndescription: ${name} does things\n---\nSteps.`;

const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

function tenant() {
  return mossaicVfs(fakeMossaic().tenant('user-alice'));
}

describe('drive paths', () => {
  test('a path is absolute and segment-clean, or refused', () => {
    expect(normalizeDrivePath('/')).toBe('/');
    expect(normalizeDrivePath('/a/b')).toBe('/a/b');
    expect(() => normalizeDrivePath('a/b')).toThrow('absolute');
    expect(() => normalizeDrivePath('/a/../b')).toThrow('illegal segment');
    expect(() => normalizeDrivePath('/a//b')).toThrow('illegal segment');
  });
});

describe('listing', () => {
  test('the root always shows the reserved folder, and a reserved folder lists empty before it exists', async () => {
    const drive = tenant();

    expect((await listDrive(drive, '/')).entries.map((entry) => [entry.name, entry.kind, entry.skillProblem]))
      .toEqual([['skills', 'folder', '/skills is a reserved Drive folder']]);
    expect(await listDrive(drive, DRIVE_SKILLS_DIR)).toEqual({ path: DRIVE_SKILLS_DIR, entries: [] });
    await drive.writeFile('/notes/readme.md', 'x');
    expect((await listDrive(drive, '/notes')).entries).toEqual([{ name: 'readme.md', kind: 'file', size: 1, mtimeMs: expect.any(Number), skill: false }]);
    expect((await listDrive(drive, '/')).entries.find((entry) => entry.name === 'notes')).toMatchObject({ kind: 'folder', skill: false, skillProblem: 'no SKILL.md in /notes' });
  });
});

describe('mark as skill', () => {
  test('a skill folder elsewhere on the Drive is linked under /skills; the folder stays put', async () => {
    const drive = tenant();

    await drive.writeFile('/projects/ops/deploy/SKILL.md', SKILL('deploy'));
    await drive.writeFile('/projects/ops/deploy/scripts/run.sh', 'echo');

    expect(await markAsSkill(drive, '/projects/ops/deploy')).toEqual({ name: 'deploy', linked: `${DRIVE_SKILLS_DIR}/deploy` });
    expect(await drive.readlink(`${DRIVE_SKILLS_DIR}/deploy`)).toBe('/projects/ops/deploy');
    expect(await drive.exists('/projects/ops/deploy/SKILL.md')).toBe(true);

    const listed = await listDrive(drive, DRIVE_SKILLS_DIR);

    expect(listed.entries).toEqual([{ name: 'deploy', kind: 'symlink', size: 0, mtimeMs: expect.any(Number), target: '/projects/ops/deploy', skill: true }]);
  });

  test('a folder already under /skills is a skill by position', async () => {
    const drive = tenant();

    await drive.writeFile(`${DRIVE_SKILLS_DIR}/review/SKILL.md`, SKILL('review'));
    expect(await markAsSkill(drive, `${DRIVE_SKILLS_DIR}/review`)).toEqual({ name: 'review', linked: `${DRIVE_SKILLS_DIR}/review` });
    expect((await listDrive(drive, DRIVE_SKILLS_DIR)).entries[0]).toMatchObject({ name: 'review', kind: 'folder', skill: true });
  });

  test('a folder that is not a skill, a reserved folder, and a taken name are each refused with the reason', async () => {
    const drive = tenant();

    await drive.writeFile('/notes/readme.md', 'not a skill');
    await expect(markAsSkill(drive, '/notes')).rejects.toThrow('no SKILL.md');
    await drive.writeFile('/Bad Name/SKILL.md', SKILL('bad'));
    await expect(markAsSkill(drive, '/Bad Name')).rejects.toThrow('folder name must be kebab-case');
    await drive.writeFile('/mismatch/SKILL.md', SKILL('other'));
    await expect(markAsSkill(drive, '/mismatch')).rejects.toThrow('does not match front-matter name');
    await expect(markAsSkill(drive, DRIVE_SKILLS_DIR)).rejects.toThrow('reserved');

    await drive.writeFile(`${DRIVE_SKILLS_DIR}/deploy/SKILL.md`, SKILL('deploy'));
    await drive.writeFile('/elsewhere/deploy/SKILL.md', SKILL('deploy'));
    await expect(markAsSkill(drive, '/elsewhere/deploy')).rejects.toThrow('already exists');
    expect(await drive.readFile(`${DRIVE_SKILLS_DIR}/deploy/SKILL.md`, { encoding: 'utf8' })).toBe(SKILL('deploy'));
  });
});

describe('add skill', () => {
  test('a pasted SKILL.md lands as /skills/<name>/SKILL.md, named by its front matter', async () => {
    const drive = tenant();

    expect(await addSkill(drive, [{ path: 'SKILL.md', bytes: bytes(SKILL('triage')) }], null))
      .toEqual({ name: 'triage', linked: `${DRIVE_SKILLS_DIR}/triage` });
    expect(await drive.readFile(`${DRIVE_SKILLS_DIR}/triage/SKILL.md`, { encoding: 'utf8' })).toBe(SKILL('triage'));
  });

  test('an uploaded folder is rooted at its SKILL.md and keeps its files', async () => {
    const drive = tenant();

    const files = [
      { path: 'deploy/SKILL.md', bytes: bytes('---\ndescription: ship it\n---\nSteps.') },
      { path: 'deploy/scripts/run.sh', bytes: bytes('echo run') },
      { path: 'deploy/reference/notes.md', bytes: bytes('notes') },
      { path: '__MACOSX/junk', bytes: bytes('') },
    ];

    expect(await addSkill(drive, files, 'deploy')).toEqual({ name: 'deploy', linked: `${DRIVE_SKILLS_DIR}/deploy` });
    expect(await drive.readFile(`${DRIVE_SKILLS_DIR}/deploy/scripts/run.sh`, { encoding: 'utf8' })).toBe('echo run');
    expect(await drive.exists(`${DRIVE_SKILLS_DIR}/deploy/reference/notes.md`)).toBe(true);
    expect(await drive.exists(`${DRIVE_SKILLS_DIR}/__MACOSX/junk`)).toBe(false);
  });

  test('no SKILL.md, a bad front matter, and a taken name are refused', async () => {
    const drive = tenant();

    await expect(addSkill(drive, [{ path: 'readme.md', bytes: bytes('x') }], 'x')).rejects.toThrow('needs a SKILL.md');
    await expect(addSkill(drive, [{ path: 'SKILL.md', bytes: bytes('no front matter') }], 'x')).rejects.toThrow('SKILL.md:');
    await addSkill(drive, [{ path: 'SKILL.md', bytes: bytes(SKILL('once')) }], null);
    await expect(addSkill(drive, [{ path: 'SKILL.md', bytes: bytes(SKILL('once')) }], null)).rejects.toThrow('already exists');
  });
});

describe('the zip container', () => {
  test('a packed archive unpacks to the same entries, and a deflated one from the system zip reads too', async () => {
    const packed = packZip([
      { path: 'deploy/SKILL.md', bytes: bytes(SKILL('deploy')) },
      { path: 'deploy/scripts/run.sh', bytes: bytes('echo run') },
    ]);

    expect(looksLikeZip(packed)).toBe(true);
    expect(looksLikeZip(bytes('not a zip'))).toBe(false);
    expect((await unpackZip(packed)).map((entry) => [entry.path, new TextDecoder().decode(entry.bytes)]))
      .toEqual([['deploy/SKILL.md', SKILL('deploy')], ['deploy/scripts/run.sh', 'echo run']]);

    const dir = scratchDir('drive-zip');
    mkdirSync(join(dir, 'triage', 'reference'), { recursive: true });
    writeFileSync(join(dir, 'triage', 'SKILL.md'), SKILL('triage').repeat(20));
    writeFileSync(join(dir, 'triage', 'reference', 'notes.md'), 'notes');
    execFileSync('zip', ['-q', '-r', 'triage.zip', 'triage'], { cwd: dir });
    const deflated = await unpackZip(new Uint8Array(readFileSync(join(dir, 'triage.zip'))));

    expect(deflated.map((entry) => entry.path).sort()).toEqual(['triage/SKILL.md', 'triage/reference/notes.md']);
    expect(new TextDecoder().decode(deflated.find((entry) => entry.path === 'triage/SKILL.md')?.bytes)).toBe(SKILL('triage').repeat(20));
  });

  test('an entry that climbs out of the archive is refused', () => {
    expect(() => packZip([{ path: '../etc/passwd', bytes: bytes('x') }])).toThrow('climbs');
    expect(() => packZip([{ path: '/abs', bytes: bytes('x') }])).toThrow('absolute');
  });
});

describe('uploads', () => {
  test('a file lands at its path with its folders made, a zip unpacks into a folder, a skill zip lands under /skills', async () => {
    const drive = tenant();

    expect(await receiveDriveUpload(drive, { kind: 'file', path: '/docs/a/b.txt' }, bytes('hello'))).toEqual({ ok: true });
    expect(await drive.readFile('/docs/a/b.txt', { encoding: 'utf8' })).toBe('hello');

    const archive = packZip([{ path: 'x/y.txt', bytes: bytes('y') }, { path: 'z.txt', bytes: bytes('z') }]);

    expect(await receiveDriveUpload(drive, { kind: 'zip', folder: '/unpacked' }, archive)).toEqual({ ok: true });
    expect(await drive.readFile('/unpacked/x/y.txt', { encoding: 'utf8' })).toBe('y');
    expect(await drive.readFile('/unpacked/z.txt', { encoding: 'utf8' })).toBe('z');
    await expect(receiveDriveUpload(drive, { kind: 'zip', folder: '/unpacked' }, bytes('plain'))).rejects.toThrow('not a zip');

    const skillZip = packZip([{ path: 'deploy/SKILL.md', bytes: bytes(SKILL('deploy')) }, { path: 'deploy/run.sh', bytes: bytes('r') }]);

    expect(await receiveDriveUpload(drive, { kind: 'skill', name: null }, skillZip))
      .toEqual({ ok: true, skill: { name: 'deploy', linked: `${DRIVE_SKILLS_DIR}/deploy` } });
    expect(await drive.exists(`${DRIVE_SKILLS_DIR}/deploy/run.sh`)).toBe(true);
    expect(await receiveDriveUpload(drive, { kind: 'skill', name: null }, bytes(SKILL('pasted'))))
      .toEqual({ ok: true, skill: { name: 'pasted', linked: `${DRIVE_SKILLS_DIR}/pasted` } });
    await expect(receiveDriveUpload(drive, { kind: 'file', path: DRIVE_SKILLS_DIR }, bytes('x'))).rejects.toThrow('reserved');
  });
});

describe('folders, renames, deletes', () => {
  test('reserved folders stay put; nothing is overwritten; a folder downloads as one zip', async () => {
    const drive = tenant();

    await makeDriveFolder(drive, '/projects');
    await expect(makeDriveFolder(drive, '/projects')).rejects.toThrow('already exists');
    await drive.writeFile('/projects/a.txt', 'a');
    await drive.writeFile('/projects/sub/b.txt', 'b');
    await renameDriveEntry(drive, '/projects', '/work');
    expect(await drive.readFile('/work/sub/b.txt', { encoding: 'utf8' })).toBe('b');
    await expect(renameDriveEntry(drive, DRIVE_SKILLS_DIR, '/elsewhere')).rejects.toThrow('reserved');
    await expect(renameDriveEntry(drive, '/work', '/work/inside')).rejects.toThrow('into itself');
    await drive.writeFile('/taken.txt', 't');
    await expect(renameDriveEntry(drive, '/work/a.txt', '/taken.txt')).rejects.toThrow('already exists');
    await expect(renameDriveEntry(drive, '/work/a.txt', '/nowhere/a.txt')).rejects.toThrow('not a folder');

    const archive = await unpackZip(await packDriveFolder(drive, '/work', 1024 * 1024));

    expect(archive.map((entry) => entry.path).sort()).toEqual(['a.txt', 'sub/b.txt']);
    await expect(packDriveFolder(drive, '/work', 1)).rejects.toThrow('transfer limit');

    await drive.writeFile(`${DRIVE_SKILLS_DIR}/deploy/SKILL.md`, SKILL('deploy'));
    await drive.symlink('/work', '/link');
    await deleteDriveEntry(drive, '/link');
    expect(await drive.exists('/work/a.txt')).toBe(true);
    await deleteDriveEntry(drive, '/work');
    expect(await drive.exists('/work/sub/b.txt')).toBe(false);
    await expect(deleteDriveEntry(drive, DRIVE_SKILLS_DIR)).rejects.toThrow('reserved');
    await expect(deleteDriveEntry(drive, '/gone')).rejects.toThrow('no such entry');
    expect(driveFailure({ cause: new Error('x') }).code).toBe('io');

    try {
      await deleteDriveEntry(drive, '/gone');
      throw new Error('did not throw');
    } catch (cause) {
      expect(driveFailure({ cause })).toEqual({ code: 'missing', error: 'no such entry: /gone' });
    }
  });
});
