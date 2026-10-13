import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as v from 'valibot';
import { Database } from 'bun:sqlite';
import { scratchDir } from '../../../test-utils/src/scratch';

const ConfigFile = v.looseObject({ agents: v.optional(v.record(v.string(), v.unknown())) });

/**
 * Records a local workspace's ref in `home`'s config.json beside the refs already there, and returns the folder it
 * works in. Since 2026-10-04 a workspace no ref places is listed nowhere and refused at open.
 */
export function placeLocalWorkspace(home: string, name: string, corruptIdentity?: string): string {
  const folder = realpathSync(scratchDir(`${name}-folder`));
  const path = join(home, 'config.json');
  const config = existsSync(path) ? v.parse(ConfigFile, JSON.parse(readFileSync(path, 'utf8'))) : {};
  const stamp = new Date(0).toISOString();
  const identityId = corruptIdentity ?? recordedIdentity(home, name);
  const ref = { name, mode: 'local', localName: name, cwd: folder, workspaceId: 'proj', identityId, createdAt: stamp, updatedAt: stamp };

  writeFileSync(path, JSON.stringify({ ...config, agents: { ...config.agents, [name]: ref } }));

  return folder;
}

function recordedIdentity(home: string, name: string): string {
  const db = new Database(join(home, name, 'agent.db'));

  try {
    return v.parse(v.object({ id: v.string() }), db.query('SELECT id FROM workspace_identity LIMIT 1').get()).id;
  } finally {
    db.close();
  }
}
