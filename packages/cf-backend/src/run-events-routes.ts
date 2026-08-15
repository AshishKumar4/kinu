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
import type { OrchestratorAgent } from "./orchestrator.js";
import type { RunEventQuery, RunEventType } from "@proteus/core";
import * as v from 'valibot';
import { decodeRunEventWire, type RunEventWire } from './lib/orchestrator-wire.js';

const SSE_POLL_MS = 500;
const SSE_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
const SSE_HEARTBEAT_MS = 15_000;
const ALLOWED_TYPES = [
  'run_start', 'turn_start', 'text_delta', 'tool_call_start', 'tool_call_end',
  'step_finish', 'head_split', 'head_merge', 'scaffold_promotion',
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
    const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') ?? '50')));
    try {
      const stub = await resolveAgent(env, agentName);
      const runs = await stub.listRuns(limit);
      return Response.json(runs);
    } catch (err) {
      return Response.json({ error: errorMessage(err) }, { status: 500 });
    }
  }

  // /api/workspaces/<name>/runs/<runId>/events
  const eventsMatch = path.match(/^\/api\/workspaces\/([^/]+)\/runs\/([^/]+)\/events\/?$/);
  if (eventsMatch) {
    const [, agentName, runId] = eventsMatch;
    const opts: RunEventQuery = {
      since: url.searchParams.has('since') ? Number(url.searchParams.get('since')) : undefined,
      limit: url.searchParams.has('limit') ? Math.min(500, Number(url.searchParams.get('limit'))) : undefined,
      types: parseTypesParam(url.searchParams.get('types')),
    };
    try {
      const stub = await resolveAgent(env, agentName);
      const events = decodeRunEventWire(await stub.getRunEventsWire(runId, opts));
      return Response.json(events);
    } catch (err) {
      return Response.json({ error: errorMessage(err) }, { status: 500 });
    }
  }

  // /api/workspaces/<name>/runs/<runId>/stream — SSE w/ Last-Event-ID resume
  const streamMatch = path.match(/^\/api\/workspaces\/([^/]+)\/runs\/([^/]+)\/stream\/?$/);
  if (streamMatch) {
    const [, agentName, runId] = streamMatch;
    const lastEventId = request.headers.get('Last-Event-ID') ?? request.headers.get('last-event-id');
    // Validate Last-Event-ID is a non-negative integer; otherwise replay
    // from the start. A NaN would silently rewind to -1 and re-deliver
    // every event the client has already seen.
    let sinceIndex = -1;
    if (lastEventId !== null) {
      const n = Number(lastEventId);
      if (Number.isFinite(n) && n >= -1 && Number.isInteger(n)) sinceIndex = n;
    }
    return streamRunEvents(env, agentName, runId, sinceIndex, request.signal);
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
          await stub.getRunEventsWire(runId, { since: cursor + 1, limit: 500 }),
        );
        for (const ev of backlog) send(ev);

        // Poll loop until run_end, client disconnect, or timeout. Cloudflare
        // Workers can hold a single SSE connection for up to several minutes;
        // the client's EventSource auto-reconnects with Last-Event-ID.
        while (!closed && Date.now() - startedAt < SSE_TIMEOUT_MS) {
          await new Promise((r) => setTimeout(r, SSE_POLL_MS));
          if (closed) break;
          backlog = decodeRunEventWire(
            await stub.getRunEventsWire(runId, { since: cursor + 1, limit: 200 }),
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
            `event: error\ndata: ${JSON.stringify({ error: errorMessage(err) })}\n\n`,
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

function errorMessage<Thrown>(thrown: Thrown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}
