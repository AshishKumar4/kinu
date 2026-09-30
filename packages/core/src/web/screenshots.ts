import type { VFS } from '@nimbus-sh/core/vfs/vfs.js';

import { nanoid } from '../utils/nanoid';
import type { WebScreenshot } from './provider';

/** Where `web` screenshots land in the workspace, so the person sees them beside their files. */
const SCREENSHOTS_DIR = 'screenshots';

/** The workspace-relative path the shot was written to. */
export async function saveScreenshot(vfs: VFS, shot: WebScreenshot): Promise<string> {
  const host = new URL(shot.url).hostname.replace(/[^a-z0-9.-]/giu, '-');
  const stamp = shot.retrievedAt.replace(/[-:]/gu, '').replace(/\.\d+Z$/u, 'Z');
  const path = `${SCREENSHOTS_DIR}/${host}-${stamp}-${nanoid(4)}.png`;

  await vfs.mkdir(SCREENSHOTS_DIR, { recursive: true });
  await vfs.writeFile(path, shot.bytes);

  return path;
}
