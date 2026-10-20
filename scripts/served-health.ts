/**
 * `GET /api/health` as the tooling reads it: the build stamp a deployment serves, read with the product's own schema.
 */
import * as v from 'valibot';
import { WORKER_VERSION_HEADER, type BuildStamp } from '@kinu.run/core';

/** The stamp the deploy writes (core's `BuildStamp`, read in production only by `readBuildStamp`), as far as the
 *  tooling reads it. */
const StampSchema = v.looseObject({ version: v.string(), sha: v.pipe(v.string(), v.minLength(1)), builtAt: v.string() });

/** The health answer's `build`: null for a Worker no full deploy has stamped, a reset placeholder among them. */
export const HealthSchema = v.looseObject({ build: v.nullable(StampSchema) });

const HealthAnswerSchema = v.pipe(v.string(), v.parseJson(), HealthSchema);

export interface ServedHealth {
  readonly status: number;
  /** Undefined when the body is no health answer: the SPA shell a route serves before its Worker does. */
  readonly build: Pick<BuildStamp, 'version' | 'sha' | 'builtAt'> | null | undefined;
  /** The Worker version that answered ({@link WORKER_VERSION_HEADER}), or null where the host names none. */
  readonly workerVersion: string | null;
}

export interface HealthRequest {
  /** A query that keeps the edge from answering from its cache, as `?attempt=3`. */
  readonly query?: string;
  readonly timeoutMs?: number;
  /** The fetch to ask with; a test serves its own. */
  readonly fetcher?: typeof fetch;
}

/** The build `origin` serves, as its `/api/health` names it. A network failure throws. */
export async function servedHealth(origin: string, request: HealthRequest = {}): Promise<ServedHealth> {
  const answer = await (request.fetcher ?? fetch)(`${origin}/api/health${request.query ?? ''}`, {
    headers: { 'cache-control': 'no-cache' },
    signal: AbortSignal.timeout(request.timeoutMs ?? 30_000),
  });

  const read = v.safeParse(HealthAnswerSchema, await answer.text());

  return { status: answer.status, build: answer.ok && read.success ? read.output.build : undefined, workerVersion: answer.headers.get(WORKER_VERSION_HEADER) };
}
