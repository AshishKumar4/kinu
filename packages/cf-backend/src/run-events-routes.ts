/**
 * HTTP routes for the durable run-event log: list runs, page events, and an SSE
 * stream with Last-Event-ID resume. The stream polls the DO over RPC, which cannot
 * hold a persistent server-push channel here. Both forward the stored text, in
 * pages PLATFORM_CATALOG `run_events.page_bytes` bounds.
 */

import { Hono } from 'hono';
import type { OrchestratorAgent } from "./orchestrator";
import { boundRunEventQuery, RUN_EVENT_LIMIT_MAX, type RunEventType, type StoredRunEvent } from "@kinu.run/core";
import * as v from 'valibot';
import { resumeIndexFromLastEventId } from '@kinu.run/core';
import { waitOn, type Clock } from "@kinu.run/core";
import { diagnostics, renderThrownChain, toKinuError } from '@kinu.run/core/obs';
import { rawParam, type FamilyEnv } from './api/context';
import type { WorkspaceVariables } from './api/workspace';

/** Record each 500 as a fleet signal. The workspace name is user text, so the row names the surface instead. */
function reportRouteFailure(input: { surface: string; cause: unknown }): Response {
  const { surface, cause } = input;
  diagnostics.failure('http.run_events_failed', toKinuError({
    doing: `answering a ${surface} request for the durable run-event log`,
    cause,
    otherwise: 'unavailable',
  }), { source: surface });

  return Response.json({ error: renderThrownChain({ cause }) }, { status: 500 });
}

const SSE_POLL_MS = 500;

/** How long one browser SSE subscription stays open before the client reconnects.
 *  Unrelated to core's `DEVICE_CONSENT_TIMEOUT_MS`, the same five minutes. */
const SSE_TIMEOUT_MS = 5 * 60 * 1000;

const SSE_HEARTBEAT_MS = 15_000;

const ALLOWED_TYPES = [
  'run_start', 'turn_start', 'tool_call_end',
  'step_finish', 'head_split', 'head_merge', 'head_abandoned', 'scaffold_promotion',
  'scaffold_rollback', 'memory_write', 'fiber_recovered', 'error',
  'turn_end', 'run_end',
] as const satisfies readonly RunEventType[];

export type RunEventsTarget = Pick<OrchestratorAgent, 'listRuns' | 'getRunEventText'>;

/** A resolver, not the namespace binding: the SDK's `getAgentByName` (agents@0.22.0,
 *  `dist/agent-routing.js:176-183`, read 2026-09-22) awaits `__unsafe_ensureInitialized`. */
export type RunEventsResolver = (name: string) => Promise<RunEventsTarget>;

function parseTypesParam(s: string | null): RunEventType[] | undefined {
  if (!s) return undefined;
  const parsed = s.split(',').map((t) => t.trim()).filter(Boolean);

  const valid = parsed.filter((eventType): eventType is RunEventType =>
    v.is(v.picklist(ALLOWED_TYPES), eventType));

  return valid.length > 0 ? valid : undefined;
}

const RUNS = '/api/workspaces/:name/runs';

/** Run-event routes and the overview, on the proven workspace; trailing slashes accepted, as before. */
export function runEventsRoutes<Bindings extends object>(
  clock: Clock,
  resolverFor: (env: Bindings) => RunEventsResolver,
): Hono<FamilyEnv<Bindings, WorkspaceVariables>> {
  const routes = new Hono<FamilyEnv<Bindings, WorkspaceVariables>>();

  routes.on('GET', [RUNS, `${RUNS}/`], async (c) => {
    const url = new URL(c.req.url);

    // Forwarded raw: `listRuns` validates it in core for every caller.
    const limit = url.searchParams.has('limit')
      ? Number(url.searchParams.get('limit'))
      : undefined;

    // The page's own `next`, echoed verbatim, so a caller can tell a full page from the end.
    const after = url.searchParams.get('after');

    try {
      const stub = await resolverFor(c.env)(c.get('workspace').name);

      return Response.json(await stub.listRuns({ limit, cursor: after ? { after } : undefined }));
    } catch (cause) {
      return reportRouteFailure({ surface: 'runs', cause });
    }
  });

  routes.on('GET', [`${RUNS}/:run/events`, `${RUNS}/:run/events/`], async (c) => {
    const url = new URL(c.req.url);

    // The read-model's own closed parser; it reads NaN as "unstated".
    const opts = boundRunEventQuery({
      since: url.searchParams.has('since') ? Number(url.searchParams.get('since')) : undefined,
      limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined,
      types: parseTypesParam(url.searchParams.get('types')),
    });

    try {
      const stub = await resolverFor(c.env)(c.get('workspace').name);
      const runId = rawParam(c, 'run');
      const events: string[] = [];
      let since = opts.since;

      // Joined from the object's bounded pages.
      while (events.length < opts.limit) {
        const page = await stub.getRunEventText(runId, { ...opts, since, limit: opts.limit - events.length });

        if (page.length === 0) break;

        for (const event of page) {
          events.push(event.payload);
          since = event.eventIndex + 1;
        }
      }

      return new Response(`[${events.join(',')}]`, { headers: { 'content-type': 'application/json' } });
    } catch (cause) {
      return reportRouteFailure({ surface: 'events', cause });
    }
  });

  routes.on('GET', [`${RUNS}/:run/stream`, `${RUNS}/:run/stream/`], async (c) => {
    const request = c.req.raw;
    const lastEventId = request.headers.get('Last-Event-ID') ?? request.headers.get('last-event-id');

    return streamRunEvents({
      resolveAgent: resolverFor(c.env),
      agentName: c.get('workspace').name,
      runId: rawParam(c, 'run'),
      sinceIndex: resumeIndexFromLastEventId(lastEventId),
      signal: request.signal,
      clock,
    });
  });

  return routes;
}


export interface RunEventStreamOptions {
  readonly resolveAgent: RunEventsResolver;
  readonly agentName: string;
  readonly runId: string;
  readonly sinceIndex: number;
  readonly signal: AbortSignal;
  /** The stream's clock (D19): a test drives poll iterations instead of sleeping. */
  readonly clock: Clock;
}

function streamRunEvents(options: RunEventStreamOptions): Response {
  const { resolveAgent, agentName, runId, sinceIndex, signal, clock } = options;
  const encoder = new TextEncoder();
  // Stop polling the DO the moment the client goes away (stream cancel or request abort).
  let closed = false;
  // A cancelled stream's controller is unusable; an aborted request's is closed below so an attached reader sees the end.
  let cancelled = false;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const startedAt = clock.now();
      let cursor = sinceIndex;
      let heartbeatAt = clock.now();
      signal.addEventListener('abort', () => { closed = true; }, { once: true });

      const stub = await resolveAgent(agentName);
      const resolvedAt = clock.now();

      // First event, not headers, is what a reader waits for; `resolveMs` separates DO activation from the first ledger read.
      let firstByteReported = false;

      const reportFirstByte = (events: number): void => {
        if (firstByteReported) return;
        firstByteReported = true;
        diagnostics.event('sse.run_events_first_byte', {
          ms: clock.now() - startedAt,
          resolveMs: resolvedAt - startedAt,
          events,
          resumed: sinceIndex > 0,
        });
      };

      // Stored JSON holds no raw newline: one `data:` line.
      const send = (ev: StoredRunEvent) => {
        controller.enqueue(encoder.encode(`id: ${ev.eventIndex}\nevent: ${ev.type}\ndata: ${ev.payload}\n\n`));
        cursor = Math.max(cursor, ev.eventIndex);
        heartbeatAt = clock.now();
      };

      try {
        // Pages drain back to back; an empty one means caught up. The client's EventSource auto-reconnects with Last-Event-ID.
        for (;;) {
          const page = await stub.getRunEventText(runId, { since: cursor + 1, limit: RUN_EVENT_LIMIT_MAX });

          for (const ev of page) send(ev);
          // Reported even when the replay is empty, or the measurement would only count backlogged streams.
          reportFirstByte(page.length);

          if (page.some((e) => e.type === 'run_end') || closed || clock.now() - startedAt >= SSE_TIMEOUT_MS) break;

          if (page.length > 0) continue;

          if (clock.now() - heartbeatAt >= SSE_HEARTBEAT_MS) {
            controller.enqueue(encoder.encode(`:heartbeat ${clock.now()}\n\n`));
            heartbeatAt = clock.now();
          }

          await waitOn(clock, SSE_POLL_MS);

          if (closed) break;
        }

        if (!cancelled) controller.close();
      } catch (cause) {
        if (!cancelled) {
          controller.enqueue(encoder.encode(
            `event: error\ndata: ${JSON.stringify({ error: renderThrownChain({ cause }) })}\n\n`,
          ));
          controller.close();
        }
      }
    },
    cancel() {
      closed = true;
      cancelled = true;
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no',
    },
  });
}
