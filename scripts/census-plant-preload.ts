/**
 * Preloaded into one `bun test` by `census-plants.ts`: the file `KINU_CENSUS_PLANT_FILE` names loads as the source
 * `KINU_CENSUS_PLANT_SOURCE` holds, in that process alone. The plant never reaches the tree, where every gate running
 * beside the proof, and the live-app tier's dev server, would read it.
 */
import { readFileSync, realpathSync } from 'node:fs';

const LOADERS = { '.ts': 'ts', '.tsx': 'tsx', '.js': 'js', '.jsx': 'jsx', '.mjs': 'js', '.cjs': 'js' } as const;

const file = process.env.KINU_CENSUS_PLANT_FILE;

const source = process.env.KINU_CENSUS_PLANT_SOURCE;

if (file === undefined || source === undefined) {
  throw new Error('census-plant-preload: KINU_CENSUS_PLANT_FILE and KINU_CENSUS_PLANT_SOURCE name the plant');
}

const planted = readFileSync(source, 'utf8');

const loader = Object.entries(LOADERS).find(([extension]) => file.endsWith(extension))?.[1];

if (loader === undefined) throw new Error(`census-plant-preload: no loader for ${file}`);

// Modules load by their real path.
const exact = new RegExp(`^${realpathSync(file).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}$`, 'u');

Bun.plugin({
  name: 'census-plant',
  setup(build) {
    build.onLoad({ filter: exact }, () => ({ contents: planted, loader }));
  },
});
