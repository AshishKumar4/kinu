import { AwsClient } from 'aws4fetch';
import * as v from 'valibot';
import { r2ResiduePlane } from '../../bench-devbox-fixture';

/** A permanent, fixture-only bucket: an armada checkout or its release worktree is not durable state. */
export const CONTRACT_TEARDOWN_BUCKET = 'kinu-devbox-contracts-teardown';

const PREFIX = 'devbox-contracts/';

const Run = v.pipe(v.string(), v.regex(/^dc\d{14}[a-f0-9]{5}$/u));

export const ContractTeardownSchema = v.object({
  schema: v.literal('devbox-contracts/teardown@1'),
  run: Run,
  worker: v.string(),
  app: v.string(),
  bucket: v.string(),
  boxes: v.array(v.string()),
  declared: v.string(),
  origin: v.optional(v.string()),
  snapshots: v.array(v.string()),
  applicationIds: v.array(v.string()),
  /** Armada's enforced task wall, from the checkout's .armada.json, not an inactivity guess. */
  notAfter: v.pipe(v.number(), v.safeInteger()),
});

export type ContractTeardown = v.InferOutput<typeof ContractTeardownSchema>;

export interface ContractLedger {
  put(manifest: ContractTeardown): Promise<void>;
  remove(run: string): Promise<void>;
  pending(now: number): Promise<readonly ContractTeardown[]>;
}

/** Only records of this fixture kind qualify, and a live platform-bounded task is never replayed. */
export function expiredContracts(manifests: readonly ContractTeardown[], now: number): readonly ContractTeardown[] {
  return manifests.filter(manifest => now > manifest.notAfter).sort((left, right) => left.notAfter - right.notAfter);
}

export function contractLedger(deps: {
  readonly account: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}): ContractLedger {
  const client = new AwsClient({ accessKeyId: deps.accessKeyId, secretAccessKey: deps.secretAccessKey, service: 's3', region: 'auto' });
  const residue = r2ResiduePlane({ accountId: deps.account, accessKeyId: deps.accessKeyId, secretAccessKey: deps.secretAccessKey });
  const origin = `https://${deps.account}.r2.cloudflarestorage.com/${CONTRACT_TEARDOWN_BUCKET}`;
  const key = (run: string) => `${PREFIX}${v.parse(Run, run)}.json`;

  const request = async (object: string, options: RequestInit = {}): Promise<Response> => {
    const response = await client.fetch(`${origin}/${encodeURIComponent(object)}`, options);

    if (!response.ok && response.status !== 404) throw new Error(`contract teardown ${options.method ?? 'GET'} ${object}: ${String(response.status)}`);

    return response;
  };

  return {
    put: async manifest => {
      v.parse(ContractTeardownSchema, manifest);
      const response = await request(key(manifest.run), { method: 'PUT', body: JSON.stringify(manifest), headers: { 'content-type': 'application/json' } });

      if (!response.ok) throw new Error(`contract teardown manifest was not persisted: ${String(response.status)}`);
    },
    remove: async run => {
      await request(key(run), { method: 'DELETE' });
    },
    pending: async now => {
      const manifests: ContractTeardown[] = [];

      for (const object of await residue.listObjects(CONTRACT_TEARDOWN_BUCKET)) {
        if (!object.startsWith(PREFIX)) continue;
        const response = await request(object);

        // Another completed replay may have removed this exact record after the listing.
        if (response.status === 404) continue;
        const manifest = v.parse(ContractTeardownSchema, await response.json());

        if (object !== key(manifest.run)) throw new Error(`contract teardown key does not name its recorded run: ${object}`);
        manifests.push(manifest);
      }

      return expiredContracts(manifests, now);
    },
  };
}
