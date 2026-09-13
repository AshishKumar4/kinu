import * as v from 'valibot';

export type PublicationOperation = 'put' | 'uploadPart' | 'complete';

export interface PublicationAttempt {
  readonly id: string;
  readonly key: string;
  readonly operation: PublicationOperation;
  readonly uploadId: string | null;
  readonly startedAt: number;
  finishedAt: number | null;
  bytes: number | null;
  observedBytes: number | null;
  outcome: 'returned' | 'threw' | null;
  error: string | null;
  bodyError: string | null;
}

export interface PublicationWindow {
  readonly schema: 'devbox-publication-window/1';
  readonly token: string;
  readonly prefix: string;
  readonly openedAt: number;
  closedAt: number | null;
  attempts: PublicationAttempt[];
}

const Count = v.pipe(v.number(), v.safeInteger(), v.minValue(0));

export const PublicationAttemptSchema: v.GenericSchema<PublicationAttempt> = v.object({
  id: v.pipe(v.string(), v.minLength(1)), key: v.string(),
  operation: v.picklist(['put', 'uploadPart', 'complete']), uploadId: v.nullable(v.string()),
  startedAt: Count, finishedAt: v.nullable(Count),
  bytes: v.nullable(Count), observedBytes: v.nullable(Count),
  outcome: v.nullable(v.picklist(['returned', 'threw'])),
  error: v.nullable(v.string()), bodyError: v.nullable(v.string()),
});

export const PublicationWindowSchema: v.GenericSchema<PublicationWindow> = v.object({
  schema: v.literal('devbox-publication-window/1'),
  token: v.pipe(v.string(), v.minLength(1)), prefix: v.pipe(v.string(), v.minLength(1)),
  openedAt: Count, closedAt: v.nullable(Count), attempts: v.array(PublicationAttemptSchema),
});

export interface PublicationTotals {
  objectsPut: number | null; bytesPut: number | null; errors: string[];
}

export function publicationTotals(window: PublicationWindow | null): PublicationTotals {
  const parsed = v.safeParse(PublicationWindowSchema, window);

  if (!parsed.success || window === null || window.closedAt === null || window.closedAt < window.openedAt) {
    return { objectsPut: null, bytesPut: null, errors: ['the publication window is absent, invalid or still open'] };
  }

  const errors: string[] = [];
  const seen = new Set<string>();
  const uploads = new Set<string>();
  let objectsPut = 0;
  let bytesPut = 0;

  for (const attempt of window.attempts) {
    if (seen.has(attempt.id) || !attempt.key.startsWith(window.prefix)) errors.push(`invalid publication attempt ${attempt.id}`);
    seen.add(attempt.id);

    if (attempt.finishedAt === null || attempt.outcome === null || attempt.startedAt < window.openedAt
      || attempt.finishedAt > window.closedAt || attempt.finishedAt < attempt.startedAt
      || attempt.bytes === null || attempt.bodyError !== null || attempt.bytes !== attempt.observedBytes) {
      errors.push(`publication attempt ${attempt.id} has unobserved body or completion evidence`);
      continue;
    }

    bytesPut += attempt.bytes;

    if (attempt.operation === 'put') objectsPut++;
    else if (attempt.uploadId === null || attempt.uploadId === '') errors.push(`multipart attempt ${attempt.id} has no upload identity`);
    else uploads.add(JSON.stringify([attempt.key, attempt.uploadId]));
  }

  objectsPut += uploads.size;

  if (!Number.isSafeInteger(bytesPut)) errors.push('publication byte accounting exceeded an exact integer');

  return errors.length === 0 ? { objectsPut, bytesPut, errors } : { objectsPut: null, bytesPut: null, errors };
}
