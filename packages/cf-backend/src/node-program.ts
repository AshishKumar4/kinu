/**
 * An `eval` program that imports from the workspace (`programPlace`) runs as a Node program there, on Nimbus's node,
 * where `./lib.js` and a package in node_modules resolve as they do for the agent's own `node main.mjs`. It runs as one
 * command of the program's own `workspace.exec`, so under the actor's credential and exec id, with its egress and the
 * placeholder swap every command of the actor's has. Its namespaces are the program's own: each member a request to
 * {@link NODE_PROGRAM_HOST}, which only the actor's egress answers (`answerNodeProgramCall`), served here by the
 * provider the isolate would have called.
 *
 * Nimbus's node runs pure-JS packages only: a native addon (`.node`) does not load, and the program is told so.
 */
import * as v from 'valibot';
import { normalizeCode } from '@cloudflare/codemode/normalize';
import {
  decodeJsonValue, JsonValueSchema, KINU_NODE_MODULE_SOURCE, KINU_PROGRAM_MODULE, renderCraftedDefinitions, safeJsonParse,
  type CraftedToolSource, type EgressPrincipal, type JsonValue, type ProgramImport,
} from '@kinu.run/core';
import { renderThrownChain } from '@kinu.run/core/obs';
import type { ResolvedProvider } from '@cloudflare/codemode';

/** The host a Node program's namespace calls are sent to; no network has it, so only the actor's egress answers it. */
export const NODE_PROGRAM_HOST = 'kinu-tools.invalid';

/** The header a Node program's calls carry its token in: which running program, of its principal's, is calling. */
const PROGRAM_TOKEN_HEADER = 'x-kinu-program';

/** Who a program runs as: what its egress names, and so what may call its namespaces. */
export interface NodeProgramPrincipal {
  readonly workspace: string;
  readonly actorId: string | null;
  readonly as: 'owner' | 'viewer';
}

/** What a Node program is run with: its imports as `programPlace` found them, and the crafted tools its `tools` holds. */
export interface NodeProgram {
  readonly code: string;
  readonly imports: readonly ProgramImport[];
  readonly providers: readonly ResolvedProvider[];
  readonly principal: NodeProgramPrincipal;
  readonly cwd: string;
  readonly crafted: readonly CraftedToolSource[];
  /** The `describe` function every program is given (`describeProgramSource`). */
  readonly prelude: string;
}

interface LiveProgram {
  readonly principal: NodeProgramPrincipal;
  readonly providers: readonly ResolvedProvider[];
}

/** Each running Node program's namespaces, by the token its module holds, for as long as it runs. */
const live = new Map<string, LiveProgram>();

const CallSchema = v.object({ namespace: v.string(), member: v.string(), args: v.array(JsonValueSchema) });

/** A command's answer with `parts`, or the refusal it was answered with instead. */
const ExecOutcomeSchema = v.union([v.object({ exitCode: v.number(), stdout: v.string(), stderr: v.string() }), v.object({ error: v.string() })]);

const AnswerSchema = v.union([v.object({ value: v.unknown() }), v.object({ error: v.string() })]);

/** What a Node program's namespace call is answered with: its status, and `{ value }` or `{ thrown }`. */
export interface NodeProgramAnswer {
  readonly status: number;
  readonly body: JsonValue;
}

/** A Node program's call of `namespace.member(...args)`, as its principal's egress handed it on. */
export async function serveNodeProgramCall(principal: EgressPrincipal | undefined, token: string | null, body: JsonValue): Promise<NodeProgramAnswer> {
  const program = token === null ? undefined : live.get(token);

  // A token names one live program, and only its own principal's egress may use it; a viewer's egress names no actor.
  const own = principal !== undefined && program !== undefined && principal.as === program.principal.as
    && (principal.actorId === null || principal.actorId === program.principal.actorId);

  if (!own) return { status: 403, body: { thrown: 'This program is not running, or not as this caller.' } };
  const call = v.safeParse(CallSchema, body);

  if (!call.success) return { status: 400, body: { thrown: 'A namespace call names its namespace, member and arguments.' } };
  const { namespace, member, args } = call.output;
  const fn = program.providers.find((provider) => provider.name === namespace)?.fns[member];

  if (fn === undefined) return { status: 200, body: { thrown: `${namespace}.${member} is not a member this program holds.` } };
  const [answered] = await Promise.allSettled([fn(...args)]);

  return answered.status === 'fulfilled'
    ? { status: 200, body: { value: decodeJsonValue({ value: answered.value ?? null }) ?? null } }
    : { status: 200, body: { thrown: renderThrownChain({ cause: answered.reason }) } };
}

/** The workspace object a Node program's call is answered in, by its name. */
export type NodeProgramHost = (workspace: string) => Promise<{ nodeProgramCall(principal: EgressPrincipal | undefined, token: string | null, body: JsonValue): Promise<NodeProgramAnswer> }>;

/**
 * A Node program's namespace call as its egress received it, handed to the workspace object running the program
 * (`OrchestratorAgent.nodeProgramCall`), where its namespaces are; a body that is not JSON never gets that far.
 */
export async function forwardNodeProgramCall(request: Request, principal: EgressPrincipal | undefined, host: NodeProgramHost): Promise<Response> {
  if (principal === undefined) return Response.json({ thrown: 'This program has no workspace to call.' }, { status: 403 });
  const body = safeJsonParse(await request.text());
  const answer = await (await host(principal.workspace)).nodeProgramCall(principal, request.headers.get(PROGRAM_TOKEN_HEADER), body);

  return Response.json(answer.body, { status: answer.status });
}

/** The module `import … from 'kinu'` names: each namespace's members as functions that call the host. */
function kinuModule(token: string, providers: readonly ResolvedProvider[]): string {
  const members = Object.fromEntries(providers.map((provider) => [provider.name, Object.keys(provider.fns)]));
  const named = providers.map((provider) => provider.name).filter((name) => /^[A-Za-z_$][\w$]*$/u.test(name) && name !== 'namespaces');

  return [
    KINU_NODE_MODULE_SOURCE,
    `const __kinuToken = ${JSON.stringify(token)};`,
    'async function __kinuCall(namespace, member, args) {',
    `  const response = await fetch(${JSON.stringify(`https://${NODE_PROGRAM_HOST}/call`)}, {`,
    `    method: 'POST', headers: { 'content-type': 'application/json', ${JSON.stringify(PROGRAM_TOKEN_HEADER)}: __kinuToken },`,
    '    body: JSON.stringify({ namespace, member, args }),',
    '  });',
    '  const answer = await response.json();',
    '  if (answer.thrown !== undefined) throw new Error(answer.thrown);',
    '  return answer.value;',
    '}',
    'function __kinuNamespace(name, members) {',
    '  const root = {};',
    '  for (const member of members) {',
    "    const path = member.split('.');",
    '    let at = root;',
    '    for (const part of path.slice(0, -1)) at = at[part] ??= {};',
    '    at[path[path.length - 1]] = (...args) => __kinuCall(name, member, args);',
    '  }',
    '  return root;',
    '}',
    `export const namespaces = Object.fromEntries(Object.entries(${JSON.stringify(members)}).map(([name, list]) => [name, __kinuNamespace(name, list)]));`,
    ...named.map((name) => `export const ${name} = namespaces[${JSON.stringify(name)}];`),
  ].join('\n');
}

/** The program as a module: its imports first ('kinu' made the module beside it), then its body as the isolate runs one. */
function programModule(program: NodeProgram, kinu: string, marker: string): string {
  const { code, imports } = program;
  let body = code;

  // From the end, so each removal leaves the earlier ranges where they were.
  for (const declared of [...imports].sort((a, b) => b.start - a.start)) body = `${body.slice(0, declared.start)}${body.slice(declared.end)}`;

  const hoisted = imports.map((declared) => (declared.specifier === KINU_PROGRAM_MODULE
    ? `${code.slice(declared.start, declared.sourceStart)}${JSON.stringify(kinu)}${code.slice(declared.sourceEnd, declared.end)}`
    : code.slice(declared.start, declared.end)));

  const bound = program.providers.map((provider) => provider.name).filter((name) => /^[A-Za-z_$][\w$]*$/u.test(name));

  return [
    ...hoisted,
    `import * as __kinu from ${JSON.stringify(kinu)};`,
    "import { createRequire as __kinuCreateRequire } from 'node:module';",
    'const require = __kinuCreateRequire(import.meta.url);',
    ...bound.map((name) => `const ${name} = __kinu.namespaces[${JSON.stringify(name)}];`),
    ...bound.includes('tools') ? [] : ['const tools = {};'],
    ...bound.includes('env') ? [] : [`const env = Object.freeze({ ...process.env, workspace: ${JSON.stringify(program.principal.workspace)} });`],
    program.prelude,
    renderCraftedDefinitions(program.crafted),
    `const __kinuMain = ${normalizeCode(body)};`,
    'let __kinuAnswer;',
    'try {',
    '  const value = await __kinuMain();',
    '  __kinuAnswer = { value: value === undefined ? null : value };',
    '} catch (error) {',
    "  const text = error && error.stack ? String(error.stack) : String(error);",
    '  __kinuAnswer = { error: text };',
    '}',
    `process.stdout.write(${JSON.stringify(`\n${marker}`)} + JSON.stringify(__kinuAnswer) + '\\n');`,
  ].join('\n');
}

/** A file written whole by one command: a heredoc no line of `content` can close early. */
function writeCommand(path: string, content: string, fence: string): string {
  return `cat > ${JSON.stringify(path)} <<'${fence}'\n${content}\n${fence}`;
}

/** Why a program that loads a native addon fails, said once: Nimbus's node loads none. */
function explained(error: string): string {
  return /\.node\b|ERR_DLOPEN|native module|native addon/iu.test(error)
    ? `${error}\nNative addons (compiled .node files) don't load here: use a pure-JS package.`
    : error;
}

/**
 * Runs `program` as a Node program in its working directory, in one command: Kinu's module written beside the
 * program's private temporary files, the program's own in its working directory as a hidden file, so its relative
 * imports and node_modules resolve from where the agent works; both removed when it ends. Its answer is its stdout's
 * last line, behind a marker no output of its own can forge.
 */
export async function runNodeProgram(program: NodeProgram): Promise<{ result: unknown; error?: string; logs?: string[] }> {
  const exec = program.providers.find((provider) => provider.name === 'workspace')?.fns['exec'];

  if (exec === undefined) return { result: undefined, error: 'This program imports from the workspace, and this caller cannot run commands there.' };
  const id = crypto.randomUUID().replaceAll('-', '');
  const token = crypto.randomUUID();
  const dir = `/tmp/kinu-eval-${id}`;
  const kinu = `${dir}/kinu.mjs`;
  const main = `.kinu-eval-${id}.mjs`;
  const marker = `\u001eKINU_EVAL_ANSWER_${id} `;
  const fence = `KINU_EVAL_${id}`;

  live.set(token, { principal: program.principal, providers: program.providers });

  try {
    const command = [
      `mkdir -p ${dir}`, writeCommand(kinu, kinuModule(token, program.providers), fence), writeCommand(main, programModule(program, kinu, marker), fence),
      `node ${main}; status=$?; rm -rf ${main} ${dir}; exit $status`,
    ].join('\n');

    const ran = v.safeParse(ExecOutcomeSchema, await exec(command, { cwd: program.cwd, parts: true }));

    if (!ran.success) return { result: undefined, error: 'The workspace answered the program with something other than its output.' };

    if ('error' in ran.output) return { result: undefined, error: ran.output.error };
    const { stdout, stderr, exitCode } = ran.output;
    const at = stdout.lastIndexOf(marker);
    const logs = (at < 0 ? stdout : stdout.slice(0, at)).split('\n').filter((line) => line !== '');

    if (stderr.trim() !== '') logs.push(...stderr.trim().split('\n'));

    if (at < 0) return { result: undefined, error: explained(stderr.trim() || `node exited ${String(exitCode)} before the program answered`), logs };
    const answer = v.safeParse(AnswerSchema, safeJsonParse(stdout.slice(at + marker.length).split('\n')[0] ?? 'null'));

    if (!answer.success) return { result: undefined, error: 'The program answered with a value that is not JSON.', logs };

    return 'error' in answer.output ? { result: undefined, error: explained(answer.output.error), logs } : { result: answer.output.value, logs };
  } finally {
    live.delete(token);
  }
}
