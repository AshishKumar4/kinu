/** docs/OBSERVABILITY.md, "Reading one turn". */
import type { StoredActorClaim } from '../orchestrator/actor-claims';
import type { RunEvent } from '../events/types';
import type { AgentStores } from '../state/agent-stores';
import { PLATFORM_CATALOG } from '../platform-catalog';
import { KinuError } from '../obs/error';
import type { JsonObject, JsonValue } from '../utils/json';

const PAGE_BYTES = PLATFORM_CATALOG['run_events.page_bytes'].limit.value;

export interface TurnRequestRow {
  readonly requestId: string;
  readonly runId: string;
  readonly epoch: number;
  readonly revision: number;
  readonly step: number | null;
}

export interface TurnRequestIndex {
  readonly turnId: string;
  readonly claim: Pick<StoredActorClaim, 'epoch' | 'status' | 'outcome' | 'workMode' | 'program' | 'claimedAt'> | null;
  readonly requests: readonly TurnRequestRow[];
}

export interface TurnRequestPage {
  readonly request: TurnRequestRow;
  readonly metadata: JsonValue;
  readonly messageCount: number;
  readonly from: number;
  readonly messages: readonly JsonObject[];
  readonly nextFrom: number | null;
  readonly response: Extract<RunEvent, { type: 'step_finish' }> | null;
}

export type TurnRequestSources = Pick<AgentStores, 'history' | 'claims' | 'eventRecorder'>;

export function turnRequestIndex(sources: TurnRequestSources, turnId: string): TurnRequestIndex {
  const claim = sources.claims.read(turnId);

  return {
    turnId,
    claim: claim === null ? null : {
      epoch: claim.epoch, status: claim.status, outcome: claim.outcome, workMode: claim.workMode,
      program: claim.program, claimedAt: claim.claimedAt,
    },
    requests: sources.history.requests.forTurn(turnId).map((request) => ({
      requestId: request.id, runId: request.runId, epoch: request.epoch, revision: request.revision, step: request.step,
    })),
  };
}

export async function turnRequestPage(
  sources: TurnRequestSources,
  at: { readonly turnId: string; readonly epoch: number; readonly revision: number; readonly from?: number },
): Promise<TurnRequestPage> {
  const { requests, messages: store } = sources.history;
  const request = requests.forTurn(at.turnId).find((row) => row.epoch === at.epoch && row.revision === at.revision);

  if (request === undefined) throw new KinuError('missing', `turn ${at.turnId} has no request ${String(at.epoch)}-${String(at.revision)}`);
  const references = requests.messagesOf(request);
  const from = Math.max(0, Math.min(at.from ?? 0, references.length));
  const page: JsonObject[] = [];
  let bytes = 0;
  let next = from;

  // The first message always ships.
  for (; next < references.length; next += 1) {
    const reference = references[next];

    if (reference === undefined) break;
    const message = await store.projection(reference);
    const size = new TextEncoder().encode(JSON.stringify(message)).byteLength;

    if (page.length > 0 && bytes + size > PAGE_BYTES) break;
    page.push(message);
    bytes += size;
  }

  // `step_finish` counts from 1; a request's step from 0.
  const response = request.step === null ? null : sources.eventRecorder.stepFinish(request.runId, request.step + 1);

  return {
    request: { requestId: request.id, runId: request.runId, epoch: request.epoch, revision: request.revision, step: request.step },
    metadata: await store.payloads.read(request.metadata),
    messageCount: references.length,
    from,
    messages: page,
    nextFrom: next < references.length ? next : null,
    response,
  };
}
