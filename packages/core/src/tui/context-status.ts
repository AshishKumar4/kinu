import { parseModelSpec, specWithoutAccount } from '../providers/types';
import { fmtTokens } from '../utils/format';

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
  const used = `ctx ${usedTokens === null ? '—' : `~${fmtTokens(usedTokens)}`}`;

  return contextWindow === null || contextWindow === undefined ? used : `${used}/${fmtTokens(contextWindow)}`;
}

