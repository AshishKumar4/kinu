import type { JsonValue } from '@kinu.run/core';

export const MEMORY_CASES: readonly { key: string; value: JsonValue }[] = [
  { key: 'owner.projects', value: ['do86', 'stratum', 'kinu'] },
  { key: 'work.projects', value: ['release review'] },
  { key: 'owner.options', value: { enabled: false, count: 0, nested: { labels: ['alpha', 'beta'], unset: null } } },
  { key: 'owner.empty_text', value: '' },
  { key: 'owner.empty_list', value: [] },
  { key: 'owner.empty_fields', value: {} },
  { key: 'owner.unset', value: null },
  { key: 'owner.flag', value: false },
  { key: 'owner.count', value: 0 },
  { key: 'owner.literal', value: 'false' },
  { key: 'owner.precise', value: 1.2345678901234567 },
  { key: 'owner.long_text', value: 'long-unbroken-value-'.repeat(30) },
  { key: 'owner.untrusted', value: '<img src=x onerror="window.__memoryInjected=true"> & literal text' },
];

export const MEMORY_PROPOSAL = { key: 'owner.follow_up', value: { projects: ['delta', 'epsilon'], approved: false } };

export const VARIABLE_USER_TEXT = 'Use $CLOUDFLARE_API_TOKEN and ${HOME}; keep $5 and $$ literal. `Do not parse my user text.` [label](https://example.com/$PATH)';

export const VARIABLE_ASSISTANT_TEXT = 'Set $CLOUDFLARE_API_TOKEN, then check **${HOME}**. Keep $5 and $$ literal.\n\n'
  + '[Read $LINK_LABEL](https://example.com/$LINK_PATH) and `$ALREADY_CODE`.\n\n'
  + '```sh\necho "$IN_FENCE"\n```\n\n'
  + '<script>window.__variableInjected=true</script>\n\n'
  + '<slate-ui name="variable-example">\n<div>$IN_SLATE</div>\n</slate-ui>';

export const SLATE_EDGE_HTML = `
<title>Release review</title>
<h2>Ready for review</h2>
<p>The controls below use the app’s native slate defaults.</p>
<svg viewBox="0 0 320 100" role="img" aria-label="Latency by hour, p50 and p95 in milliseconds" style="display:block;width:100%;height:auto">
  <path d="M34 10V72H310" fill="none" stroke="var(--c-border)"/>
  <text x="2" y="14" fill="var(--c-text-2)" font-size="10">ms</text>
  <text x="122" y="94" fill="var(--c-text-2)" font-size="10">Time (hours)</text>
  <path d="M36 53L90 42L145 48L200 34L254 42L308 29" fill="none" stroke="var(--c-accent)" stroke-width="2"/>
  <path d="M36 25L90 17L145 29L200 13L254 22L308 12" fill="none" stroke="var(--c-text-3)" stroke-width="2"/>
</svg>
<p style="color:var(--c-text-2)">Accent: p50 ms · Neutral: p95 ms</p>
<div style="display:flex;flex-wrap:wrap;justify-content:flex-end;gap:8px">
  <button id="secondary">Review details</button>
  <button id="disabled" disabled>Already queued</button>
  <button id="edge" data-variant="primary">Approve review</button>
</div>`;
