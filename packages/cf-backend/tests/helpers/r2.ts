import type { PictureBucket } from '../../src/slates/pictures';

export interface MemoryBucket extends PictureBucket {
  readonly objects: Map<string, Uint8Array>;
}

/** An R2 bucket over a Map, listing `page` keys at a time as R2 lists a thousand. */
export function memoryBucket(page = 1000): MemoryBucket {
  const objects = new Map<string, Uint8Array>();

  return {
    objects,
    async get(key) {
      const bytes = objects.get(key);

      return bytes === undefined ? null : { body: new Blob([new Uint8Array(bytes)]).stream(), httpEtag: `"${key}"` };
    },
    async put(key, value) {
      objects.set(key, value);
    },
    async delete(keys) {
      for (const key of [keys].flat()) objects.delete(key);
    },
    async list({ prefix }) {
      const keys = [...objects.keys()].filter((key) => key.startsWith(prefix)).sort();

      return { objects: keys.slice(0, page).map((key) => ({ key })), truncated: keys.length > page };
    },
  };
}
