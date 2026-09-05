/**
 * HTTP routes for the durable run-event log.
 *
 *   GET /api/workspaces/:agentName/runs            → list recent runs
 *   GET /api/workspaces/:agentName/runs/:runId/events?since=&limit=&types=
 *   GET /api/workspaces/:agentName/runs/:runId/stream  → SSE w/ Last-Event-ID resume
 *
 * Routes through to the OrchestratorAgent DO by name, calling its @callable
 * RPCs (getRunEvents / listRuns / countRunEvents). The SSE stream loops a
 * polling read against the agent — Worker DO RPCs can't hold a single
 * persistent server-push channel here, so we drain new events on a short
 * interval. This is the simple Flue-compatible model; future enhancement can swap for
 * a true push over agent.broadcast() once the chat protocol surface is
 * extended.
 */

import { getAgentByName } from "agents";
import type { OrchestratorAgent } from "./orchestrator";
import { boundRunEventQuery, RUN_EVENT_LIMIT_DEFAULT, RUN_EVENT_LIMIT_MAX, type RunEventType } from "@kinu.run/core";
import * as v from 'valibot';
import {
  decodeRunEventWire, resumeIndexFromLastEventId, type RunEventWire,
} from './lib/orchestrator-wire';
import { diagnostics, renderThrownChain, toKinuError } from '@kinu.run/core/obs';

/**
 * One 500 from this file, counted. The route used to answer with a rendered cause
 * and record nothing, so a workspace whose history was unreachable produced no
 * fleet signal at all — the failure was visible to the one person looking at the
 * panel and to nobody else.
 *
 * The workspace NAME is not a field. It is mission-derived user text; naming the
 * SURFACE instead answers the question this row exists for, which is which route
 * is failing rather than whose workspace it was.
 */
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
const SSE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const SSE_HEARTBEAT_MS = 15_000;
const ALLOWED_TYPES = [
  'run_start', 'turn_start', 'tool_call_end',
  'step_finish', 'head_split', 'head_merge', 'head_abandoned', 'scaffold_promotion',
  'scaffold_rollback', 'memory_write', 'fiber_recovered', 'error',
  'turn_end', 'run_end',
] as const satisfies readonly RunEventType[];

async function resolveAgent(env: Env, agentName: string) {
  // routeAgentRequest expects /agents/<class>/<name>; we use getAgentByName.
  // Class name is hardcoded to "OrchestratorAgent" (only one Think class).
  const stub = await getAgentByName<Env, OrchestratorAgent>(
    env.OrchestratorAgent,
    agentName,
  );
  return stub;
}

function parseTypesParam(s: string | null): RunEventType[] | undefined {
  if (!s) return undefined;
  const parsed = s.split(',').map((t) => t.trim()).filter(Boolean);
  const valid = parsed.filter((eventType): eventType is RunEventType =>
    v.is(v.picklist(ALLOWED_TYPES), eventType));
  return valid.length > 0 ? valid : undefined;
}

export async function handleRunEventsRequest(request: Request, env: Env): Promise<Response | null> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (!path.startsWith('/api/workspaces/')) return null;
  if (request.method !== 'GET') return null;

  // /api/workspaces/<name>/runs
  const listMatch = path.match(/^\/api\/workspaces\/([^/]+)\/runs\/?$/);
  if (listMatch) {
    const [, agentName] = listMatch;
    // Forwarded raw: `listRuns` closes it in core, where the MCP tool and the CLI
    // reach it too. The old `Math.min(200, Math.max(1, Number(...)))` here let
    // `Number('abc')` through as NaN, because `Math.max(1, NaN)` is NaN.
    const limit = url.searchParams.has('limit')
      ? Number(url.searchParams.get('limit'))
      : undefined;
    // The page's own `next`, echoed back verbatim. A caller that ignores it gets
    // exactly what it got before; a caller that reads it can tell a full page
    // from the end of the history, which `limit` alone never said.
    const after = url.searchParams.get('after');
    try {
      const stub = await resolveAgent(env, agentName);
      return Response.json(await stub.listRuns({ limit, cursor: after ? { after } : undefined }));
    } catch (err) {
      return reportRouteFailure({ surface: 'runs', cause: err });
    }
  }

  // /api/workspaces/<name>/runs/<runId>/events
  const eventsMatch = path.match(/^\/api\/workspaces\/([^/]+)\/runs\/([^/]+)\/events\/?$/);
  if (eventsMatch) {
    const [, agentName, runId] = eventsMatch;
    // The same closed parser the boundary read-model behind this RPC applies, so
    // a request that skips the route gets the identical ceiling. `Number('abc')`
    // is NaN, which the parser reads as "unstated" — the route never has to
    // decide what a garbage query string meant.
    const opts = boundRunEventQuery({
      since: url.searchParams.has('since') ? Number(url.searchParams.get('since')) : undefined,
      limit: url.searchParams.has('limit') ? Number(url.searchParams.get('limit')) : undefined,
      types: parseTypesParam(url.searchParams.get('types')),
    });
    try {
      const stub = await resolveAgent(env, agentName);
      const events = decodeRunEventWire(await stub.getRunEventsWire(runId, opts));
      return Response.json(events);
    } catch (err) {
      return reportRouteFailure({ surface: 'events', cause: err });
    }
  }

  // /api/workspaces/<name>/runs/<runId>/stream — SSE w/ Last-Event-ID resume
  const streamMatch = path.match(/^\/api\/workspaces\/([^/]+)\/runs\/([^/]+)\/stream\/?$/);
  if (streamMatch) {
    const [, agentName, runId] = streamMatch;
    const lastEventId = request.headers.get('Last-Event-ID') ?? request.headers.get('last-event-id');
    return streamRunEvents(
      env, agentName, runId, resumeIndexFromLastEventId(lastEventId), request.signal,
    );
  }

  return null;
}


function streamRunEvents(
  env: Env,
  agentName: string,
  runId: string,
  sinceIndex: number,
  signal: AbortSignal,
): Response {
  const encoder = new TextEncoder();
  // Stop polling the DO the moment the client goes away — via stream
  // cancel() (reader released) or the request abort signal — instead of
  // burning DO requests for up to 5 minutes against a dead connection.
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const startedAt = Date.now();
      let cursor = sinceIndex;
      let heartbeatAt = Date.now();
      signal.addEventListener('abort', () => { closed = true; }, { once: true });

      const stub = await resolveAgent(env, agentName);
      const resolvedAt = Date.now();

      // First byte, measured once. What a reader of this stream actually waits
      // for is not the response headers — those return immediately, because the
      // body is a stream — but the first EVENT. `resolveMs` separates the two
      // costs that make it up: reaching the Durable Object (a cold activation
      // pays for its own init here) and the first ledger read.
      let firstByteReported = false;
      const reportFirstByte = (events: number): void => {
        if (firstByteReported) return;
        firstByteReported = true;
        diagnostics.event('sse.run_events_first_byte', {
          ms: Date.now() - startedAt,
          resolveMs: resolvedAt - startedAt,
          events,
          resumed: sinceIndex > 0,
        });
      };

      const send = (ev: RunEventWire) => {
        const lines = [
          `id: ${ev.eventIndex}`,
          `event: ${ev.type}`,
          `data: ${JSON.stringify(ev)}`,
          '', // blank line ends the SSE message
          '',
        ];
        controller.enqueue(encoder.encode(lines.join('\n')));
        cursor = Math.max(cursor, ev.eventIndex);
        heartbeatAt = Date.now();
      };

      try {
        // Initial replay — drain everything strictly after sinceIndex.
        let backlog = decodeRunEventWire(
          await stub.getRunEventsWire(runId, { since: cursor + 1, limit: RUN_EVENT_LIMIT_MAX }),
        );
        for (const ev of backlog) send(ev);
        // Reported even when the replay is EMPTY: a run with nothing new to say
        // still made the reader wait for the round trip, and a measurement that
        // only counted streams with a backlog would report the fast half.
        reportFirstByte(backlog.length);
        // A run that already ended has nothing more to say. The loop below
        // only tests batches it fetched itself, so without this a run_end in
        // the replay above never ends the stream and the poll loop runs dead
        // reads until the timeout.
        if (backlog.some((e) => e.type === 'run_end')) { controller.close(); return; }

        // Poll loop until run_end, client disconnect, or timeout. Cloudflare
        // Workers can hold a single SSE connection for up to several minutes;
        // the client's EventSource auto-reconnects with Last-Event-ID.
        while (!closed && Date.now() - startedAt < SSE_TIMEOUT_MS) {
          await new Promise((r) => setTimeout(r, SSE_POLL_MS));
          if (closed) break;
          backlog = decodeRunEventWire(
            await stub.getRunEventsWire(runId, { since: cursor + 1, limit: RUN_EVENT_LIMIT_DEFAULT }),
          );
          for (const ev of backlog) send(ev);
          const hasRunEnd = backlog.some((e) => e.type === 'run_end');
          if (hasRunEnd) break;
          if (Date.now() - heartbeatAt >= SSE_HEARTBEAT_MS) {
            controller.enqueue(encoder.encode(`:heartbeat ${Date.now()}\n\n`));
            heartbeatAt = Date.now();
          }
        }
        if (!closed) controller.close();
      } catch (err) {
        if (!closed) {
          controller.enqueue(encoder.encode(
            `event: error\ndata: ${JSON.stringify({ error: renderThrownChain({ cause: err }) })}\n\n`,
          ));
          controller.close();
        }
      }
    },
    cancel() {
      closed = true;
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

