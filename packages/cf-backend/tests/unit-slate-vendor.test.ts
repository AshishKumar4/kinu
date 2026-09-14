import { expect, test } from 'bun:test';
import { buildSlateVendor } from '../slate-vendor';

// The names must come from the BUNDLE's metafile — react 19's CJS shape means
// `import { use } from "react"` only links when the bundle actually publishes
// it, and a hand list of names drifts silent.
test('the vendored react bundle publishes every export the client module and authored components use', () => {
  const vendor = buildSlateVendor();

  for (const name of ['createRoot', 'useState', 'use', 'useActionState', 'jsx', 'jsxs', 'Fragment', 'default']) {
    expect(vendor.reactExports, `react bundle missing ${name}`).toContain(name);
  }

  for (const name of vendor.reactExports.filter((n) => n !== 'default' && n !== 'Fragment')) {
    expect(vendor.reactStub, `react-stub missing ${name}`).toContain(`export const ${name} = undefined;`);
  }
});
