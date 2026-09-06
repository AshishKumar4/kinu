import * as v from 'valibot';
import { PublishWorkSchema } from '../src/durability/contracts';

/** A stored object whose acknowledgement the fixture has not returned. */
export const PublicationCutSchema = v.strictObject({
  token: v.string(),
  prefix: v.string(),
  state: v.picklist(['armed', 'held', 'CUT', 'NOT-CUT']),
  key: v.nullable(v.string()),
  work: PublishWorkSchema,
});
export type PublicationCut = v.InferOutput<typeof PublicationCutSchema>;

export function armPublicationCut(token: string, prefix: string): PublicationCut {
  if (token.length === 0 || prefix.length === 0 || !prefix.endsWith('/')) {
    throw new Error('a publication cut needs a token and a complete store prefix');
  }
  return { token, prefix, state: 'armed', key: null, work: { objectsPut: 0, bytesPut: 0, casAttempts: 0 } };
}

/** Called after the store commits the object, before its caller receives the acknowledgement. */
export function reachPublicationCut(row: PublicationCut, key: string, bytes: number): PublicationCut {
  if (row.state !== 'armed' || !key.startsWith(row.prefix) || bytes <= 0) return row;
  return { ...row, state: 'held', key, work: { objectsPut: 1, bytesPut: bytes, casAttempts: 0 } };
}

export function finishPublicationCut(row: PublicationCut, token: string, stopped: boolean): PublicationCut {
  if (row.token !== token) throw new Error('the publication cut token changed');
  if (row.state === 'CUT' || row.state === 'NOT-CUT') return row;
  return { ...row, state: row.state === 'held' && stopped ? 'CUT' : 'NOT-CUT' };
}

export interface PublicationCutPorts {
  read(): Promise<PublicationCut>;
  pending(): Promise<boolean>;
  kill(): Promise<PublicationCut>;
  cancel(): Promise<PublicationCut>;
  wait(): Promise<void>;
}

/** A completed checkpoint cannot stand in for an interrupted publication. */
export async function rendezvousPublicationCut(ports: PublicationCutPorts): Promise<PublicationCut> {
  for (;;) {
    const receipt = await ports.read();
    if (receipt.state === 'CUT' || receipt.state === 'NOT-CUT') return receipt;
    if (!(await ports.pending())) return await ports.cancel();
    if (receipt.state === 'held') return await ports.kill();
    await ports.wait();
  }
}

export function publicationWasCut(receipt: PublicationCut, token: string): boolean {
  return receipt.token === token && receipt.state === 'CUT'
    && receipt.key !== null && receipt.key.startsWith(receipt.prefix)
    && receipt.work.objectsPut > 0 && receipt.work.bytesPut > 0;
}

export interface PublicationAckPorts {
  reach(key: string, bytes: number): Promise<PublicationCut | null>;
  read(token: string): Promise<PublicationCut>;
  wait(): Promise<void>;
}

export class PublicationAckLost extends Error {
  constructor(readonly token: string) {
    super(`publication acknowledgement cut for ${token}`);
    this.name = 'PublicationAckLost';
  }
}

/** The store has the bytes. The publisher cannot advance past this acknowledgement. */
export async function holdPublicationAcknowledgement(
  ports: PublicationAckPorts, key: string, bytes: number,
): Promise<void> {
  let receipt = await ports.reach(key, bytes);
  while (receipt?.state === 'held') {
    await ports.wait();
    receipt = await ports.read(receipt.token);
  }
  if (receipt?.state === 'CUT') throw new PublicationAckLost(receipt.token);
}
