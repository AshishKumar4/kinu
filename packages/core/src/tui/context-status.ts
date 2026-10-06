import { parseModelSpec, specWithoutAccount } from '../providers/types';

export function modelDisplayName(spec: string | null | undefined): string {
  const raw = (spec ?? '').trim();

  if (!raw) return 'default';
  const listed = specWithoutAccount(raw);
  const leaf = listed.split('/').at(-1) ?? listed;

  const name = leaf
    .replace(/^gpt-/, 'GPT-')
    .replace(/^kimi-k2/i, 'Kimi K2')
    .replace(/-/g, ' ')
    .replace(/\b([a-z])/g, (m) => m.toUpperCase());

  return listed === raw ? name : `${name} · ${parseModelSpec(raw).account ?? ''}`;
}

/** An unknown window shows the tokens alone. */
export function formatContextUsage(usedTokens: number | null, contextWindow: number | null | undefined): string {
  const used = `ctx ${usedTokens === null ? '—' : `~${formatTokenCount(usedTokens)}`}`;

  return contextWindow === null || contextWindow === undefined ? used : `${used}/${formatTokenCount(contextWindow)}`;
}

function formatTokenCount(tokens: number): string {
  if (tokens >= 1_000_000) return `${trimFixed(tokens / 1_000_000)}M`;

  if (tokens >= 1_000) return `${trimFixed(tokens / 1_000)}k`;

  return String(tokens);
}

function trimFixed(value: number): string {
  return value >= 10 ? String(Math.round(value)) : value.toFixed(1).replace(/\.0$/, '');
}
