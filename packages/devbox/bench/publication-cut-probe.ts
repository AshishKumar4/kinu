import { MemoryPayloadStore, openSidecar, readTree } from '../tests/support/sidecar-fixture';
import { textTree } from '../tests/support/tree-model';
import type { ObjectReceipt, PayloadGrant } from '../src/durability/contracts';
import {
  armPublicationCut, finishPublicationCut, holdPublicationAcknowledgement,
  publicationWasCut, reachPublicationCut, rendezvousPublicationCut,
  type PublicationCut,
} from './publication-cut';

export type CutProbeFault = 'lost-ack' | 'before-store';

/** The local daemon and store are modeled. The sidecar publisher and cut protocol run unchanged. */
class CutProbeStore extends MemoryPayloadStore {
  cut: PublicationCut | null = null;
  fault: CutProbeFault = 'lost-ack';
  readonly reached = Promise.withResolvers<void>();
  readonly released = Promise.withResolvers<void>();

  override async uploadObject(grant: PayloadGrant, body: ReadableStream<Uint8Array>): Promise<ObjectReceipt> {
    if (this.cut !== null && this.fault === 'before-store') {
      throw new Error('injected store refusal before upload');
    }
    const receipt = await super.uploadObject(grant, body);
    await holdPublicationAcknowledgement({
      reach: async (key, bytes) => {
        if (this.cut === null) return null;
        this.cut = reachPublicationCut(this.cut, key, bytes);
        if (this.cut.state === 'held') this.reached.resolve();
        return this.cut;
      },
      read: async () => this.readCut(),
      wait: async () => await this.released.promise,
    }, receipt.key, Number(receipt.byteLength));
    return receipt;
  }

  readCut(): PublicationCut {
    if (this.cut === null) throw new Error('no local cut is armed');
    return this.cut;
  }

  finish(stopped: boolean): PublicationCut {
    const row = this.readCut();
    this.cut = finishPublicationCut(row, row.token, stopped);
    this.released.resolve();
    return this.cut;
  }
}

export async function probePublicationCut(fault: CutProbeFault) {
  const payload = new CutProbeStore();
  const seed = openSidecar();
  const fixture = openSidecar({ share: { ...seed, payload } });
  fixture.daemon.plant(textTree({ 'barrier.txt': 'acknowledged barrier', 'value.txt': 'old value' }));
  const barrier = await fixture.core.seal('barrier');
  if (barrier.kind !== 'published') throw new Error(`barrier refused: ${barrier.kind}`);
  const before = await fixture.snapshot();
  const uploaded = payload.ops.find((op) => op.op === 'put');
  if (uploaded === undefined) throw new Error('barrier stored no payload');
  const slash = uploaded.key.lastIndexOf('/');
  if (slash < 0) throw new Error('barrier payload has no prefix');
  payload.cut = armPublicationCut('local-victim', uploaded.key.slice(0, slash + 1));
  payload.fault = fault;
  fixture.daemon.plant(textTree({ 'value.txt': 'new value', 'victim.txt': 'unacknowledged victim' }));
  let pending = true;
  const victim = fixture.core.seal('quiesce').finally(() => { pending = false; });
  const receipt = await rendezvousPublicationCut({
    read: async () => payload.readCut(),
    pending: async () => pending,
    kill: async () => payload.finish(true),
    cancel: async () => payload.finish(false),
    wait: async () => { await Promise.race([payload.reached.promise, victim]); },
  });
  const outcome = await victim;
  payload.cut = null;
  fixture.daemon.reset();
  const replacement = openSidecar({ bootId: 'replacement', share: fixture });
  await replacement.core.attach();
  const view = replacement.core.view();
  if (view === null) throw new Error('replacement lost the acknowledged head');
  const tree = await readTree(view);
  const files = Object.fromEntries(await Promise.all(tree.filter((entry) => entry.kind === 'file').map(async (entry) => {
    const stat = await view.stat(entry.path);
    if (stat === null) throw new Error(`restored file vanished: ${entry.path}`);
    return [entry.path, new TextDecoder().decode(await view.readRange(entry.path, 0, stat.size))];
  })));
  const after = await replacement.snapshot();
  const cut = publicationWasCut(receipt, 'local-victim');
  const oldHead = before.head?.pointer.rootEnvelopeId;
  const restoredHead = after.head?.pointer.rootEnvelopeId;
  const allOld = oldHead === restoredHead && files['value.txt'] === 'old value' && files['victim.txt'] === undefined;
  const barrierPreserved = files['barrier.txt'] === 'acknowledged barrier';
  const strayEnvelopes = [...fixture.envelopes.objects.keys()].filter((id) => id !== restoredHead).length;
  return {
    surface: 'local modeled daemon/store; real merkle-pack/v2 sidecar',
    fault,
    receipt,
    outcome,
    files,
    work: replacement.core.status().work,
    publication: {
      readOnlyDeclared: false,
      readOnlyRefusedWrites: null,
      faultCutCompleted: cut,
      allOldOrAllNew: cut ? allOld : null,
      barrierAckLoss: cut ? Number(!barrierPreserved) : null,
      absentReferences: cut ? 0 : null,
      rollbackOrPhantomRoot: cut ? oldHead !== restoredHead || strayEnvelopes !== 0 : null,
    },
    otherGates: 'NOT MEASURED; this probe cannot admit a protocol or promote an arm',
  };
}

if (import.meta.main) {
  const fault = process.argv[2];
  if (fault !== 'lost-ack' && fault !== 'before-store') {
    throw new Error('usage: bun packages/devbox/bench/publication-cut-probe.ts lost-ack|before-store');
  }
  process.stdout.write(`${JSON.stringify(await probePublicationCut(fault), null, 2)}\n`);
}
