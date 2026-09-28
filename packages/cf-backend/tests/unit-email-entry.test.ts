/** The Worker's `email()` entry fails as every other entry does: one classified `KinuError`, logged once by name. */
import { expect, test } from 'bun:test';
import { KinuError, createRecordingLogger, setDiagnosticsSink } from '@kinu.run/core/obs';
import { handleInboundEmail } from '../src/email/handler';

test('an inbound email the workspace cannot take fails as a classified error, logged by name', async () => {
  const logs = createRecordingLogger();
  const restore = setDiagnosticsSink(logs);

  const message = Object.assign(Object.create(null), {
    from: 'owner@example.com', to: 'atlas@mail.example', rawSize: 10,
    headers: new Headers(), raw: new ReadableStream(),
  });

  const env = Object.assign(Object.create(null), {
    EMAIL_DOMAIN: 'mail.example',
    OrchestratorAgent: {
      idFromName: () => { throw new Error('object storage unreachable at node sk-live-SECRET'); },
      get: () => { throw new Error('unreachable'); },
    },
  });

  const failed = handleInboundEmail(message, env);

  await expect(failed).rejects.toBeInstanceOf(KinuError);
  await expect(failed).rejects.not.toThrow(/sk-live-SECRET/);
  restore();
  expect(logs.emitted.filter((line) => line.event === 'email.delivery_failed').map((line) => line.code)).toEqual(['io']);
});
