/**
 * What a codemode program receives when a call fails, and explainNativeToolReferenceError: a ReferenceError for a
 * native tool used as a codemode global becomes a correction naming that tool's own namespace from TOOL_REACH.
 */
import { describe, test, expect } from 'bun:test';
import * as v from 'valibot';
import { asSchema } from 'ai';
import { present } from '@kinu.run/test-utils';
import { explainNativeToolReferenceError } from '../src/tools/sandbox-errors';
import { BUILTIN_TOOLS, renderCodemodeDescription, TOOL_REACH } from '../src/tools/registry';
import { branchableToolCall, failedToolOutcome, successfulToolOutcome, withCodemodeProgram } from '../src/tools/outcome';
import { codemodeFunction, nativeToolFunctions } from '../src/tools/sandbox-contract';
import { censusToolFailures } from '../src/read-models/tool-failures';
import { KinuError } from '../src/obs';
import { ToolFailureValueSchema } from '../src/types/tool-outcome';
import { CRAFTED_TOOL_NAMESPACE } from '../src/types/codemode';
import { buildBuiltinTools } from '../src/tools/builtins';
import { createInlineExecutor, createNimbusWorkspaceExecutor, type InlineExecutorDeps } from '../src/tools/inline-executor';
import { createSandboxExecutor } from '../src/execution/sandbox';
import { createParentExecutor } from '../src/execution/parent';
import { createDeviceTunnelExecutor } from '../src/execution/device-tunnel-executor';
import { createStateCodemodeProvider } from '../src/tools/state-codemode';
import { createAgentsCodemodeProvider } from '../src/delegation/agents-codemode';
import { createReportCodemodeProvider } from '../src/delegation/report-codemode';
import { createReleaseCodemodeProvider } from '../src/release/codemode';
import { createMemoryCodemodeProvider } from '../src/tools/memory-codemode';
import { createTasksCodemodeProvider } from '../src/tools/tasks-codemode';
import { createDbCodemodeProvider } from '../src/tools/db-codemode';
import { createWebCodemodeProvider } from '../src/web/provider';
import { createAgentSelfProvider } from '../src/tools/agent-self';
import { createTestRuntime, storesFor } from './helpers';

/**
 * A dependency whose every property is another such double and none of which can be called, so each member takes
 * its own refusal path; `bind` hands back the method, so a member that binds one first still reaches its checks.
 * Keys in `absent` read as missing. The untyped `Object.create(null)` target stands in for every dependency shape.
 */
function refusingDouble(absent: ReadonlySet<string> = new Set()) {
  const handler = (missing: ReadonlySet<string>): ProxyHandler<object> => ({
    get: (_target, key) => {
      // No `then`: awaiting a double must not call it.
      if (key === 'then' || missing.has(String(key))) return undefined;
      const nested = new Proxy(Object.create(null), handler(new Set()));

      return key === 'bind' ? () => nested : nested;
    },
  });

  return new Proxy(Object.create(null), handler(absent));
}

/** Each result the description declares: what `Promise<…>` wraps after a signature, as its top-level union members. */
function declaredResults(description: string): string[][] {
  return [...description.matchAll(/\)\s*(?::|=>)\s*Promise</g)].map((match) => {
    const alternatives: string[] = [];
    let from = match.index + match[0].length;
    let depth = 0;

    for (let at = from; at < description.length && depth >= 0; at++) {
      const char = description[at];

      if ('<({['.includes(char)) depth++;
      else if ('>)}]'.includes(char) && description[at - 1] !== '=') depth--;

      if (depth < 0 || (depth === 0 && char === '|')) {
        alternatives.push(description.slice(from, at).trim());
        from = at + 1;
      }
    }

    return alternatives;
  });
}

test('a host rejection resolves to the same discriminated refusal as a native failure', async () => {
  const broken = branchableToolCall(async () => { throw new Error('host disconnected'); });
  expect(await broken).toEqual({ success: false, reason: null, error: 'host disconnected' });
  const refused = branchableToolCall(async () => { throw new KinuError('unavailable', 'file plane offline'); });
  expect(await refused).toEqual({ success: false, reason: 'unavailable', error: 'file plane offline' });
});

test('recovered host failures retain each binding in the census without failing the program', async () => {
  const output = await withCodemodeProgram(async () => {
    const file = codemodeFunction('tools', 'file', async () => { throw new KinuError('unavailable', 'offline'); });
    const command = codemodeFunction('workspace', 'exec', async () => ({ reason: 'io', error: 'failed', execution: { exitCode: 1 } }));
    const answers = await Promise.all([file({}), command('check')]);
    expect(answers).toEqual([
      { success: false, reason: 'unavailable', error: 'offline' },
      { success: false, reason: 'io', error: 'failed', execution: { exitCode: 1 } },
    ]);

    return { result: 'recovered' };
  });

  const outcome = successfulToolOutcome('eval', { output });
  expect(outcome.success).toBe(true);
  const census = censusToolFailures([{ type: 'tool_call_end', runId: 'shell', eventIndex: 0, timestamp: new Date(0).toISOString(), name: 'eval', toolCallId: 'call', outcome }]);
  expect(census.byKey).toEqual([['file·unavailable', 1], ['shell·exit_1', 1]]);
});

test('throwing the failure value propagates its native reason and a malformed program remains a ReferenceError', async () => {
  let error: unknown;

  try {
    await withCodemodeProgram(async () => {
      const file = codemodeFunction('tools', 'file', async () => { throw new KinuError('denied', 'blocked'); });
      throw await file({ action: 'write' });
    });
  } catch (cause) { error = cause; }

  expect(failedToolOutcome({ cause: error })).toMatchObject({ success: false, reason: 'denied', failures: [{ tool: 'file', action: 'write', reason: 'denied' }] });
  await expect(withCodemodeProgram(async () => { throw new ReferenceError('run is not defined'); })).rejects.toBeInstanceOf(ReferenceError);
});

test('a native tool a program calls runs only on input its own schema admits', async () => {
  let runs = 0;
  const { rt } = createTestRuntime();

  // Counted, not recorded: `toEqual([])` would pass on `[undefined]`, the command a call without one passes.
  const shell = {
    exec: async () => {
      runs += 1;

      return { stdout: 'ran', stderr: '', exitCode: 0 };
    },
  };

  const native = buildBuiltinTools({ rt: { ...rt, shell }, history: storesFor(rt).history });
  const admitted: string[] = [];

  // Every native tool whose schema requires a field is called without it.
  for (const [name, entry] of Object.entries(nativeToolFunctions(native))) {
    const declared = await asSchema(present(native[name], name).inputSchema).jsonSchema;

    if (!declared.required?.length) continue;
    const received = await codemodeFunction('tools', name, entry.execute)({});

    if (!v.is(v.object({ success: v.literal(false), reason: v.literal('bad_input') }), received)) admitted.push(`${name}: ${JSON.stringify(received)}`);
  }

  expect(admitted).toEqual([]);
  expect(await codemodeFunction('tools', 'shell', present(nativeToolFunctions(native).shell, 'shell').execute)({ command: 42 }))
    .toMatchObject({ success: false, reason: 'bad_input', error: expect.stringContaining('command') });
  // Neither call reached the shell.
  expect(runs).toBe(0);
});

test('every member of every namespace refuses with the one declared Refusal, and the program records it', async () => {
  const { rt } = createTestRuntime();
  const inline: InlineExecutorDeps = { filesOwner: 'agent', vfs: refusingDouble(), memory: refusingDouble(), craftStore: refusingDouble(), shell: refusingDouble() };

  const namespaces = [
    createInlineExecutor({ ...inline, slate: refusingDouble() }),
    createNimbusWorkspaceExecutor({ box: refusingDouble(), inline }),
    createSandboxExecutor(refusingDouble(), 'preview.test'),
    createSandboxExecutor(),
    createParentExecutor({ handle: refusingDouble() }),
    createDeviceTunnelExecutor(refusingDouble()),
    { name: CRAFTED_TOOL_NAMESPACE, types: '', tools: nativeToolFunctions(buildBuiltinTools({ rt, history: storesFor(rt).history })) },
    createStateCodemodeProvider(refusingDouble()),
    createAgentsCodemodeProvider(() => refusingDouble()),
    createReportCodemodeProvider(() => refusingDouble()),
    createReleaseCodemodeProvider(() => refusingDouble()),
    createReleaseCodemodeProvider(() => refusingDouble(new Set(['engine']))),
    createMemoryCodemodeProvider(() => refusingDouble()),
    createTasksCodemodeProvider(refusingDouble(), refusingDouble()),
    createDbCodemodeProvider(refusingDouble()),
    createWebCodemodeProvider(refusingDouble()),
    createAgentSelfProvider(refusingDouble()),
  ];

  // What the model reads: every member declared as a signature or a const (native tools by their schemas), and every
  // declared result admitting a Refusal.
  const undeclared = namespaces.filter((namespace) => namespace.name !== CRAFTED_TOOL_NAMESPACE).flatMap((namespace) => Object.keys(namespace.tools)
    .filter((member) => ![` ${member}(`, `const ${member}:`].some((form) => (namespace.types ?? '').includes(form)))
    .map((member) => `${namespace.name}.${member}`));

  const unadmitted = declaredResults(renderCodemodeDescription(namespaces.map((namespace) => namespace.types)))
    .filter((alternatives) => !alternatives.includes('Refusal') && !alternatives.includes('unknown'))
    .map((alternatives) => alternatives.join(' | '));

  // What a program receives through the binding both backends use: strings, numbers and objects reach each member's
  // backend or its own checks, and no arguments its missing-input refusal. A program binds its members when it
  // starts, so each call is bound inside the program that records it.
  const diverged: string[] = [];

  for (const namespace of namespaces) {
    for (const [member, entry] of Object.entries(namespace.tools)) {
      for (const args of [['x', 'y'], [1, 1], [{}, {}], []]) {
        let received: unknown;

        const run = await withCodemodeProgram(async () => {
          received = await codemodeFunction(namespace.name, member, entry.execute)(...args);

          return { result: null };
        });

        const refusal = v.safeParse(ToolFailureValueSchema, received);

        if (!refusal.success || run.failures?.length !== 1 || run.failures[0].error !== refusal.output.error) {
          diverged.push(`${namespace.name}.${member}(${args.map((arg) => JSON.stringify(arg)).join(', ')}) → ${JSON.stringify(received)}`);
        }
      }
    }
  }

  expect({ undeclared, unadmitted, diverged }).toEqual({ undeclared: [], unadmitted: [], diverged: [] });
});

describe('explainNativeToolReferenceError', () => {
  test('every native tool is pointed at tools.<name>, and at the namespace its reach declares', () => {
    for (const name of BUILTIN_TOOLS) {
      const namespace = TOOL_REACH[name].codemode;
      const out = explainNativeToolReferenceError(`${name} is not defined`);

      if (name === 'eval') {
        // eval IS the sandbox; a program cannot call it from inside itself.
        expect(out).toBe(`${name} is not defined`);
        continue;
      }

      expect(out).toContain(`"${name}" is a native Kinu tool`);
      expect(out).toContain(`call it as \`tools.${name}(input)\``);

      if (namespace) expect(out).toContain(`through the \`${namespace}\` namespace`);
    }
  });

  test('shell and file point at workspace; the six namespace owners point at themselves', () => {
    // Spelled out so the derivation above cannot pass by agreeing with a wrong declaration.
    expect(explainNativeToolReferenceError('shell is not defined')).toContain('`workspace` namespace');
    expect(explainNativeToolReferenceError('file is not defined')).toContain('`workspace` namespace');

    for (const name of ['agents', 'memory', 'tasks', 'web', 'report'] as const) {
      expect(explainNativeToolReferenceError(`${name} is not defined`)).toContain(`\`${name}\` namespace`);
    }
  });

  test('no native tool is told it is unreachable from inside eval', () => {
    for (const name of BUILTIN_TOOLS) {
      expect(explainNativeToolReferenceError(`${name} is not defined`))
        .not.toContain('not reachable from inside eval');
    }
  });

  test('eval itself is never rewritten — it names no OTHER tool', () => {
    const out = explainNativeToolReferenceError('eval is not defined');
    expect(out).toBe('eval is not defined');
  });

  test('an undefined identifier that is not a native tool name passes through unchanged', () => {
    const out = explainNativeToolReferenceError('fooBarBaz is not defined');
    expect(out).toBe('fooBarBaz is not defined');
  });

  test('an unrelated error message is never touched', () => {
    const messages = [
      'ENOENT: no such file or directory',
      'Execution timed out',
      'TypeError: Cannot read properties of undefined (reading \'foo\')',
      'run failed with exit code 1',
      'is not defined',  // no identifier captured: must not match
    ];

    for (const m of messages) expect(explainNativeToolReferenceError(m)).toBe(m);
  });
});
