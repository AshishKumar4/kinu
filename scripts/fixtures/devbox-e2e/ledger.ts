import { AwsClient } from 'aws4fetch';
import * as v from 'valibot';
import { r2ResiduePlane } from '../../bench-devbox-fixture';

/** A permanent, fixture-only bucket: an armada checkout or its release worktree is not durable state. */
export const CONTRACT_TEARDOWN_BUCKET = 'kinu-devbox-contracts-teardown';

const PREFIX = 'devbox-contracts/';

const Run = v.pipe(v.string(), v.regex(/^dc\d{14}[a-f0-9]{5}$/u));

export const ContractOwnerSchema = v.object({
  job: v.pipe(v.string(), v.nonEmpty()),
  index: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  attempt: v.pipe(v.number(), v.safeInteger(), v.minValue(1)),
  vessel: v.pipe(v.string(), v.nonEmpty()),
  statusUrl: v.pipe(v.string(), v.nonEmpty()),
  /** Job-scoped, status-only capability. Kept only in the private ledger, never report artifacts. */
  statusToken: v.pipe(v.string(), v.nonEmpty()),
});

export type ContractOwner = v.InferOutput<typeof ContractOwnerSchema>;

const TaskStatus = v.object({
  job: v.string(), index: v.number(), attempt: v.number(),
  running: v.array(v.object({ vessel: v.string(), attempt: v.number() })),
});

/** Every physical copy remains in armada's run list until its process/container is gone. */
export function contractRunEnded(owner: ContractOwner, status: v.InferOutput<typeof TaskStatus>): boolean {
  if (status.job !== owner.job || status.index !== owner.index || status.attempt < owner.attempt) throw new Error('armada task status does not describe the recorded fixture owner');

  return !status.running.some(run => run.vessel === owner.vessel && run.attempt === owner.attempt);
}

export function contractOwner(env: Readonly<Record<string, string | undefined>>): ContractOwner {
  const parsed = v.safeParse(ContractOwnerSchema, {
    job: env['ARMADA_JOB_ID'], index: Number(env['ARMADA_INDEX']), attempt: Number(env['ARMADA_ATTEMPT']),
    vessel: env['ARMADA_VESSEL'], statusUrl: env['ARMADA_STATUS_URL'], statusToken: env['ARMADA_STATUS_TOKEN'],
  });

  if (!parsed.success) throw new Error('Devbox contracts require armada task identity and its scoped status capability');

  return parsed.output;
}

export const ContractTeardownSchema = v.object({
  schema: v.literal('devbox-contracts/teardown@2'),
  run: Run,
  worker: v.string(),
  app: v.string(),
  bucket: v.string(),
  boxes: v.array(v.string()),
  declared: v.string(),
  origin: v.optional(v.string()),
  snapshots: v.array(v.string()),
  applicationIds: v.array(v.string()),
  owner: ContractOwnerSchema,
});

export type ContractTeardown = v.InferOutput<typeof ContractTeardownSchema>;

export interface ContractLedger {
  put(manifest: ContractTeardown): Promise<void>;
  remove(run: string): Promise<void>;
  pending(): Promise<readonly ContractTeardown[]>;
}

export async function contractOwnerEnded(owner: ContractOwner, query: (url: string, init: RequestInit) => Promise<Response> = fetch): Promise<boolean> {
  const response = await query(`${owner.statusUrl}/${String(owner.index)}`, { headers: { authorization: `Bearer ${owner.statusToken}` } });

  if (!response.ok) throw new Error(`armada fixture owner ${owner.job}/${String(owner.index)} status answered ${String(response.status)}; its lifetime is unknown`);

  return contractRunEnded(owner, v.parse(TaskStatus, await response.json()));
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
    pending: async () => {
      const manifests: ContractTeardown[] = [];

      for (const object of await residue.listObjects(CONTRACT_TEARDOWN_BUCKET)) {
        if (!object.startsWith(PREFIX)) continue;
        const response = await request(object);

        // Another completed replay may have removed this exact record after the listing.
        if (response.status === 404) continue;
        const manifest = v.parse(ContractTeardownSchema, await response.json());

        if (object !== key(manifest.run)) throw new Error(`contract teardown key does not name its recorded run: ${object}`);

        if (await contractOwnerEnded(manifest.owner)) manifests.push(manifest);
      }

      return manifests;
    },
  };
}
