/**
 * Refinement of `Safety/DeviceView.lean — Sandboxed.classify` by the deployed view: each case in
 * `lean/fixtures/device-view.json` is laid out as a real tree with real links, and
 * `viewFor(...).classify` must reach the model's path and give it the model's access.
 * `bash scripts/verify-lean.sh` regenerates the fixture from the model.
 */
'use strict';

const { scratchDir } = require('../../test-utils/src/scratch');

const { describe, expect, test } = require('bun:test');

const fs = require('node:fs');

const path = require('node:path');

const sandbox = require('../src/sandbox.js');

const FIXTURE = path.resolve(__dirname, '../../../lean/fixtures/device-view.json');

const { cases } = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));

const ACCESS = {
  invisible: sandbox.VIEW_INVISIBLE,
  'read-only': sandbox.VIEW_READ_ONLY,
  writable: sandbox.VIEW_WRITABLE,
};

describe('viewFor refines DeviceView.classify', () => {
  test('the fixture reaches every access, and follows links', () => {
    const accesses = new Set(cases.flatMap((c) => c.probes.map((probe) => probe.access)));
    expect(accesses).toEqual(new Set(Object.keys(ACCESS)));
    expect(cases.some((c) => c.links.length > 0)).toBe(true);
  });

  test.each(cases.map((c, i) => [i, c]))('case %d', (_i, c) => {
    const root = fs.realpathSync(scratchDir('pc-agent-device-view'));
    const at = (segments) => path.join(root, ...segments);

    for (const dir of c.dirs) fs.mkdirSync(at(dir), { recursive: true });

    for (const file of c.files) fs.writeFileSync(at(file), 'fixture');

    for (const link of c.links) fs.symlinkSync(at(link.to), at(link.at));

    // macOS's view: no host mount and no temp remap, and nothing here is under MAC_DENY_SUBPATHS.
    const view = sandbox.viewFor({
      platform: 'darwin',
      home: at(['elsewhere']),
      agentHome: at([...c.deviceHome, 'agents', c.workspace, 'home']),
      deviceHome: at(c.deviceHome),
      roots: c.roots.map(at),
    });

    for (const probe of c.probes) {
      const decision = view.classify(at(probe.requested));
      expect({ requested: probe.requested, path: decision.path, access: decision.access })
        .toEqual({ requested: probe.requested, path: at(probe.reached), access: ACCESS[probe.access] });
    }
  });
});
