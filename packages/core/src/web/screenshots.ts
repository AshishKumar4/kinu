import type { Storage } from '../types/primitives';

import { nanoid } from '../utils/nanoid';
import type { WebScreenshot } from './provider';

/** Where `web` screenshots land in the workspace, so the person sees them beside their files. */
const SCREENSHOTS_DIR = 'screenshots';

/** The absolute path the shot was written to, in the actor's home. */
export async function saveScreenshot(files: Pick<Storage, 'vfs' | 'home'>, shot: WebScreenshot): Promise<string> {
  const host = new URL(shot.url).hostname.replace(/[^a-z0-9.-]/giu, '-');
  const stamp = shot.retrievedAt.replace(/[-:]/gu, '').replace(/\.\d+Z$/u, 'Z');
  const directory = `${files.home}/${SCREENSHOTS_DIR}`;
  const path = `${directory}/${host}-${stamp}-${nanoid(4)}.png`;

  await files.vfs.mkdir(directory, { recursive: true });
  await files.vfs.writeFile(path, shot.bytes);

  return path;
}
