/**
 * The instrument is asked once, before a run is accepted, whether it can run. A workspace fault
 * no `spec` could fix is reported ahead of the spec, in the executor's own words, over a real shell.
 */
import { describe, expect, test } from 'bun:test';
import { createTestRuntime } from './helpers';
import {
  preflightVerifier, registeredVerifierKind, resolveVerifier, unregisteredKindRefusalFor,
} from '../src/strategy/verifier-registry';
import { preflightRatioHarness } from '../src/strategy/exec-ratio';
import type { MeasurementContext } from '../src/strategy/objective';
import { present } from '@kinu.run/test-utils';

function liveContext(): MeasurementContext {
  const { rt } = createTestRuntime();
  const { shell } = rt;

  if (!shell) throw new Error('this runtime has no shell, so nothing can run a measurement in it');

  return { vfs: rt.storage.vfs, exec: (command) => shell.exec(command) };
}

/** A shell that answers the way the cloud one does when `esbuild-wasm` refuses the `.mjs` transform. */
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
    const fault = present(await preflightRatioHarness(brokenShellContext()), 'the preflight fault');
    expect(fault).not.toBeNull();
    expect(fault).toContain('node _measure_probe');
    expect(fault).toContain('printed no RESULT line');
    expect(fault).toContain('exit 1');
    // The executor's own words, not a paraphrase: they name the real workspace defect.
    expect(fault).toContain('The "wasmModule" option only works in the browser');
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
    // `bad_input`: the call is the thing to correct.
    expect(refused.reason).toBe('bad_input');
    expect(refused.error).toContain('export function solve(input, oracle)');
    expect(refused.error).toContain('reference');
  });

  test('the control — a reference WITH the declaration resolves', () => {
    const resolved = resolveVerifier({ kind: 'exec-ratio', spec: wellFormed });
    expect('reason' in resolved).toBe(false);
  });
  test('an unregistered kind still refuses before anything else is asked', () => {
    expect(registeredVerifierKind('invented_kind_xyz')).toBeNull();
    const refused = unregisteredKindRefusalFor('invented_kind_xyz');
    expect(refused.reason).toBe('bad_input');
    expect(refused.error).toContain('exec-ratio');
  });
});
