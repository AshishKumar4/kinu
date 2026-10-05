import * as v from 'valibot';
import { infraBoundary } from '@kinu.run/test-utils';

const LatestSchema = v.object({ version: v.string(), dist: v.object({ integrity: v.string() }) });

/** The registry's current release; a registry refusal is not the agent's result. */
export function published(name: string): Promise<{ version: string; integrity: string }> {
  const url = `https://registry.npmjs.org/${name}/latest`;

  return infraBoundary(`GET ${url}`, async () => {
    const response = await fetch(url);

    if (!response.ok) throw new Error(`the registry answered ${String(response.status)}`);
    const latest = v.parse(LatestSchema, await response.json());

    return { version: latest.version, integrity: latest.dist.integrity };
  });
}
