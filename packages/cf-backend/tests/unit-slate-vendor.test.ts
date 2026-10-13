import { expect, test } from 'bun:test';
import vendor from 'virtual:kinu-slate-vendor';

// From the bundle's metafile: react 19's CJS shape links a named import only if the bundle publishes it.
// The bytes the slate runner is served, as the preload builds them.
test('the vendored react bundle publishes every export the client module and authored components use', async () => {
  for (const name of ['createRoot', 'useState', 'use', 'useActionState', 'jsx', 'jsxs', 'Fragment', 'default']) {
    expect(vendor.reactExports, `react bundle missing ${name}`).toContain(name);
  }

  const stub = await import(`data:text/javascript;base64,${Buffer.from(vendor.reactStub).toString('base64')}`);

  for (const name of vendor.reactExports.filter((n) => n !== 'default' && n !== 'Fragment')) {
    expect(Object.hasOwn(stub, name), `react-stub missing ${name}`).toBe(true);
  }
});
