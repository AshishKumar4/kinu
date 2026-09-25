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

  test('(b) anything but FROM, COPY, WORKDIR, ENV, EXPOSE, USER, LABEL and CMD, or a foreign program, keeps it in the set', () => {
    const cases: ReadonlyArray<readonly [string, (text: string) => string]> = [
      ['uses `RUN`', (text) => text.replace('USER node', 'RUN wget https://example.com/agent.js\nUSER node')],
      ['uses `ENTRYPOINT`', (text) => text.replace(/^CMD /mu, 'ENTRYPOINT ["sh", "-c", "$CODE"]\nCMD ')],
      ['uses `ONBUILD`', (text) => text.replace('USER node', 'ONBUILD RUN wget https://example.com/agent.js\nUSER node')],
      ['uses `ADD`', (text) => text.replace('COPY server.mjs policy.mjs .', 'ADD https://example.com/agent.js .\nCOPY server.mjs policy.mjs .')],
      ['uses `RUN`', (text) => text.replace('COPY server.mjs policy.mjs .', 'COPY server.mjs policy.mjs \\\n  .\nLABEL a=b \\\nRUN=1\nRUN \\\n  wget https://example.com/x')],
      ['not a tracked file', (text) => text.replace('COPY server.mjs policy.mjs .', 'COPY server.mjs \\\n  agent.js .')],
      ['not a pinned digest', (text) => text.replace(/^FROM .*$/mu, 'FROM node:22-alpine')],
      ['not one tracked script', (text) => text.replace(/^CMD .*$/mu, 'CMD ["node", "-e", "require(process.env.CODE)"]')],
      ['sets a NODE_ variable', (text) => text.replace('USER node', 'ENV NODE_OPTIONS=--import=data:text/javascript,x\nUSER node')],
      ['names CMD twice', (text) => `${text}CMD ["node", "server.mjs"]\n`],
    ];

    for (const [reason, rewrite] of cases) {
      const rewritten = withFile(DOCKERFILE, rewrite);

      expect({ reason, changed: rewritten.sourceFiles.get(DOCKERFILE) !== live().sourceFiles.get(DOCKERFILE) }).toEqual({ reason, changed: true });
      expect({ reason, found: auditForwarder(rewritten).join('\n').includes(reason) }).toEqual({ reason, found: true });
    }
  });

  test('(c) a way for a caller to change what the container runs keeps it in the set', () => {
    const text = live().fileText;
    const start = '  override async start(): Promise<void> {\n    await super.start();\n  }\n';
    const ports = 'await super.startAndWaitForPorts(this.defaultPort, cancellation?.abort === undefined ? undefined : { abort: cancellation.abort });';

    expect(text).toContain(start);
    expect(text).toContain(ports);

    const cases: ReadonlyArray<readonly [string, string]> = [
      ['super.start with arguments', text.replace(start, '  override async start(options?: object): Promise<void> {\n    await super.start(options);\n  }\n')],
      ['does not override `start`', text.replace(start, '')],
      ['super.startAndWaitForPorts with other than', text.replace(ports, 'await super.startAndWaitForPorts(_ports as number, undefined, { entrypoint: [\'sh\'] });')],
      ['declares `entrypoint`', text.replace('  sleepAfter = \'5m\';', '  sleepAfter = \'5m\';\n\n  entrypoint = [\'sh\', \'-c\', \'id\'];')],
      ['touches `this.envVars`', text.replace('    await super.start();', '    this.envVars = { NODE_OPTIONS: \'--require /tmp/x\' };\n    await super.start();')],
      ['carries a decorator', text.replace('export class CodexEgress', '@withRun\nexport class CodexEgress')],
      ['does not override `allowHost`', text.replace('  override async allowHost(): Promise<void> { refuseOutbound(); }\n', '')],
      ['computed name', text.replace('    await super.start();', '    await this[\'st\' + \'art\']();')],
    ];

    for (const [reason, planted] of cases) {
      expect(planted).not.toBe(text);
      const found = auditForwarder({ ...live(), fileText: planted }).join('\n');

      expect({ reason, found: found.includes(reason) }).toEqual({ reason, found: true });
    }
  });
});
