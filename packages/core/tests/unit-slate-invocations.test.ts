import { expect, test } from 'bun:test';
import { ContentRef, WorkspaceId } from '@agent-core/core';
import { SlateDeploymentId, SlateId, SlatePublicationId, type SlateInvocationRequest } from '@agent-core/core/slates';
import { KinuError } from '../src/obs/error';
import { SqliteSlateInvocations } from '../src/slates/invocations';
import { createTestWorkspace, makeSqlExec } from './helpers';

const request: SlateInvocationRequest = {
  operation: 'deploy', impact: 'externalSend', workspaceId: new WorkspaceId('workspace'),
  slateId: new SlateId('notes'), deploymentId: new SlateDeploymentId('deployment'),
  publicationId: new SlatePublicationId('publication'),
  publicationMaterialization: new ContentRef(`sha256:${'a'.repeat(64)}`),
  target: 'kinu', expectedActiveDeploymentId: undefined,
};

test('an interrupted Slate effect reconciles with the same external key and a new receipt', async () => {
  const ws = createTestWorkspace();
  try {
    const database = makeSqlExec(ws.db);
    const atomic = <Result>(body: () => Result): Result => ws.db.transaction(body)();
    let authorized = false;
    const authorize = async () => { if (!authorized) throw new KinuError('denied', 'owner decision required'); };
    const authority = { admit: authorize, assertCurrent() { if (!authorized) throw new KinuError('denied', 'turn lost'); } };
    const first = new SqliteSlateInvocations(database, atomic, 'first-activation', authority);
    await expect(first.prepare(request)).rejects.toThrow('owner decision required');
    authorized = true;
    const id = await first.prepare(request);
    let externalKey = '';
    const interrupted = await first.invoke(request, id, async (context) => {
      externalKey = context.idempotencyKey;
      throw new KinuError('io', 'response lost after provider accepted');
    });
    const reopened = new SqliteSlateInvocations(database, atomic, 'second-activation', authority);
    expect(interrupted.outcome).toBe('indeterminate');
    const recovered = await reopened.reconcile(request, id, async (context) => {
      expect(context.idempotencyKey).toBe(externalKey);
      expect(context.attemptOrdinal).toBe(2);
      return 'served committed version';
    });
    expect(recovered).toMatchObject({ outcome: 'succeeded', value: 'served committed version' });
    expect(recovered.receiptId.value).not.toBe(interrupted.receiptId.value);
    expect(reopened.receipts(request.slateId).map((receipt) => receipt.outcome)).toEqual(['indeterminate', 'succeeded']);
    await expect(reopened.reconcile({ ...request, target: 'another-host' }, id, async () => 'wrong effect')).rejects.toThrow('does not match');
  } finally {
    ws.db.close();
  }
});
