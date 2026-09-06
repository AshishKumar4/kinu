import { describe, expect, test } from 'bun:test';
import { probePublicationCut } from '../bench/publication-cut-probe';
import { armPublicationCut, finishPublicationCut, publicationWasCut, reachPublicationCut } from '../bench/publication-cut';

describe('publication acknowledgement rendezvous', () => {
  test('CUT interrupts the real sidecar upload and preserves the acknowledged tree', async () => {
    const run = await probePublicationCut('lost-ack');
    expect(run.receipt.state).toBe('CUT');
    expect(run.outcome.kind).toBe('failed');
    expect(run.files).toEqual({ 'barrier.txt': 'acknowledged barrier', 'value.txt': 'old value' });
    expect(run.publication).toEqual({
      readOnlyDeclared: false, readOnlyRefusedWrites: null, faultCutCompleted: true,
      allOldOrAllNew: true, barrierAckLoss: 0, absentReferences: 0, rollbackOrPhantomRoot: false,
    });
  });

  test('NOT-CUT refuses a real upload failure before the rendezvous', async () => {
    const run = await probePublicationCut('before-store');
    expect(run.receipt.state).toBe('NOT-CUT');
    expect(run.outcome).toEqual({ kind: 'failed', reason: 'injected store refusal before upload' });
    expect(run.files).toEqual({ 'barrier.txt': 'acknowledged barrier', 'value.txt': 'old value' });
    expect(run.publication.faultCutCompleted).toBe(false);
    expect(run.publication.allOldOrAllNew).toBeNull();
  });

  test('another prefix, an empty object, and a writer already gone cannot prove a cut', () => {
    const armed = armPublicationCut('victim', 'boxes/one/');
    const foreign = reachPublicationCut(armed, 'boxes/one-more/payload', 12);
    const empty = reachPublicationCut(armed, 'boxes/one/empty', 0);
    expect(publicationWasCut(finishPublicationCut(foreign, 'victim', true), 'victim')).toBe(false);
    expect(publicationWasCut(finishPublicationCut(empty, 'victim', true), 'victim')).toBe(false);
    const held = reachPublicationCut(armed, 'boxes/one/payload', 12);
    expect(publicationWasCut(finishPublicationCut(held, 'victim', false), 'victim')).toBe(false);
    expect(() => finishPublicationCut(held, 'another-operation', true)).toThrow('token changed');
  });
});
