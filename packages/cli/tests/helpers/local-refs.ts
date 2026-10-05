import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import { scratchDir } from '../../../test-utils/src/scratch';

const ConfigFile = v.looseObject({ agents: v.optional(v.record(v.string(), v.unknown())) });

/**
 * Records a local workspace's ref in `home`'s config.json beside the refs already there, and returns the folder it
 * works in. Since 2026-10-04 a workspace no ref places is listed nowhere and refused at open.
 */
export function placeLocalWorkspace(home: string, name: string): string {
  const folder = realpathSync(scratchDir(`${name}-folder`));
  const path = join(home, 'config.json');
  const config = existsSync(path) ? v.parse(ConfigFile, JSON.parse(readFileSync(path, 'utf8'))) : {};
  const stamp = new Date(0).toISOString();
  const ref = { name, mode: 'local', localName: name, cwd: folder, workspaceId: 'proj', createdAt: stamp, updatedAt: stamp };

  writeFileSync(path, JSON.stringify({ ...config, agents: { ...config.agents, [name]: ref } }));

  return folder;
}
