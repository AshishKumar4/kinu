import { describe, expect, test } from 'bun:test';
import { Miniflare } from 'miniflare';
import { publicationBucket } from './publication-bucket';

async function measureWrites(mode: 'original' | 'unarmed' | 'armed') {
  const runtime = new Miniflare({
    workers: [{
      config: {
        name: 'publication-store', type: 'worker', compatibilityDate: '2026-04-14',
        manifest: {
          mainModule: 'index.mjs', modulesRoot: '/',
          modules: { 'index.mjs': { type: 'esm', contents: 'export default {}' } },
        },
        env: { BUCKET: { type: 'r2', name: 'BUCKET' } },
      },
    }],
  });
  try {
    const real = await runtime.getR2Bucket('BUCKET');
    let storeOperations = 0;
    let controlRpcs = 0;
    const counted: R2Bucket = Object.create(real);
    Object.assign(counted, {
      put: async (...args: Parameters<typeof real.put>) => {
        storeOperations += 1;
        return await real.put(...args);
      },
      createMultipartUpload: async (...args: Parameters<typeof real.createMultipartUpload>) => {
        storeOperations += 1;
        const upload = await real.createMultipartUpload(...args);
        return {
          key: upload.key,
          uploadId: upload.uploadId,
          uploadPart: async (number: number, bytes: Uint8Array) => {
            storeOperations += 1;
            return await upload.uploadPart(number, bytes);
          },
          complete: async (parts: R2UploadedPart[]) => {
            storeOperations += 1;
            return await upload.complete(parts);
          },
          abort: async () => { await upload.abort(); },
        };
      },
    });
    const bucket = mode === 'original' ? counted : publicationBucket(counted,
      mode === 'armed' ? '1' : undefined, async () => { controlRpcs += 1; });
    await bucket.put('one', 'first');
    await bucket.put('two', 'second');
    const upload = await bucket.createMultipartUpload('multipart');
    const part = await upload.uploadPart(1, new TextEncoder().encode('third'));
    await upload.complete([part]);
    const bodies = await Promise.all(['one', 'two', 'multipart'].map(async (key) => (await real.get(key))?.text()));
    return { storeOperations, controlRpcs, bodies };
  } finally {
    await runtime.dispose();
  }
}

describe('the boot-gated object wrapper', () => {
  test('unarmed writes keep the uninstrumented store count and make no control RPC', async () => {
    const original = await measureWrites('original');
    const unarmed = await measureWrites('unarmed');
    const armed = await measureWrites('armed');
    expect(original).toEqual({ storeOperations: 5, controlRpcs: 0, bodies: ['first', 'second', 'third'] });
    expect(unarmed).toEqual(original);
    expect(armed).toEqual({ ...original, controlRpcs: 3 });
    process.stdout.write(`publication.cut_cost original=${original.storeOperations} unarmed=${unarmed.storeOperations} unarmed_control_rpcs=${unarmed.controlRpcs} armed_control_rpcs=${armed.controlRpcs}\n`);
  });
});
