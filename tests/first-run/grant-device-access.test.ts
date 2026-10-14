// grantDeviceAccess names its machine: the consent raise carries the device
// name as executeInExecutor's third argument, fleet warm-up answers are
// retried rather than read as refusals, the call parks NOT RUN on the card it
// raised, the listed card is resolved `always`, and the call is re-issued —
// against a scripted hub, so no credential or deployment.
//
// The first-run two-machines case grants each machine through this helper.
// Its raise named no machine, so with two live the fleet refused it locally,
// the refusal string parsed as a success, and the grant read as "no device
// consent card was ever raised". The contract (docs/EXECUTION-LAYER-SPEC.md
// "The user's account is a fleet", AGENTS.md § Execution Layer) says every
// device call names its machine when several are live.
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
 *  refusal, a parked call's refusal, a run, a pending-consent listing, or a
 *  resolve acknowledgement. */
type HubAnswer =
  | { readonly result: { readonly error: string } }
  | { readonly result: { readonly stdout: string; readonly exitCode?: number; readonly refusal?: { readonly success: false; readonly reason: string; readonly error: string } } }
  | { readonly result: ReadonlyArray<{ readonly consentId: string; readonly deviceId: string }> }
  | { readonly result: { readonly ok: boolean } };

/** What the workspace answers a device call parked on its consent card (`deviceConsentQueued`), as router.ts packs a
 *  tool refusal: its words on stdout, exit 1, and the refusal. */
const PARKED = "NOT RUN: using kinu-beta from this workspace waits on the owner's consent. You are woken when they answer; do not re-issue it before then.";

interface SeenCall {
  readonly method: string;
  readonly args: readonly unknown[];
}

describe('grantDeviceAccess names its machine', () => {
  const realFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = realFetch; });

  test('the raise carries the device name, retries fleet warm-up, resolves the card, and re-issues the call', async () => {
    const seen: SeenCall[] = [];
    let raises = 0;
    let resolvedWith: string[] | null = null;

    const answer = (value: HubAnswer): Response =>
      new Response(JSON.stringify(value), { status: 200 });

    globalThis.fetch = asFetchFunction(async (input, init) => {
      const body = v.parse(RpcCallSchema, JSON.parse(v.parse(v.string(), init?.body)));
      seen.push({ method: body.method, args: body.args });

      if (body.method === 'executeInExecutor') {
        raises += 1;

        // The workspace's device snapshot starts cold: "not available" first,
        // then the fleet answer before the snapshot knows the machine.
        if (raises === 1) return answer({ result: { error: 'Executor "device" is not available' } });

        if (raises === 2) {
          return answer({ result: { stdout: '{"reason":"unavailable","error":"the device list is not known here yet"}' } });
        }

        // The third reaches the hub and parks NOT RUN on the card it raised; the re-issue after the answer runs.
        if (resolvedWith === null) return answer({ result: { stdout: PARKED, exitCode: 1, refusal: { success: false, reason: 'unavailable', error: PARKED } } });

        return answer({ result: { stdout: '', exitCode: 0 } });
      }

      if (body.method === 'listPendingConsents') {
        return answer({ result: [{ consentId: 'cons-0', deviceId: 'dev-alpha' }, { consentId: 'cons-1', deviceId: 'dev-beta' }] });
      }

      if (body.method === 'resolveDeviceConsent') {
        resolvedWith = v.parse(v.array(v.string()), body.args);

        return answer({ result: { ok: true } });
      }

      const url = input instanceof Request ? input.url : String(input);

      throw new Error(`unexpected RPC method ${body.method} at ${url}`);
    });

    await grantDeviceAccess(ACCOUNT, 'dev-beta', 'workspace-a', 'kinu-beta');

    // Every raise named the machine — that is what mints beta's card rather
    // than the fleet's unnamed-call refusal.
    const raiseArgs = seen.filter((call) => call.method === 'executeInExecutor').map((call) => call.args);
    expect(raiseArgs).toHaveLength(4);

    for (const args of raiseArgs) {
      expect(v.parse(v.array(v.string()), args)).toEqual(['device', 'true', 'kinu-beta']);
    }

    // The machine's own card is the one answered `always`, before the re-issue that spends it.
    const [consentId = '', decision = ''] = resolvedWith ?? [];
    expect(consentId).toBe('cons-1');
    expect(decision).toBe('always');
    expect(seen.map((call) => call.method).slice(-3)).toEqual(['listPendingConsents', 'resolveDeviceConsent', 'executeInExecutor']);
  });
});
