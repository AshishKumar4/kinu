/** The native `web` tool: search, fetch (plain or rendered) and screenshot. `web.*` in eval is `web/provider.ts`. */
import { tool, type ToolSet } from 'ai';
import { Effect } from 'effect';
import { z } from 'zod';

import type { TurnContextBudget } from '../context-budget';
import type { WebSearchProvider, WebSearchResponse } from '../web/provider';
import { saveScreenshot } from '../web/screenshots';
import { bytesToBase64 } from '../utils/base64';
import { attemptInItsWords, KinuError, settle } from '../obs/index';
import { BUILTIN_TOOL_DESCRIPTIONS, WEB_TOOL_ACTIONS, type WebToolAction } from './registry';
import { oneOf } from './tool-schema';
import { clampToolResult } from './clamp';
import type { Storage } from '../types/primitives';
import { actionFieldRefusal } from './field-names';
import { imageCarrier, imageModelOutput, type ImageCarrier } from './image-results';
import { permitInPlan, requireBuild } from '../execution/work-mode';

/** Which fields each action reads; a field outside the called action's list is refused, naming the one meant. */
const WEB_ACTION_FIELDS = {
  search: ['query', 'limit'],
  fetch: ['url', 'render', 'engine'],
  screenshot: ['url', 'full_page', 'engine'],
} as const satisfies Record<WebToolAction, readonly string[]>;

/** Loose, so a field no action reads reaches the field check instead of being stripped unseen. */
export const WebToolInputSchema = z.looseObject({
  action: oneOf(WEB_TOOL_ACTIONS),
  query: z.string().describe('For search.').optional(),
  limit: z.number().describe('For search: max results (default 5, max 20).').optional(),
  url: z.string().describe('For fetch and screenshot: an absolute http(s) URL.').optional(),
  render: z.boolean().describe('For fetch: load the page in a browser first. Slower; for a page its scripts build.').optional(),
  full_page: z.boolean().describe('For screenshot: the whole page, saved to the workspace; you see only the path.').optional(),
  engine: oneOf(['kitesurf', 'chrome']).describe('For a rendered fetch or a screenshot: kitesurf (default), or chrome, which gets through some bot-checked and rate-limited sites.').optional(),
});

type WebToolInput = z.infer<typeof WebToolInputSchema>;

export interface WebToolDeps {
  readonly provider: WebSearchProvider;
  readonly files: Pick<Storage, 'vfs' | 'home'>;
  readonly budget: TurnContextBudget;
}

export function createWebTool(deps: WebToolDeps): ToolSet[string] {
  const { provider, files, budget } = deps;

  const needs = (action: WebToolAction, field: 'query' | 'url', value: string | undefined): Effect.Effect<string, KinuError> => (
    value ? Effect.succeed(value) : Effect.fail(new KinuError('bad_input', `web.${action} requires \`${field}\``))
  );

  const run = (args: WebToolInput): Effect.Effect<string | ImageCarrier, KinuError> => Effect.gen(function* () {
    const refusal = actionFieldRefusal({ fields: WEB_ACTION_FIELDS, action: args.action, sent: Object.keys(args) });

    if (refusal !== undefined) return yield* Effect.fail(new KinuError('bad_input', `web: ${refusal}`));

    switch (args.action) {
      case 'search': {
        const query = yield* needs('search', 'query', args.query);
        const found = yield* attemptInItsWords('unavailable', () => provider.search(query, args.limit === undefined ? undefined : { limit: args.limit }));

        return formatSearchResults(found);
      }

      case 'fetch': {
        const url = yield* needs('fetch', 'url', args.url);

        if (args.engine !== undefined && args.render !== true) {
          return yield* Effect.fail(new KinuError('bad_input', 'web.fetch: `engine` applies to a rendered fetch; add `render: true`'));
        }

        const page = yield* attemptInItsWords('unavailable', () => args.render === true ? provider.render(url, { engine: args.engine }) : provider.fetch(url));
        // The provenance header is inside the clamped text so a hostile title cannot buy room outside the cap.
        const header = `# ${page.title ?? page.url}\nSource: ${page.url}\nRetrieved: ${page.retrievedAt}\n\n`;

        return yield* attemptInItsWords('unavailable', () => clampToolResult(header + page.markdown, { files, budget, producer: 'web_fetch' }));
      }

      case 'screenshot': {
        const url = yield* needs('screenshot', 'url', args.url);
        yield* Effect.sync(() => { requireBuild('web.screenshot'); });
        const fullPage = args.full_page === true;
        const shot = yield* attemptInItsWords('unavailable', () => provider.screenshot(url, { fullPage, engine: args.engine }));
        const path = yield* attemptInItsWords('unavailable', () => saveScreenshot(files, shot));

        if (fullPage) return `Saved the whole page of ${shot.url} to ${path}.`;

        return imageCarrier(`Screenshot of ${shot.url}, saved to ${path}.`, [{ mediaType: 'image/png', data: bytesToBase64(shot.bytes) }]);
      }
    }
  });

  return permitInPlan(tool({
    description: BUILTIN_TOOL_DESCRIPTIONS.web,
    inputSchema: WebToolInputSchema,
    execute: (args) => settle(run(args)),
    toModelOutput: imageModelOutput,
  }));
}

function formatSearchResults(res: WebSearchResponse): string {
  if (res.results.length === 0) {
    return `No web results for "${res.query}".`;
  }

  const lines: string[] = [];

  if (res.answer) lines.push(`Answer: ${res.answer}`, '');

  for (const r of res.results) {
    const date = r.date ? ` (${r.date})` : '';
    lines.push(`${r.position}. ${r.title}${date}\n   ${r.url}\n   ${r.snippet}`);
  }

  lines.push('', `[${res.results.length} results via ${res.source}]`);

  return lines.join('\n');
}
