/**
 * Lexical recall for keyed facts, taken from oh-my-pi's mnemopi (MIT, Copyright (c) 2025-2026 Can Bölük, 2026
 * Stencil Labs, Inc.; THIRD_PARTY_NOTICES.md) at 317f2b8653:
 * - `STOP_WORDS` and `tokenize`, from `packages/mnemopi/src/core/beam/recall.ts`;
 * - `SYNONYM_GROUPS` and the canonical-word map, from `core/synonyms.ts`, with `recallSynonyms`' extra preference words;
 * - `matchesWordForm`, from `util/regex.ts`;
 * - `expandedTokenGroups` and `lexicalGroupRelevance` (identifier parts, word forms, CJK containment), from
 *   `core/beam/recall.ts`.
 * Each query word is a group of its synonyms; a document matches a group by any member, whole or as another form of
 * the word, and its relevance is the share of groups it matches.
 */

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'from', 'how', 'i', 'in', 'is', 'it', 'of', 'on', 'or',
  'that', 'the', 'this', 'to', 'was', 'what', 'when', 'where', 'who', 'with',
]);

const SYNONYM_GROUPS = {
  database: ['db', 'datastore', 'data_store'],
  password: ['pass', 'pwd', 'passwd', 'credential', 'secret', 'token'],
  config: ['configuration', 'settings', 'cfg', 'setup'],
  error: ['bug', 'issue', 'fault', 'failure', 'crash', 'exception', 'traceback'],
  fix: ['repair', 'resolve', 'solve', 'patch', 'correct', 'address'],
  deploy: ['deployment', 'release', 'ship', 'push', 'rollout'],
  server: ['host', 'machine', 'vm', 'instance', 'node', 'vps'],
  api: ['endpoint', 'interface', 'service'],
  key: ['token', 'credential', 'secret', 'api_key'],
  user: ['account', 'profile', 'identity', 'person'],
  model: ['llm', 'ai', 'provider', 'gpt', 'claude', 'gemini'],
  speed: ['fast', 'quick', 'performance', 'latency', 'throughput'],
  memory: ['recall', 'remember', 'storage', 'retention'],
  search: ['find', 'lookup', 'query', 'retrieve', 'locate'],
  file: ['document', 'doc', 'text', 'note'],
  code: ['script', 'program', 'source', 'implementation'],
  test: ['verify', 'check', 'validate', 'probe', 'examine'],
  backup: ['snapshot', 'copy', 'save', 'archive'],
  install: ['setup', 'configure', 'bootstrap', 'init'],
  update: ['upgrade', 'refresh', 'renew', 'sync'],
  delete: ['remove', 'destroy', 'purge', 'clean', 'wipe', 'erase'],
  list: ['show', 'display', 'enumerate', 'catalog'],
  time: ['date', 'when', 'timestamp', 'schedule'],
  url: ['link', 'address', 'uri', 'path'],
  health: ['status', 'check', 'pulse', 'alive', 'up'],
  service: ['daemon', 'process', 'systemd', 'worker'],
  port: ['socket', 'bind', 'listen'],
  network: ['internet', 'connection', 'connectivity', 'dns'],
  ssh: ['terminal', 'shell', 'remote', 'connect'],
  git: ['commit', 'push', 'pull', 'repo', 'repository', 'branch'],
  log: ['output', 'stdout', 'stderr', 'trace', 'debug'],
  cron: ['schedule', 'job', 'task', 'timer', 'periodic'],
  email: ['mail', 'message', 'inbox', 'smtp'],
  image: ['picture', 'photo', 'screenshot', 'graphic'],
  browser: ['web', 'page', 'site', 'navigate', 'chrome'],
  monitor: ['watch', 'observe', 'track', 'survey'],
  alert: ['notify', 'notification', 'warning', 'ping'],
  migrate: ['transfer', 'move', 'relocate', 'port'],
  compare: ['diff', 'versus', 'vs', 'contrast'],
  save: ['store', 'persist', 'preserve', 'keep'],
} as const satisfies Readonly<Record<string, readonly string[]>>;

const GROUPS: ReadonlyMap<string, readonly string[]> = new Map(Object.entries(SYNONYM_GROUPS));

const CANONICAL = new Map<string, string>([...GROUPS].flatMap(([canonical, group]) => [
  [canonical, canonical] as const, ...group.map((word) => [word, canonical] as const),
]));

const CJK = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/u;

function hasCjk(text: string): boolean {
  return CJK.test(text);
}

/** Lower-cased letter, digit and underscore runs, stop words dropped. */
function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).filter((token) => !STOP_WORDS.has(token));
}

function synonymsOf(token: string): readonly string[] {
  const canonical = CANONICAL.get(token);
  const group = canonical === undefined ? [token] : [canonical, ...GROUPS.get(canonical) ?? []];

  return token === 'preference' || token === 'prefer' || token === 'preferred' ? [...group, 'wants', 'want', 'prefers'] : group;
}

/** One group per query word: the word, its synonyms, and their tokens. */
export function expandedTokenGroups(query: string): string[][] {
  return tokenize(query).flatMap((token) => {
    const group = new Set(synonymsOf(token).flatMap((variant) => tokenize(variant)));

    return group.size === 0 ? [] : [[...group]];
  });
}

/** Endings that turn one form of a word into another: `backup`/`backups`, `deploy`/`deployment`. */
const WORD_FORM_ENDINGS = ['s', 'es', 'd', 'ed', 'ing', 'er', 'ers', 'ment', 'ments'];

/** Endings that replace a final `e`: `cache`/`caching`, `create`/`creation`. */
const SILENT_E_ENDINGS = ['ing', 'ion', 'ions'];

/** Endings that replace a final `y`: `story`/`stories`, `copy`/`copied`. */
const FINAL_Y_ENDINGS = ['ies', 'ied'];

/**
 * Two forms of one word: the longer is the shorter plus an inflectional or common derivational ending. The shorter
 * needs four characters, so `pass` never finds `password` or `passport`. Deliberately not a stemmer.
 */
function matchesWordForm(left: string, right: string): boolean {
  const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];

  if (shorter.length < 4 || longer.length === shorter.length) return false;

  if (longer.startsWith(shorter) && WORD_FORM_ENDINGS.includes(longer.slice(shorter.length))) return true;
  const stem = shorter.slice(0, -1);

  if (!longer.startsWith(stem)) return false;
  const ending = longer.slice(stem.length);

  if (shorter.endsWith('e')) return SILENT_E_ENDINGS.includes(ending);

  return shorter.endsWith('y') && FINAL_Y_ENDINGS.includes(ending);
}

const clamp01 = (value: number): number => Math.min(1, Math.max(0, value));

/**
 * The share of query groups `content` matches, a word form counting half. A one-word query scores 0.7 and up with
 * repetition (0.35 for a word form only). A document identifier's parts count (`deploy_target` holds `deploy`); a query
 * synonym such as `data_store` stays whole.
 */
export function lexicalGroupRelevance(groups: readonly (readonly string[])[], content: string): number {
  if (groups.length === 0) return 0;
  const tokens = tokenize(content);
  const contentTokens = new Set(tokens);

  for (const token of tokens) {
    if (token.includes('_')) for (const part of token.split('_')) if (part.length > 0) contentTokens.add(part);
  }

  const cjk = groups.some((group) => group.some(hasCjk)) ? content.toLowerCase() : null;
  let matched = 0;
  let partial = 0;

  for (const group of groups) {
    if (group.some((token) => contentTokens.has(token) || (hasCjk(token) && cjk?.includes(token) === true))) matched += 1;
    else if (group.some((token) => [...contentTokens].some((word) => matchesWordForm(token, word)))) partial += 1;
  }

  if (groups.length !== 1) return (matched + partial * 0.5) / groups.length;

  if (matched === 0) return partial > 0 ? 0.35 : 0;
  const token = groups[0]?.[0] ?? '';
  const count = token !== '' && hasCjk(token) && cjk !== null ? cjk.split(token).length - 1 : tokens.filter((word) => word === token).length;

  return clamp01(0.7 + Math.min(Math.max(count - 1, 0), 3) * 0.1);
}

/** mnemopi's floor below which a match is noise, by query length (`minimumRelevance`). */
export function minimumRelevance(groups: number): number {
  if (groups <= 1) return 0.08;

  if (groups === 2) return 0.18;

  return groups === 3 ? 0.34 : 0.22;
}
