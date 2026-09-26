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

export interface TurnRequestHead {
  readonly metadata: JsonValue;
  readonly response: Extract<RunEvent, { type: 'step_finish' }> | null;
}

export interface TurnRequestPage {
  readonly request: TurnRequestRow;
  readonly head: TurnRequestHead | null;
  readonly messageCount: number;
  readonly from: number;
  readonly messages: readonly JsonObject[];
  readonly nextFrom: number | null;
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
  const head = from === 0 ? await requestHead(sources, request) : null;
  const page: JsonObject[] = [];
  let bytes = head === null ? 0 : byteLength(head);
  let next = from;

  // The first message always ships.
  for (; next < references.length; next += 1) {
    const reference = references[next];

    if (reference === undefined) break;
    const message = await store.projection(reference);
    const size = byteLength(message);

    if (page.length > 0 && bytes + size > PAGE_BYTES) break;
    page.push(message);
    bytes += size;
  }

  return {
    request: { requestId: request.id, runId: request.runId, epoch: request.epoch, revision: request.revision, step: request.step },
    head,
    messageCount: references.length,
    from,
    messages: page,
    nextFrom: next < references.length ? next : null,
  };
}

type StoredRequest = ReturnType<TurnRequestSources['history']['requests']['forTurn']>[number];

async function requestHead(sources: TurnRequestSources, request: StoredRequest): Promise<TurnRequestHead> {
  return {
    metadata: await sources.history.messages.payloads.read(request.metadata),
    // step_finish counts from 1.
    response: request.step === null ? null : sources.eventRecorder.stepFinish(request.runId, request.step + 1),
  };
}

function byteLength(value: JsonObject | TurnRequestHead): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}
