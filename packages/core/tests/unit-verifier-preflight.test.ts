/**
 * THE INSTRUMENT IS ASKED WHETHER IT CAN RUN, ONCE, BEFORE A RUN IS ACCEPTED.
 *
 * What this exists to stop, measured on one production turn. A model asked for a
 * swarm demo, reached `agents.swarm` five times, and every call was refused:
 *
 *   1. an unregistered `kind`                       (the registry's guard)
 *   2. `spec` missing five fields                   (the spec schema)
 *   3. `spec` fields of the wrong type              (the spec schema)
 *   4. baseline faulted: the reference must declare `export function solve(...)`
 *   5. baseline faulted: the harness printed no RESULT line — the workspace's
 *      `node` shim cannot transform `.mjs` at all
 *
 * Refusals 4 and 5 arrived AFTER the spec validated, one per turn step, and the
 * turn was cut before it ever ran a search. Neither had to be discovered that way:
 * (4) is a rule the schema can state, and (5) is a property of the WORKSPACE that
 * no `spec` could change — so reporting the spec first sent the model to correct
 * fields behind a wall it had not been told about.
 *
 * So: (4) is a spec complaint now, delivered with the other spec complaints, and
 * (5) is a preflight the accept path runs once, ahead of the spec, refusing in the
 * executor's own words.
 *
 * The shell here is REAL — the same `createTestRuntime` shell the budget suite
 * measures through — so a passing preflight means a shell that genuinely ran a
 * module, not one that was mocked into agreeing.
 */
import { describe, expect, test } from 'bun:test';
import { createTestRuntime } from './helpers';
import {
  preflightVerifier, registeredVerifierKind, resolveVerifier, unregisteredKindRefusalFor,
} from '../src/strategy/verifier-registry';
import { preflightRatioHarness } from '../src/strategy/exec-ratio';
import type { MeasurementContext } from '../src/strategy/objective';

/** A measurement context over a real workspace VFS and a real shell. */
function liveContext(): MeasurementContext {
  const { rt } = createTestRuntime();
  const { shell } = rt;
  if (!shell) throw new Error('this runtime has no shell, so nothing can run a measurement in it');
  return { vfs: rt.storage.vfs, exec: (command) => shell.exec(command) };
}

/** A workspace whose shell answers every command the way the deployed cloud one
 *  does when `esbuild-wasm` refuses the `.mjs` transform: no RESULT line, exit 1,
 *  and the real reason on stderr. */
function brokenShellContext(): MeasurementContext {
  const { rt } = createTestRuntime();
  return {
    vfs: rt.storage.vfs,
    exec: async () => ({
      stdout: '',
      stderr: 'node: transform error for _measure_probe.mjs: esbuild init failed: '
        + 'The "wasmModule" option only works in the browser\n',
      exitCode: 1,
    }),
  };
}

describe('a workspace that CAN run the instrument passes its preflight', () => {
  test('a real shell answers with a RESULT line, so nothing is refused', async () => {
    expect(await preflightRatioHarness(liveContext())).toBeNull();
  });
  test('the registry routes the named kind to its own preflight', async () => {
    const kind = registeredVerifierKind('exec-ratio');
    if (kind === null) throw new Error('exec-ratio must resolve');
    expect(await preflightVerifier(kind, liveContext())).toBeNull();
  });
});

describe('a workspace that CANNOT run the instrument says so, in the executor\'s words', () => {
  test('the fault names the command, the exit code and the real cause', async () => {
    const fault = await preflightRatioHarness(brokenShellContext());
    expect(fault).not.toBeNull();
    // The command that was tried, so a reader knows what was measured.
    expect(fault!).toContain('node _measure_probe');
    expect(fault!).toContain('printed no RESULT line');
    expect(fault!).toContain('exit 1');
    // THE PRODUCTION STRING. Not paraphrased into "the instrument is unavailable":
    // the executor's own words are the only thing that names the real defect, which
    // lives in the workspace runtime rather than in this repository.
    expect(fault!).toContain('The "wasmModule" option only works in the browser');
  });

  test('a shell that throws is a fault, never an exception out of the preflight', async () => {
    const { rt } = createTestRuntime();
    const fault = await preflightRatioHarness({
      vfs: rt.storage.vfs,
      exec: async () => { throw new Error('no shell is attached to this workspace'); },
    });
    expect(fault).toContain('could not be run in this workspace\'s shell');
    expect(fault).toContain('no shell is attached to this workspace');
  });

  test('the preflight is independent of any spec — it is asked before one is validated', async () => {
    const kind = registeredVerifierKind('exec-ratio');
    if (kind === null) throw new Error('exec-ratio must resolve');
    expect(await preflightVerifier(kind, brokenShellContext())).not.toBeNull();
  });
});

describe('the reference rule is a spec complaint, not a faulted baseline', () => {
  const wellFormed = {
    params: { n: 3 },
    reference: 'export function solve(input, oracle) { return 0; }',
    body: 'emit({ refOps: 1, candOps: 1, refMs: 1, candMs: 1, correct: true, failure: null });',
    targetOps: 1,
    lowerBoundOps: 1,
  };

  test('a reference without the declaration is refused at validation, naming what is wrong', () => {
    const refused = resolveVerifier({
      kind: 'exec-ratio',
      spec: { ...wellFormed, reference: 'export default function go() { return 0; }' },
    });
    expect('reason' in refused).toBe(true);
    if (!('reason' in refused)) throw new Error('unreachable');
    // `bad_input`, so the caller knows the call is the thing to correct — a faulted
    // baseline reported this as `unavailable`, which reads as "not your fault".
    expect(refused.reason).toBe('bad_input');
    expect(refused.error).toContain('export function solve(input, oracle)');
    expect(refused.error).toContain('reference');
  });

  test('the control — a reference WITH the declaration resolves', () => {
    const resolved = resolveVerifier({ kind: 'exec-ratio', spec: wellFormed });
    expect('reason' in resolved).toBe(false);
  });
  test('an unregistered kind still refuses before anything else is asked', () => {
    // The name resolves to nothing, and the refusal a caller would get is the
    // bad_input value naming the registered kinds.
    expect(registeredVerifierKind('invented_kind_xyz')).toBeNull();
    const refused = unregisteredKindRefusalFor('invented_kind_xyz');
    expect(refused.reason).toBe('bad_input');
    expect(refused.error).toContain('exec-ratio');
  });
});
