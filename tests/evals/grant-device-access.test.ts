// grantDeviceAccess names its machine: the consent raise carries the device
// name as executeInExecutor's third argument, fleet warm-up answers are
// retried rather than read as refusals, and the listed card is resolved
// `always` — against a scripted hub, so no credential or deployment.
//
// The first-run two-machines case grants each machine through this helper.
// Its raise named no machine, so with two live the fleet refused it locally,
// the refusal string parsed as a success, and the grant read as "no device
// consent card was ever raised". The contract (docs/EXECUTION-LAYER-SPEC.md
// "The user's account is a fleet", AGENTS.md § Execution Layer) says every
// laptop call names its machine when several are live.
import { describe, expect, test, afterEach } from 'bun:test';
import * as v from 'valibot';
import { asFetchFunction } from '@kinu.run/core';
import { grantDeviceAccess, type DeviceAccount } from './device-session';

const ACCOUNT: DeviceAccount = {
  origin: 'https://kinu.example.com',
  cliToken: 'cli-token',
  identity: { kind: 'secret', secret: 'secret' },
};

/** The RPC envelope the helper speaks: a method plus JSON arguments. */
const RpcCallSchema = v.object({ method: v.string(), args: v.array(v.unknown()) });

/** The hub answers this stub ever sends: an executor error, a tool stdout
 *  refusal, a pending-consent listing, or a resolve acknowledgement. */
type HubAnswer =
  | { readonly result: { readonly error: string } }
  | { readonly result: { readonly stdout: string } }
  | { readonly result: ReadonlyArray<{ readonly consentId: string }> }
  | { readonly result: { readonly ok: boolean } };

interface SeenCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

describe('grantDeviceAccess names its machine', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  test('the raise carries the device name, retries fleet warm-up, and resolves the card', async () => {
    const seen: SeenCall[] = [];
    const parked = Promise.withResolvers<{ status: number; text: string }>();
    let raises = 0;
    let polls = 0;
    let resolvedWith: string[] | null = null;

    const answer = (value: HubAnswer): Response =>
      new Response(JSON.stringify(value), { status: 200 });
    globalThis.fetch = asFetchFunction(async (input, init) => {
      const body = v.parse(RpcCallSchema, JSON.parse(String(init?.body)));
      seen.push({ method: body.method, args: body.args });
      if (body.method === 'executeInExecutor') {
        raises += 1;
        // The workspace's device snapshot starts cold: "not available" first,
        // then the fleet answer before the snapshot knows the machine.
        if (raises === 1) return answer({ result: { error: 'Executor "laptop" is not available' } });
        if (raises === 2) {
          return answer({ result: { stdout: '{"reason":"unavailable","error":"the device list is not known here yet"}' } });
        }
        // The third raise reaches the hub and parks on the card it raised.
        return parked.promise.then(({ status, text }) => new Response(text, { status }));
      }
      if (body.method === 'listPendingConsents') {
        polls += 1;
        if (polls < 3) return answer({ result: [] });
        return answer({ result: [{ consentId: 'cons-1' }] });
      }
      if (body.method === 'resolveDeviceConsent') {
        resolvedWith = v.parse(v.array(v.string()), body.args);
        // Settling the card unblocks the parked raise with the command's answer.
        parked.resolve({ status: 200, text: JSON.stringify({ result: { stdout: '' } }) });
        return answer({ result: { ok: true } });
      }
      throw new Error(`unexpected RPC method ${body.method} at ${String(input)}`);
    });

    await grantDeviceAccess(ACCOUNT, 'dev-beta', 'workspace-a', 'kinu-beta');

    // Every raise named the machine — that is what mints beta's card rather
    // than the fleet's unnamed-call refusal.
    const raiseArgs = seen.filter((call) => call.method === 'executeInExecutor').map((call) => call.args);
    expect(raiseArgs.length).toBeGreaterThanOrEqual(3);
    for (const args of raiseArgs) {
      expect(v.parse(v.array(v.string()), args)).toEqual(['laptop', 'true', 'kinu-beta']);
    }
    // The card the polls found is the one answered `always`.
    const [consentId = '', decision = ''] = resolvedWith ?? [];
    expect(consentId).toBe('cons-1');
    expect(decision).toBe('always');
  });
});
