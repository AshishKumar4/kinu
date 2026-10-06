// What a workspace's turns and tools write to Analytics Engine is what the control plane's fleet panels read back.
// Real turns write through the dataset bindings; the control plane's own queries run over those rows
// (`helpers/analytics-engine.ts`); and an upstream that answers with a proxy's page or a refusal shows as a named
// failure on the panel it hit, the next read recovering with nothing held over.
import { afterEach, expect, test } from 'bun:test';
import { controlPlaneMetrics, type AnalyticsResult, type AnalyticsRow } from '@kinu.run/core/control-plane';
import { createRecordingLogger } from '@kinu.run/core/obs';
import { scriptedTurnModel, type ScriptedTurnResult } from '@kinu.run/test-utils';
import { catalogTurn, gatewayWorkspace, tapDiagnostics } from './helpers/actor-harness';
import { analyticsEngine } from './helpers/analytics-engine';
import { chatCompletion, stubAiBinding } from './helpers/platform-gateway';

const originalFetch = globalThis.fetch;

afterEach(() => { globalThis.fetch = originalFetch; });

const SQL_ENV = { CLOUDFLARE_ACCOUNT_ID: 'acct', ANALYTICS_SQL_API_TOKEN: 'token' };

const USAGE = { inputTokens: { total: 7, noCache: 7, cacheRead: undefined, cacheWrite: undefined }, outputTokens: { total: 3, text: 3, reasoning: undefined } };

/** The rows a panel answered, or why it did not. */
function rowsOf(panel: AnalyticsResult | undefined): readonly AnalyticsRow[] | string {
  if (panel === undefined) return 'no panel';

  if (panel.status === 'ok') return panel.rows;

  return panel.status === 'failed' ? panel.reason : `unconfigured: ${panel.missing.join(', ')}`;
}

test('a workspace\'s turns and tool failures reach the fleet panels, and a bad upstream answer fails only its panel', async () => {
  const engine = analyticsEngine();
  const workspace = gatewayWorkspace(stubAiBinding((run) => chatCompletion(run, 'done')), { analytics: engine.bindings });

  // Two turns: one whose `eval` call throws, one that answers at once.
  let step = 0;

  workspace.agent.modelFactory = () => scriptedTurnModel({ doGenerate: (): ScriptedTurnResult => {
    step += 1;

    if (step === 1) {
      return { content: [{ type: 'tool-call', toolCallId: 'boom', toolName: 'eval', input: JSON.stringify({ code: 'throw new Error("the tool broke")' }) }],
        finishReason: { unified: 'tool-calls', raw: undefined }, usage: USAGE, warnings: [] };
    }

    return { content: [{ type: 'text', text: 'done' }], finishReason: { unified: 'stop', raw: undefined }, usage: USAGE, warnings: [] };
  } });

  await catalogTurn(workspace.agent, 'run the broken tool');
  await catalogTurn(workspace.agent, 'and now just answer');

  globalThis.fetch = Object.assign(engine.sqlApi, { preconnect: originalFetch.preconnect });

  const fleet = await controlPlaneMetrics(SQL_ENV, { hours: 24 });
  const own = await controlPlaneMetrics(SQL_ENV, { hours: 24, workspace: workspace.agent.name });
  const other = await controlPlaneMetrics(SQL_ENV, { hours: 24, workspace: 'someone-else' });

  expect({
    turns: rowsOf(fleet.panels.turns),
    toolFailures: rowsOf(fleet.panels.toolFailures),
    startups: rowsOf(fleet.panels.startups),
    ownTurns: rowsOf(own.panels.turns),
    otherTurns: rowsOf(other.panels.turns),
  }).toEqual({
    turns: [{ outcome: 'ok', code: '', turns: 2, avgDurationMs: expect.any(Number), avgSteps: 1.5, avgToolCalls: 0.5 }],
    toolFailures: [{ tool: 'eval', outcome: 'failed', code: expect.any(String), calls: 1, avgDurationMs: expect.any(Number) }],
    startups: [{ workspace: expect.any(String), hour: expect.any(Number), startups: 1 }],
    ownTurns: [{ outcome: 'ok', code: '', turns: 2, avgDurationMs: expect.any(Number), avgSteps: 1.5, avgToolCalls: 0.5 }],
    otherTurns: [],
  });

  // A proxy's error page on the first query, a refusal on the second: each fails only its own panel, by name.
  const logger = createRecordingLogger();
  const restore = tapDiagnostics(logger);

  engine.refuseNext(
    new Response('<html><body>502 Bad Gateway</body></html>', { status: 502 }),
    Response.json({ errors: [{ message: 'Authentication error' }] }, { status: 403 }),
  );

  const refused = await controlPlaneMetrics(SQL_ENV, { hours: 24 });

  restore();

  const recovered = await controlPlaneMetrics(SQL_ENV, { hours: 24 });

  expect({
    turns: rowsOf(refused.panels.turns),
    latency: rowsOf(refused.panels.latency),
    toolFailures: rowsOf(refused.panels.toolFailures),
    unreadable: logger.emitted.filter((line) => line.event === 'control_plane.analytics_error_body_unreadable').map((line) => ({ code: line.code, fields: line.fields })),
    recovered: rowsOf(recovered.panels.turns),
  }).toEqual({
    turns: 'analytics API 502: the body was not the documented error envelope (41 bytes)',
    latency: 'analytics API 403: Authentication error',
    toolFailures: [{ tool: 'eval', outcome: 'failed', code: expect.any(String), calls: 1, avgDurationMs: expect.any(Number) }],
    // `bad_input`, not `unavailable`: a fleet query for platform faults must not return this line.
    unreadable: [{ code: 'bad_input', fields: { status: 502, bytes: 41 } }],
    recovered: [{ outcome: 'ok', code: '', turns: 2, avgDurationMs: expect.any(Number), avgSteps: 1.5, avgToolCalls: 0.5 }],
  });
});
